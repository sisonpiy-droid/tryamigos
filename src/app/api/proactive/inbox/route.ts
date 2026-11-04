import { z } from "zod";

import { prisma } from "@/lib/db";
import { deviceId, findDevice } from "@/lib/proactive/device";

/* Outreach waiting to be put into its conversation, and what happened to it.
 *
 * The server cannot write into a conversation that lives in the browser, so a
 * sent message waits here until the app next runs and collects it -- whether
 * the user tapped a notification, or never got one and simply opened MUSE. It
 * then becomes an ordinary message from that Muse in the existing thread.
 *
 * POST records the rest of its life: collected, opened (from the
 * notification), responded (they replied), dismissed. */

export const runtime = "nodejs";

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("device");
  const device = await findDevice(id);
  if (!device) return Response.json({ items: [] });
  await prisma.outreachDevice.update({ where: { id: device.id }, data: { lastSeenAt: new Date() } }).catch(() => {});
  const items = await prisma.proactiveInteraction.findMany({
    where: { deviceId: device.id, collectedAt: null, status: { not: "FAILED" } },
    orderBy: { sentAt: "asc" },
    take: 20,
    include: { trigger: { select: { museName: true, type: true } } },
  });
  return Response.json({
    items: items.map((i) => ({
      id: i.id, triggerId: i.triggerId, museId: i.museId, museName: i.trigger.museName, type: i.trigger.type,
      message: i.message, sentAt: i.sentAt.toISOString(),
    })),
  });
}

const ackSchema = z.object({
  deviceId,
  interactionId: z.string().max(40),
  event: z.enum(["collected", "opened", "responded", "dismissed"]),
});

export async function POST(req: Request) {
  let raw: unknown;
  try { raw = await req.json(); } catch { return Response.json({ error: "Invalid request." }, { status: 400 }); }
  const parsed = ackSchema.safeParse(raw);
  if (!parsed.success) return Response.json({ error: "Invalid request." }, { status: 400 });
  const device = await findDevice(parsed.data.deviceId);
  if (!device) return Response.json({ error: "Unknown device." }, { status: 404 });
  const { interactionId, event } = parsed.data;
  const now = new Date();
  const data =
    event === "collected" ? { collectedAt: now }
      : event === "opened" ? { openedAt: now, collectedAt: now }
      : event === "responded" ? { respondedAt: now, status: "RESPONDED" as const }
      : { status: "DISMISSED" as const };
  /* Opened never overwrites responded. */
  const where = { id: interactionId, deviceId: device.id };
  if (event === "opened") {
    await prisma.proactiveInteraction.updateMany({ where: { ...where, status: "SENT" }, data: { status: "OPENED" } });
  }
  const { count } = await prisma.proactiveInteraction.updateMany({ where, data });
  return Response.json({ ok: count > 0 });
}
