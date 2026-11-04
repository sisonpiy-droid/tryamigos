import { formatter } from "@/lib/presence/time";
import type { SoloMemory, SoloState } from "./store";

/* The story of a relationship in here, from what is already kept.
 *
 * Nothing new is recorded to make this: every number comes from the thread,
 * the call records and the memories. Pure, and given `now` and a timezone, so
 * it is the same on every render and testable without a clock.
 */

export interface Milestone {
  at: string;
  label: string;
}

export interface Story {
  since: string | null;
  daysTalked: number;
  /** Talked today or yesterday, and every day before that back this many days. */
  streak: number;
  messages: number;
  yours: number;
  calls: number;
  callMinutes: number;
  photos: number;
  textedFirst: number;
  lastTalked: string | null;
  /** Of the last 14 days, how many had a conversation. */
  recentDays: number;
  milestones: Milestone[];
  moments: SoloMemory[];
}

const dayOf = (iso: string, tz?: string) =>
  formatter("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));

export function storyOf(state: SoloState, museId: string, now: number, tz?: string): Story {
  const log = (state.conversations[museId] ?? []).filter((m) => !m.showAt || Date.parse(m.showAt) <= now);
  const calls = (state.calls ?? []).filter((c) => c.museId === museId && c.status === "COMPLETED");
  const days = [...new Set(log.map((m) => dayOf(m.at, tz)))].sort();

  /* Consecutive days back from today -- or from yesterday, so a streak is not
     broken just because today has not started yet. */
  const daySet = new Set(days);
  const back = (n: number) => dayOf(new Date(now - n * 864e5).toISOString(), tz);
  const start = daySet.has(back(0)) ? 0 : daySet.has(back(1)) ? 1 : -1;
  let streak = 0;
  if (start >= 0) while (daySet.has(back(start + streak))) streak++;
  const recentDays = Array.from({ length: 14 }, (_, i) => back(i)).filter((d) => daySet.has(d)).length;

  const first = <T,>(xs: T[], pick: (x: T) => string | undefined) => xs.map(pick).filter(Boolean).sort()[0] as string | undefined;
  const firstCall = first(calls, (c) => c.startedAt);
  const firstPhoto = first(log.filter((m) => m.image), (m) => m.at);
  const firstText = first(log.filter((m) => m.proactive), (m) => m.at);
  const firstReact = first(log.filter((m) => m.reactions?.muse), (m) => m.at);

  const milestones: Milestone[] = [
    log[0] && { at: log[0].at, label: "First message" },
    firstCall && { at: firstCall, label: "First call" },
    firstPhoto && { at: firstPhoto, label: "First photo you sent" },
    firstText && { at: firstText, label: "First time they texted you first" },
    firstReact && { at: firstReact, label: "First time they reacted to you" },
  ].filter((x): x is Milestone => Boolean(x)).sort((a, b) => a.at.localeCompare(b.at));

  /* The moments: what happened, as they remember it, newest first. */
  const moments = state.memories
    .filter((m) => m.museId === museId && m.type === "EVENT")
    .sort((a, b) => (b.at ?? b.createdAt).localeCompare(a.at ?? a.createdAt))
    .slice(0, 12);

  return {
    since: log[0]?.at ?? null,
    daysTalked: days.length,
    streak,
    messages: log.length,
    yours: log.filter((m) => m.from === "user").length,
    calls: calls.length,
    callMinutes: Math.round(calls.reduce((n, c) => n + c.durationSeconds, 0) / 60),
    photos: log.filter((m) => m.image).length,
    textedFirst: log.filter((m) => m.proactive).length,
    lastTalked: log.at(-1)?.at ?? null,
    recentDays,
    milestones,
    moments,
  };
}

/* The same history as one line for the model: background, so what they say
   fits how often you actually talk ("you're here every day this week"). It is
   about this app, not about how long they have known each other in their own
   story, and says so. */
export function storyLine(s: Story, now: number): string | null {
  if (!s.since || s.daysTalked < 2) return null;
  const weeks = Math.floor((now - Date.parse(s.since)) / (7 * 864e5));
  const span = weeks >= 8 ? `${Math.floor(weeks / 4)} months` : weeks >= 1 ? `${weeks} week${weeks === 1 ? "" : "s"}` : "a few days";
  const parts = [
    `you have been talking here for ${span}`,
    `on ${s.recentDays} of the last 14 days`,
    s.streak >= 2 ? `${s.streak} days in a row now` : "",
    s.calls ? `${s.calls} call${s.calls === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  return parts.join(", ");
}
