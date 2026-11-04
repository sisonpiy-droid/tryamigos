import { prisma } from "@/lib/db";
import { decide, type DeviceFacts } from "./decide";
import { push } from "./push";
import type { Frequency, TriggerType } from "./timing";

/* One pass of the scheduler: every pending trigger whose time has come.
 *
 * Runs on the server from a cron, with no browser anywhere -- that is the
 * point. Each trigger goes through decide(); a send is claimed with a
 * conditional update first (PENDING -> SENT), so two overlapping runs can
 * never send the same thing twice, and the outreach is recorded before the
 * push goes out, so the app can collect it even if the push fails.
 */

const HOUR = 3600_000;

export interface RunSummary {
  due: number;
  sent: number;
  pushed: number;
  deferred: number;
  held: number;
  expired: number;
  skipped: number;
}

export async function runOutreach(now = Date.now()): Promise<RunSummary> {
  const summary: RunSummary = { due: 0, sent: 0, pushed: 0, deferred: 0, held: 0, expired: 0, skipped: 0 };
  const due = await prisma.proactiveTrigger.findMany({
    where: { status: "PENDING", scheduledFor: { lte: new Date(now) } },
    orderBy: { scheduledFor: "asc" },
    take: 100,
    include: { device: true, interaction: { select: { id: true } } },
  });
  summary.due = due.length;

  /* What each device has already been sent, so limits and gaps hold across
     every trigger in this pass, not just against earlier passes. */
  const sentByDevice = new Map<string, Date[]>();
  for (const id of new Set(due.map((t) => t.deviceId))) {
    const rows = await prisma.proactiveInteraction.findMany({
      where: { deviceId: id, sentAt: { gte: new Date(now - 4 * 24 * HOUR) } },
      select: { sentAt: true },
    });
    sentByDevice.set(id, rows.map((r) => r.sentAt));
  }

  for (const t of due) {
    const d = t.device;
    const facts: DeviceFacts = {
      timezone: d.timezone,
      proactiveEnabled: d.proactiveEnabled,
      initiationFrequency: d.initiationFrequency as Frequency,
      quietHoursStart: d.quietHoursStart,
      quietHoursEnd: d.quietHoursEnd,
      maxDailyProactive: d.maxDailyProactive,
      allowedMuseIds: d.allowedMuseIds,
    };
    const sent = sentByDevice.get(d.id) ?? [];
    const verdict = decide(
      { id: t.id, type: t.type as TriggerType, museId: t.museId, status: t.status, scheduledFor: t.scheduledFor, expiresAt: t.expiresAt, eventAt: t.eventAt },
      facts,
      { sent, alreadySent: Boolean(t.interaction) },
      now
    );
    const evaluated = new Date(now);

    if (verdict.action === "send") {
      const claimed = await prisma.proactiveTrigger.updateMany({
        where: { id: t.id, status: "PENDING" },
        data: { status: "SENT", statusReason: null, lastEvaluatedAt: evaluated },
      });
      if (!claimed.count) continue;
      const interaction = await prisma.proactiveInteraction.create({
        data: { deviceId: d.id, museId: t.museId, triggerId: t.id, message: t.message, sentAt: evaluated },
      });
      sent.push(evaluated);
      sentByDevice.set(d.id, sent);
      summary.sent++;

      if (d.pushEndpoint && d.pushP256dh && d.pushAuth) {
        /* The first line of a burst is what a lock screen has room for. */
        const body = t.message.split(/\n?\s*-{3,}\s*\n?/)[0].trim().slice(0, 180);
        const result = await push(
          { endpoint: d.pushEndpoint, p256dh: d.pushP256dh, auth: d.pushAuth },
          {
            title: t.museName,
            body,
            url: `/solo?muse=${encodeURIComponent(t.museId)}&outreach=${encodeURIComponent(interaction.id)}`,
            tag: t.id,
            interactionId: interaction.id,
          }
        );
        if (result === "sent") {
          summary.pushed++;
          await prisma.proactiveInteraction.update({ where: { id: interaction.id }, data: { pushed: true } });
        } else if (result === "gone") {
          await prisma.outreachDevice.update({ where: { id: d.id }, data: { pushEndpoint: null, pushP256dh: null, pushAuth: null } });
        }
      }
      continue;
    }

    if (verdict.action === "defer") {
      summary.deferred++;
      await prisma.proactiveTrigger.update({
        where: { id: t.id },
        data: { scheduledFor: new Date(verdict.until), statusReason: verdict.reason, lastEvaluatedAt: evaluated },
      });
    } else if (verdict.action === "hold") {
      summary.held++;
      /* Look again in an hour rather than every pass. */
      await prisma.proactiveTrigger.update({
        where: { id: t.id },
        data: { scheduledFor: new Date(now + HOUR), statusReason: verdict.reason, lastEvaluatedAt: evaluated },
      });
    } else {
      if (verdict.action === "expire") summary.expired++;
      else summary.skipped++;
      await prisma.proactiveTrigger.updateMany({
        where: { id: t.id, status: "PENDING" },
        data: { status: verdict.action === "expire" ? "EXPIRED" : "SKIPPED", statusReason: verdict.reason, lastEvaluatedAt: evaluated },
      });
    }
  }
  return summary;
}
