/* Real time, for a conversation that happens across days.
 *
 * A character was told what time it is now, and nothing else. The messages
 * reached the model without timestamps, so a conversation that stopped at
 * 11pm with "see you tomorrow at 11" and resumed at noon the next day looked,
 * to the model, like one unbroken exchange -- it was still tomorrow, the
 * meeting was still ahead. And a plan was remembered as the sentence "User is
 * meeting Rhea tomorrow at 11", which stays "tomorrow" forever.
 *
 * So time is carried as data:
 *   - every message keeps its timestamp, and the model sees one wherever the
 *     conversation paused, in the user's own timezone;
 *   - the prompt says how long it has been since the conversation last moved;
 *   - a plan is stored with the absolute moment it is for, and every turn says
 *     whether that moment is still ahead or has passed.
 *
 * Passing is not happening. A meeting whose time has gone by is described as
 * "time has passed, and you do not know whether it happened" -- never as a
 * thing that took place.
 */

/* "in 20 mins", "an hour", "a couple of minutes", "9:30", "at 7 baje": a time or a length
   of time, said in a message. */
export const DURATION = /\b(\d+\s*(?:min|mins|minutes?|hrs?|hours?|ghant[ae]|seconds?)|an hour|half an hour|few minutes|couple of minutes|\d{1,2}[:.]\d{2}|\d{1,2}\s?(?:am|pm|baje))\b/i;

/** A pause long enough to mark in the transcript. */
export const GAP_MS = 30 * 60_000;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/* Making a formatter costs ~60x more than using one, and the screen formats a
   date per message per render: kept and reused. Throws as the constructor does
   (an unknown timezone). */
const formatters = new Map<string, Intl.DateTimeFormat>();
export function formatter(locale: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = locale + JSON.stringify(opts);
  let f = formatters.get(key);
  if (!f) formatters.set(key, (f = new Intl.DateTimeFormat(locale, opts)));
  return f;
}

function fmt(ts: number, timeZone: string | undefined, opts: Intl.DateTimeFormatOptions): string {
  try {
    return formatter("en-GB", { ...opts, ...(timeZone ? { timeZone } : {}) }).format(new Date(ts));
  } catch {
    return formatter("en-GB", opts).format(new Date(ts));
  }
}

/** "Thursday 2 October, 11:00" in the user's timezone. */
export function wallClock(ts: number, timeZone?: string): string {
  const day = fmt(ts, timeZone, { weekday: "long", day: "numeric", month: "long" });
  const time = fmt(ts, timeZone, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return `${day}, ${time}`;
}

/** "42 minutes", "3 hours", "2 days". */
export function span(ms: number): string {
  const a = Math.abs(ms);
  if (a < 2 * MIN) return "a minute";
  if (a < HOUR) return `${Math.round(a / MIN)} minutes`;
  if (a < 2 * HOUR) {
    const m = Math.round((a - HOUR) / MIN);
    return m ? `an hour and ${m} minutes` : "an hour";
  }
  if (a < DAY) return `${Math.round(a / HOUR)} hours`;
  if (a < 2 * DAY) return "a day";
  return `${Math.round(a / DAY)} days`;
}

/** The calendar day of `ts` in `timeZone`, as a sortable string. */
function dayKey(ts: number, timeZone?: string): string {
  return fmt(ts, timeZone, { year: "numeric", month: "2-digit", day: "2-digit" });
}

function dayWord(ts: number, now: number, timeZone?: string): string {
  const d = dayKey(ts, timeZone);
  if (d === dayKey(now, timeZone)) return "today";
  if (d === dayKey(now - DAY, timeZone)) return "yesterday";
  if (d === dayKey(now + DAY, timeZone)) return "tomorrow";
  return "";
}

/** The timezone's offset from UTC at `ts`, as "+05:30". */
export function offsetOf(timeZone: string | undefined, ts: number): string {
  if (!timeZone) return "+00:00";
  try {
    const parts = formatter("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(ts));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
    const mins = Math.round((asUtc - Math.floor(ts / 1000) * 1000) / MIN);
    const sign = mins < 0 ? "-" : "+";
    const h = String(Math.floor(Math.abs(mins) / 60)).padStart(2, "0");
    const m = String(Math.abs(mins) % 60).padStart(2, "0");
    return `${sign}${h}:${m}`;
  } catch {
    return "+00:00";
  }
}

/* A moment the model wrote down, made absolute.
 *
 * Asked for ISO with an offset; accepted without one, in which case it is a
 * wall-clock time in the user's own timezone -- which is what "11am tomorrow"
 * means when they say it. Anything unparseable is dropped rather than guessed. */
export function resolveWhen(raw: unknown, timeZone?: string): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return null;
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/i.test(s);
  const withTime = /T\d{2}:\d{2}/.test(s) ? s : `${s.slice(0, 10)}T12:00:00`;
  let ts = Date.parse(hasZone ? withTime : `${withTime}${offsetOf(timeZone, Date.parse(`${withTime}Z`))}`);
  if (!Number.isFinite(ts) && !hasZone) ts = Date.parse(`${withTime}Z`);
  return Number.isFinite(ts) ? new Date(ts).toISOString() : null;
}

export type Timed = { role: "user" | "assistant"; content: string; at?: string };

/* Mark the pauses.
 *
 * Only on their messages: the model's own past lines are what it imitates, and
 * timestamps in them would come back out in its replies. The first message the
 * model can see is always stamped, so it knows when the window starts -- that
 * is what tells it when "tomorrow" was said. */
export function stampPauses<T extends Timed>(messages: T[], timeZone: string | undefined, now: number): T[] {
  let prev: number | null = null;
  let stampedFirst = false;
  /* The last few messages, either side: once someone has said "in 20 minutes" or
     "at 9:30", even a minute between texts matters, and a plain gap below the
     usual half hour is stamped too. */
  const recent: string[] = [];
  return messages.map((m) => {
    const ts = m.at ? Date.parse(m.at) : NaN;
    if (!Number.isFinite(ts)) return m;
    const gap = prev === null ? null : ts - prev;
    prev = ts;
    const timed = recent.some((c) => DURATION.test(c));
    recent.push(m.content);
    if (recent.length > 4) recent.shift();
    if (m.role !== "user") return m;
    const first = !stampedFirst;
    stampedFirst = true;
    if (!first && (gap === null || gap < (timed ? MIN : GAP_MS))) return m;
    const when = wallClock(ts, timeZone);
    const label = first
      ? (now - ts > GAP_MS ? `${when}` : "")
      : `${when} · ${span(gap!)} after the message before`;
    return label ? { ...m, content: `[${label}]\n${m.content}` } : m;
  });
}

export type Plan = { what: string; at: string };

/* What time it is, how long the conversation was paused, and where each plan
 * stands. The replacement for a single "it is Thursday morning" line. */
export function timeBlock(opts: {
  you: string;
  timeZone?: string;
  now: number;
  /** When the conversation last moved before the message being answered. */
  previousAt?: string | null;
  plans?: Plan[];
}): string {
  const { you, timeZone, now } = opts;
  const h = Number(fmt(now, timeZone, { hour: "numeric", hourCycle: "h23" }));
  const part =
    h < 5 ? "the middle of the night" : h < 12 ? "morning" : h < 17 ? "afternoon" : h < 22 ? "evening" : "late at night";

  const lines = [
    `WHAT TIME IT IS`,
    `It is ${wallClock(now, timeZone)} where ${you} is (${part}). Notice it if it matters -- if it's 3am, that is worth a word. Don't announce the time otherwise.`,
  ];

  const prev = opts.previousAt ? Date.parse(opts.previousAt) : NaN;
  if (Number.isFinite(prev) && now - prev >= GAP_MS) {
    lines.push(
      `The conversation last moved ${span(now - prev)} ago, ${dayWord(prev, now, timeZone) || "on"} ${wallClock(prev, timeZone)}. Real time has passed since then. Anything said then about "tonight", "tomorrow" or "later" was relative to then, not to now -- work out where things stand from the timestamps.`
    );
  }

  const plans = (opts.plans ?? [])
    .map((p) => ({ ...p, ts: Date.parse(p.at) }))
    .filter((p) => Number.isFinite(p.ts) && p.what.trim())
    .sort((a, b) => a.ts - b.ts);
  if (plans.length) {
    lines.push(``, `PLANS AND DATES -- timed by the app from what was said, so trust these over your own sense of the date`);
    for (const p of plans) {
      const d = p.ts - now;
      const word = dayWord(p.ts, now, timeZone);
      const when = `${wallClock(p.ts, timeZone)}${word ? ` (${word})` : ""}`;
      const status =
        Math.abs(d) < 2 * MIN ? "that is about now"
          : d > 0 ? `in ${span(d)}`
          : `${span(d)} ago. The time has passed; whether it actually happened is not known. Do not assume it did or that it didn't, and do not invent how it went or what anyone did then -- not that you went, waited, were late or that it was called off. If it matters, ask, the way someone who doesn't know yet would`;
      lines.push(`- ${p.what.trim()} -- ${when}: ${status}.`);
    }
  }

  lines.push(
    ``,
    `REAL TIME PASSES AT REAL SPEED`,
    `- Things take as long as they would in life: a trip, an errand, a shower, cooking, getting ready. The clock above is the only way time moves.`,
    `- If you said you would be somewhere or do something in a stretch of time ("20 minutes"), you have NOT arrived or finished until that much real time has passed since you said it. Check the time above and the plans list. Until then you are on the way or still at it: say where you are, how far, what is holding you up ("just left", "stuck at the signal") -- never "I'm at the door" a couple of messages later.`,
    `- If ${you} asks how long, answer honestly and in keeping with the distance. Do not shrink it because they are eager or because the chat feels quick.`,
    `- If ${you} tells you to do something that takes time ("go finish your homework", "make dinner"), you go and do it: say you are going, and do not report it done until a believable amount of time has gone by. If they message meanwhile, you are partway through it.`,
    `- Messages are quick. Two messages a few seconds apart are a few seconds apart, however much was said in them.`,
    ``,
    `Lines in [square brackets] at the start of ${you}'s messages are timestamps added by the app. Never write them yourself.`
  );
  return lines.join("\n");
}

/* The hour again, said last. timeBlock sits near the top of the prompt, and
   everything after it -- her own day, her storylines, "bring up what happened
   to you" -- won: "good morning" at 11pm, lunch at midnight, just off to
   college at 2am. Said at the end, with what that hour looks like, it holds. */
const HOURS = [
  [5, "the middle of the night", "you are up far too late: in bed, can't sleep, or awake for a reason. Quieter, sleepier, a bit softer"],
  [12, "morning", "the day is just starting: waking up, getting ready, on the way, the first class or job of the day"],
  [17, "afternoon", "the middle of the day: work, college, lunch, errands, the afternoon slump"],
  [22, "evening", "the day is winding down: home, dinner, a show, plans for tonight"],
  [24, "late at night", "the day is done: in bed or nearly, winding down, sleepy, late-night talk"],
] as const;

export function nowBlock(you: string, timeZone: string | undefined, now: number): string {
  const h = Number(fmt(now, timeZone, { hour: "numeric", hourCycle: "h23" }));
  const [, part, day] = HOURS.find(([end]) => h < end)!;
  const time = fmt(now, timeZone, { weekday: "long", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return `

IT IS ${time.toUpperCase()} -- ${part.toUpperCase()} -- FOR YOU BOTH
Everything you say fits this hour, over anything above that suggests another time of day:
- Right now ${day}.${h >= 23 || h < 5 ? `
- Late-night talk: softer, more honest and more personal than in the day. This is when you say what you would not say at noon -- a worry, a memory, what ${you} means to you.` : ""}
- Greet for the hour or not at all: no "good morning" unless it is morning, no "good night" before it is night.
- Your own news fits the clock: what already happened today is earlier, what is still coming is later. At night lunch is long over; in the morning last night was last night.
- If ${you} says something that does not fit the hour, you can notice it the way a person would.`;
}

/** When the conversation last moved before the unanswered run at its end. */
export function previousMoment(messages: Timed[]): string | null {
  let i = messages.length - 1;
  while (i >= 0 && messages[i].role === "user") i--;
  /* The last thing before their latest burst; if they are double-texting after
     a pause, the start of that burst is what the pause ended on. */
  if (i >= 0) return messages[i].at ?? null;
  return null;
}
