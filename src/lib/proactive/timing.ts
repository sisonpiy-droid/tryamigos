import { offsetOf } from "@/lib/presence/time";

/* When a Muse should text first, in the user's own time.
 *
 * Everything here works in the user's timezone, never the server's: a
 * "the evening before" computed in UTC is 00:30 in Mumbai. All of it is pure
 * and takes `now`, so every rule can be tested without a clock or a database.
 *
 * Times are never round. A friend texts at 7:12, not at 19:00:00 -- so each
 * time carries a small offset derived from the trigger's own id: stable across
 * runs (a deferred trigger does not drift), different between triggers.
 */

export type TriggerType = "UPCOMING_EVENT" | "REMINDER" | "FOLLOW_UP" | "GOAL_CHECK_IN";
export type Frequency = "NEVER" | "RARELY" | "SOMETIMES" | "OFTEN";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export function validZone(tz: string | null | undefined): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz }).format(0);
    return true;
  } catch {
    return false;
  }
}

/** Calendar parts of `ts` in `tz`. */
export function localParts(ts: number, tz: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date(ts));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const y = get("year"), m = get("month"), d = get("day"), h = get("hour") % 24, min = get("minute");
  return { y, m, d, h, min, minutes: h * 60 + min, day: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` };
}

/** The instant of a wall-clock time in `tz`. Day overflow (d = 32) rolls over. */
export function atLocal(y: number, m: number, d: number, minutes: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60);
  const off = offsetOf(tz, guess);
  const sign = off.startsWith("-") ? -1 : 1;
  const [oh, om] = off.slice(1).split(":").map(Number);
  return guess - sign * (oh * 60 + om) * MIN;
}

/** `days` after the local date of `ts`, at `minutes` past local midnight. */
export function localDayAt(ts: number, days: number, minutes: number, tz: string): number {
  const p = localParts(ts, tz);
  return atLocal(p.y, p.m, p.d + days, minutes, tz);
}

/** 0..span-1, stable for a given id. */
export function stableJitter(id: string, span: number): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return Math.abs(h) % span;
}

/* ------------------------------------------------------------ quiet hours */

export function isQuiet(ts: number, tz: string, start: number, end: number): boolean {
  if (start === end) return false;
  const m = localParts(ts, tz).minutes;
  return start < end ? m >= start && m < end : m >= start || m < end;
}

/** The first moment at or after `ts` outside quiet hours, a few minutes in. */
export function nextAllowed(ts: number, tz: string, start: number, end: number, id = ""): number {
  if (!isQuiet(ts, tz, start, end)) return ts;
  const p = localParts(ts, tz);
  /* Quiet hours that run past midnight end tomorrow if we are before midnight. */
  const endsTomorrow = start > end && p.minutes >= start;
  return localDayAt(ts, endsTomorrow ? 1 : 0, end, tz) + (10 + stableJitter(id + "q", 40)) * MIN;
}

/* --------------------------------------------------------------- planning */

export interface Planned {
  scheduledFor: number;
  expiresAt: number;
}

/* When to reach out for each kind of reason.
 *
 *   UPCOMING_EVENT  the evening before (about 7pm) if it is more than ~20h
 *                   away, otherwise a couple of hours before. Too close to be
 *                   useful: nothing.
 *   REMINDER        when they asked; a date with no time means mid-morning.
 *   FOLLOW_UP       a few hours after the thing, if that is a sociable hour,
 *                   else the next evening.
 *   GOAL_CHECK_IN   a couple of days later, early evening.
 *
 * Returns null when there is no sensible time. */
export function planTime(opts: {
  type: TriggerType;
  id: string;
  now: number;
  tz: string;
  /** When the event is. */
  eventAt?: number | null;
  /** For a reminder: when they asked to be reminded. */
  remindAt?: number | null;
  /** True when remindAt was a date with no time of day. */
  remindDateOnly?: boolean;
  createdAt?: number;
}): Planned | null {
  const { type, id, now, tz } = opts;
  const jitter = (span = 25) => stableJitter(id, span) * MIN;
  const created = opts.createdAt ?? now;
  const soon = now + 15 * MIN;

  if (type === "UPCOMING_EVENT") {
    const at = opts.eventAt;
    if (!at || !Number.isFinite(at) || at <= now) return null;
    if (at - now > 20 * HOUR) {
      const eveningBefore = localDayAt(at, -1, 19 * 60, tz) + jitter();
      if (eveningBefore > soon) return { scheduledFor: eveningBefore, expiresAt: at - 30 * MIN };
    }
    const before = at - 2.5 * HOUR + jitter(20);
    if (before > soon) return { scheduledFor: before, expiresAt: at - 30 * MIN };
    return null;
  }

  if (type === "REMINDER") {
    let at = opts.remindAt;
    if (!at || !Number.isFinite(at)) return null;
    if (opts.remindDateOnly) at = localDayAt(at, 0, 9 * 60 + 30, tz) + jitter(15);
    if (at <= now) return null;
    return { scheduledFor: at, expiresAt: at + 6 * HOUR };
  }

  if (type === "FOLLOW_UP") {
    const base = opts.eventAt && Number.isFinite(opts.eventAt) ? opts.eventAt : created;
    let at = base + 3 * HOUR + jitter(30);
    const h = localParts(at, tz).h;
    if (!opts.eventAt || h < 10 || h >= 21) at = localDayAt(base, 1, 18 * 60, tz) + jitter(40);
    if (at <= now) at = Math.max(soon, localDayAt(now, 0, 18 * 60, tz) + jitter(40));
    if (at <= now) at = localDayAt(now, 1, 18 * 60, tz) + jitter(40);
    return { scheduledFor: at, expiresAt: at + 2 * DAY };
  }

  /* GOAL_CHECK_IN */
  let at = localDayAt(created, 2, 18 * 60 + 30, tz) + jitter(45);
  if (at <= now) at = localDayAt(now, 1, 18 * 60 + 30, tz) + jitter(45);
  return { scheduledFor: at, expiresAt: at + 3 * DAY };
}

/* ------------------------------------------------------------- frequency */

/* What "how often" means. Relevance first, then this: it decides how far
   apart texts must be, and whether the lower-stakes reasons are used at all.
   An explicit reminder is the user asking, so it ignores the gap. */
export const FREQUENCY: Record<Frequency, { cooldownHours: number; types: TriggerType[]; goalChance: number }> = {
  NEVER: { cooldownHours: Infinity, types: [], goalChance: 0 },
  RARELY: { cooldownHours: 72, types: ["UPCOMING_EVENT", "REMINDER"], goalChance: 0 },
  SOMETIMES: { cooldownHours: 30, types: ["UPCOMING_EVENT", "REMINDER", "FOLLOW_UP", "GOAL_CHECK_IN"], goalChance: 0.5 },
  OFTEN: { cooldownHours: 12, types: ["UPCOMING_EVENT", "REMINDER", "FOLLOW_UP", "GOAL_CHECK_IN"], goalChance: 1 },
};
