import { formatter } from "@/lib/presence/time";

import type { SoloMessage } from "./store";

/* How a thread is laid out: where the day dividers go, which bubbles belong to
 * one burst, and the time under the last of each. Pure, and given the timezone,
 * so the same thread reads the same on every render and is testable without a
 * screen. */

const MIN = 60_000;
const DAY = 86_400_000;

/** Bubbles from one sender closer together than this are one burst. */
export const RUN_GAP_MS = 5 * MIN;

const localeOf = () => (typeof navigator !== "undefined" && navigator.language) || "en-GB";

/** The calendar day of a moment where the user is, as a day number. */
function dayNumber(ts: number, tz?: string): number {
  const [y, m, d] = formatter("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ts)).split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY);
}

/** "Today", "Yesterday", "Tuesday" within the week, then "12 September" (with the year once it is not this one). */
export function dayLabel(iso: string, now: number, tz?: string, locale = localeOf()): string {
  const ts = Date.parse(iso);
  const diff = dayNumber(now, tz) - dayNumber(ts, tz);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff > 1 && diff < 7) return formatter(locale, { timeZone: tz, weekday: "long" }).format(new Date(ts));
  return formatter(locale, { timeZone: tz, day: "numeric", month: "long", ...(Math.abs(diff) > 300 ? { year: "numeric" } : {}) }).format(new Date(ts));
}

/** "2:05 pm" or "14:05", the way their device writes it. */
export function clockTime(iso: string, tz?: string, locale = localeOf()): string {
  return formatter(locale, { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(Date.parse(iso)));
}

/** Where message `i` sits in its burst and its day. */
export function runOf(list: SoloMessage[], i: number, tz?: string): { newDay: boolean; first: boolean; last: boolean } {
  const m = list[i];
  const prev = list[i - 1];
  const next = list[i + 1];
  const day = (x: SoloMessage) => dayNumber(Date.parse(x.at), tz);
  const together = (a: SoloMessage, b: SoloMessage) =>
    a.from === b.from && a.speakerId === b.speakerId && Math.abs(Date.parse(b.at) - Date.parse(a.at)) < RUN_GAP_MS && day(a) === day(b);
  return {
    newDay: !prev || day(prev) !== day(m),
    first: !prev || !together(prev, m),
    last: !next || !together(m, next),
  };
}
