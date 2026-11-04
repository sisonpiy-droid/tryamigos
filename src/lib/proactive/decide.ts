import { FREQUENCY, isQuiet, localDayAt, localParts, nextAllowed, stableJitter, validZone, type Frequency, type TriggerType } from "./timing";

/* Whether a due trigger is sent now, later, or never.
 *
 * Run by the scheduler for every trigger whose time has come. Pure: it is given
 * the trigger, the device's settings, what has already gone out, and the time,
 * and it returns a verdict -- so every rule below is tested directly rather
 * than by waiting for a cron.
 *
 * Every check has to pass. The bias is towards not sending: a message that
 * should have gone and did not is a small loss; one that should not have gone
 * is the reason people turn this off.
 */

export interface TriggerFacts {
  id: string;
  type: TriggerType;
  museId: string;
  status: string;
  scheduledFor: Date | string;
  expiresAt: Date | string;
  eventAt?: Date | string | null;
}

export interface DeviceFacts {
  timezone: string | null | undefined;
  proactiveEnabled: boolean;
  initiationFrequency: Frequency;
  quietHoursStart: number;
  quietHoursEnd: number;
  maxDailyProactive: number;
  allowedMuseIds: string[];
}

export interface History {
  /** sentAt of everything already sent to this device, any Muse. */
  sent: (Date | string)[];
  /** This trigger already produced an outreach. */
  alreadySent: boolean;
}

export type Verdict =
  | { action: "send" }
  /** Not now; try again at `until`. The trigger stays pending. */
  | { action: "defer"; until: number; reason: string }
  /** Leave it pending without moving it -- the user may switch outreach back on. */
  | { action: "hold"; reason: string }
  | { action: "expire"; reason: string }
  | { action: "skip"; reason: string };

const ms = (d: Date | string | null | undefined) => (d == null ? NaN : new Date(d).getTime());

export function decide(t: TriggerFacts, device: DeviceFacts, history: History, now: number): Verdict {
  if (t.status !== "PENDING") return { action: "skip", reason: `already ${t.status.toLowerCase()}` };
  if (history.alreadySent) return { action: "skip", reason: "already sent" };

  const scheduled = ms(t.scheduledFor);
  const expires = ms(t.expiresAt);
  if (!Number.isFinite(scheduled) || !Number.isFinite(expires)) return { action: "expire", reason: "invalid date" };
  if (now >= expires) return { action: "expire", reason: "past its moment" };
  const eventAt = ms(t.eventAt);
  if (t.type === "UPCOMING_EVENT" && Number.isFinite(eventAt) && now >= eventAt) return { action: "expire", reason: "event already happened" };

  /* Without a real timezone there is no telling 3pm from 3am. Wait for the
     app to report one rather than guess. */
  const tz = device.timezone;
  if (!validZone(tz)) return { action: "hold", reason: "no timezone" };

  if (!device.proactiveEnabled) return { action: "hold", reason: "outreach is off" };
  if (!device.allowedMuseIds.includes(t.museId)) return { action: "hold", reason: "this Muse may not text first" };

  const freq = FREQUENCY[device.initiationFrequency] ?? FREQUENCY.RARELY;
  if (!freq.types.includes(t.type)) return { action: "skip", reason: `not at "${device.initiationFrequency.toLowerCase()}"` };
  /* "Sometimes" means sometimes: a goal check-in goes out on some goals and not
     others, decided once per trigger so a deferral does not re-roll it. */
  if (t.type === "GOAL_CHECK_IN" && stableJitter(t.id + "goal", 100) >= freq.goalChance * 100) {
    return { action: "skip", reason: "not this time" };
  }

  const later = (until: number, reason: string): Verdict =>
    until >= expires ? { action: "expire", reason: `${reason}, and it would be too late after` } : { action: "defer", until, reason };

  if (isQuiet(now, tz, device.quietHoursStart, device.quietHoursEnd)) {
    return later(nextAllowed(now, tz, device.quietHoursStart, device.quietHoursEnd, t.id), "quiet hours");
  }

  const sent = history.sent.map(ms).filter(Number.isFinite).sort((a, b) => a - b);
  const today = localParts(now, tz).day;
  const sentToday = sent.filter((s) => localParts(s, tz).day === today).length;
  if (sentToday >= Math.max(0, device.maxDailyProactive)) {
    const tomorrow = nextAllowed(localDayAt(now, 1, device.quietHoursEnd, tz), tz, device.quietHoursStart, device.quietHoursEnd, t.id)
      + (15 + stableJitter(t.id + "d", 60)) * 60_000;
    return later(tomorrow, "daily limit reached");
  }

  const last = sent.at(-1);
  /* Something happening tomorrow is the "genuinely important separate
     trigger" that may follow another text sooner -- but still not within a few
     hours of it. */
  const gap = (t.type === "UPCOMING_EVENT" ? Math.min(freq.cooldownHours, 8) : freq.cooldownHours) * 3600_000;
  if (t.type !== "REMINDER" && last !== undefined && now - last < gap) {
    const until = nextAllowed(last + gap, tz, device.quietHoursStart, device.quietHoursEnd, t.id);
    return later(until, "too soon after the last one");
  }

  return { action: "send" };
}
