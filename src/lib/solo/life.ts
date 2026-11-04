"use client";

import { LEVELS, MOMENTS } from "@/lib/presence/persona";
import { formatter } from "@/lib/presence/time";
import { findMuse, promptPersona, type Life, type LifeArc, type SoloMemory, type SoloMessage, type SoloMuse, type SoloState } from "./store";
import { storyOf } from "./story";

/* What makes a character someone with their own life, and a relationship that
 * goes somewhere.
 *
 *   - Her life: two or three storylines of her own, each moving on a little
 *     every day, whether or not anyone texts her. Made up by the model from who
 *     she is, kept here, and told to her each turn so she can bring them up.
 *   - Moments: things that happen once, when the two of you have come far
 *     enough -- a nickname at three days, a story she has never told at a week.
 *   - The quiz score: "how well do you know each other", kept across days.
 *   - Plans made together: when the time comes, she starts them, and while they
 *     are on, she is in them.
 *
 * Everything is pure apart from advanceLife, which asks the server for the
 * next day of her life.
 */

type Update = (next: SoloState | ((cur: SoloState) => SoloState)) => void;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/* ------------------------------------------------------------- her life */

/* Only someone invented has a life to invent. A portrait of a real person --
   someone living, someone who died, someone famous -- must not be handed a
   week of made-up events. */
export function hasOwnLife(m: SoloMuse | undefined): boolean {
  return m?.persona?.mode === "character";
}

/** About once a day: the first time the chat is opened after that. */
export function lifeDue(s: SoloState, museId: string, now = Date.now()): boolean {
  if (!hasOwnLife(findMuse(s, museId))) return false;
  const life = s.lives?.[museId];
  return !life || now - Date.parse(life.advancedAt) > 20 * HOUR;
}

export interface LifeStep {
  /** An existing arc moved on (id given) or a new one (no id). */
  arcs: { id?: string; title: string; beat: string | null; done?: boolean; rough?: boolean }[];
  /** Beats she has told them since last time. */
  told: string[];
  /** Their secret, when one was asked for. */
  secret?: string | null;
}

/** Folds a day of her life into the state. Pure. */
export function applyLife(s: SoloState, museId: string, step: LifeStep, now = Date.now()): SoloState {
  const at = new Date(now).toISOString();
  const prior = s.lives?.[museId]?.arcs ?? [];
  const told = new Set(step.told);
  const id = (p: string) => `${p}-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  let arcs: LifeArc[] = prior.map((a) => ({ ...a, beats: a.beats.map((b) => (told.has(b.id) ? { ...b, told: true } : b)) }));
  for (const r of step.arcs) {
    const beat = r.beat?.trim() ? { id: id("beat"), at, text: r.beat.trim().slice(0, 300), ...(r.rough ? { rough: true } : {}) } : null;
    const existing = r.id ? arcs.find((a) => a.id === r.id) : undefined;
    if (existing) {
      arcs = arcs.map((a) => (a === existing ? { ...a, done: !!r.done, beats: [...a.beats, ...(beat ? [beat] : [])].slice(-6) } : a));
    } else if (beat && r.title.trim()) {
      arcs.push({ id: id("arc"), title: r.title.trim().slice(0, 80), done: !!r.done, beats: [beat] });
    }
  }
  /* Finished ones fade after a week; never more than three going at once. */
  arcs = arcs.filter((a) => !a.done || now - Date.parse(a.beats.at(-1)?.at ?? at) < 7 * DAY);
  const active = arcs.filter((a) => !a.done).slice(-3);
  arcs = [...arcs.filter((a) => a.done), ...active];
  const secret = s.lives?.[museId]?.secret ?? (step.secret?.trim().slice(0, 300) || undefined);
  const life: Life = { arcs, advancedAt: at, ...(secret ? { secret } : {}) };
  return { ...s, lives: { ...(s.lives ?? {}), [museId]: life } };
}

/* One request per character at a time, however many screens ask. */
const advancing = new Set<string>();

/** Moves her life on by a day, if it is due. Quiet on failure: she just has the same week. */
export async function advanceLife(s: SoloState, museId: string, update: Update): Promise<void> {
  if (!lifeDue(s, museId) || advancing.has(museId)) return;
  const muse = findMuse(s, museId);
  const persona = muse ? promptPersona(muse, s.userName) : null;
  if (!muse || !persona) return;
  advancing.add(museId);
  try {
    const life = s.lives?.[museId];
    const since = life ? Date.parse(life.advancedAt) : null;
    /* Both sides: hers to tell what she has told, theirs for advice she takes. */
    const you = s.userName ?? "They";
    const said = (s.conversations[museId] ?? [])
      .filter((m) => since === null || Date.parse(m.at) > since)
      .slice(-30)
      .map((m) => `${m.from === "muse" ? "Her" : you}: ${m.content}`.slice(0, 400));
    const res = await fetch("/api/solo/life", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        persona,
        userName: s.userName,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        days: since === null ? 0 : Math.min(14, Math.max(1, Math.round((Date.now() - since) / DAY))),
        arcs: (life?.arcs ?? []).filter((a) => !a.done).map((a) => ({
          id: a.id, title: a.title, beats: a.beats.slice(-3).map((b) => ({ id: b.id, text: b.text })),
        })),
        said,
        needSecret: !life?.secret,
        rough: roughWanted(s, museId),
      }),
    });
    if (!res.ok) return;
    const step = (await res.json()) as LifeStep;
    if (!Array.isArray(step.arcs)) return;
    update((cur) => (lifeDue(cur, museId) ? applyLife(cur, museId, { arcs: step.arcs, told: step.told ?? [], secret: step.secret }) : cur));
  } catch {
    /* she keeps the week she had */
  } finally {
    advancing.delete(museId);
  }
}

/* A bad day. Now and then, for someone you are comfortable with, one of her
   storylines takes a turn for the worse -- and she texts you first, wanting you. */
const ROUGH_GAP_DAYS = 4;

/** Whether today's life update should include a bad day: close enough, not lately, and by chance. */
export function roughWanted(s: SoloState, museId: string, now = Date.now(), roll = Math.random()): boolean {
  if (!hasOwnLife(findMuse(s, museId)) || (bondOf(s, museId, now)?.level ?? 0) < 2) return false;
  const recent = (s.lives?.[museId]?.arcs ?? []).some((a) => a.beats.some((b) => b.rough && now - Date.parse(b.at) < ROUGH_GAP_DAYS * DAY));
  return !recent && roll < 0.3;
}

/** A bad day she has not yet texted about, fresh enough to still be news. */
export function roughDue(s: SoloState, museId: string, now = Date.now()): { id: string; text: string } | null {
  if (!hasOwnLife(findMuse(s, museId)) || (bondOf(s, museId, now)?.level ?? 0) < 2) return null;
  for (const a of s.lives?.[museId]?.arcs ?? []) {
    const b = a.beats.findLast((x) => x.rough && !x.texted && !x.told && now - Date.parse(x.at) < 36 * HOUR);
    if (b) return { id: b.id, text: b.text };
  }
  return null;
}

export function markRoughTexted(s: SoloState, museId: string, beatId: string): SoloState {
  const life = s.lives?.[museId];
  if (!life) return s;
  const arcs = life.arcs.map((a) => ({ ...a, beats: a.beats.map((b) => (b.id === beatId ? { ...b, texted: true } : b)) }));
  return { ...s, lives: { ...(s.lives ?? {}), [museId]: { ...life, arcs } } };
}

/** Her storylines, as the prompt reads them: the latest two beats of each going one. */
export function lifeForTurn(s: SoloState, museId: string): { title: string; beats: string[]; untold: boolean }[] {
  if (!hasOwnLife(findMuse(s, museId))) return [];
  return (s.lives?.[museId]?.arcs ?? [])
    .filter((a) => !a.done && a.beats.length)
    .map((a) => ({
      title: a.title.slice(0, 80),
      beats: a.beats.slice(-2).map((b) => b.text.slice(0, 300)),
      untold: !a.beats.at(-1)!.told,
    }));
}

/* --------------------------------------------------------------- moments */

const REACHED: Record<string, (x: ReturnType<typeof storyOf>, bank: number) => boolean> = {
  "days-3": (x) => x.daysTalked >= 3,
  "call-1": (x) => x.calls >= 1,
  "days-7": (x) => x.daysTalked >= 7,
  "streak-7": (x) => x.streak >= 7,
  "days-14": (x) => x.daysTalked >= 14,
  "messages-500": (x) => x.messages >= 500,
  "days-30": (x) => x.daysTalked >= 30,
  "days-100": (x) => x.daysTalked >= 100,
  /* Close, as bondOf counts it. */
  secret: (x, bank) => bank + x.yours + 12 * x.daysTalked + 25 * x.calls >= LEVELS[3].at,
};

/* What is left before each one, for the story page's "next". */
const TO_GO: Record<string, (x: ReturnType<typeof storyOf>) => string> = {
  "days-3": (x) => `${3 - x.daysTalked} more day${3 - x.daysTalked === 1 ? "" : "s"} of talking`,
  "call-1": () => "your first call",
  "days-7": (x) => `${7 - x.daysTalked} more days of talking`,
  "streak-7": (x) => `${7 - x.streak} more days in a row`,
  "days-14": (x) => `${14 - x.daysTalked} more days of talking`,
  "messages-500": (x) => `${500 - x.messages} more messages`,
  "days-30": (x) => `${30 - x.daysTalked} more days of talking`,
  "days-100": (x) => `${100 - x.daysTalked} more days of talking`,
  secret: () => `getting Close`,
};

const portraitOfSomeoneReal = (m: SoloMuse | undefined) => {
  const mode = m?.persona?.mode;
  return mode === "living" || mode === "memorial" || mode === "figure";
};

/* The moment this turn should carry, if one is due: reached, not had yet, and
   no more than one a day so they stay moments. */
export function momentDue(s: SoloState, museId: string, now = Date.now(), tz?: string): string | null {
  const muse = findMuse(s, museId);
  if (!muse?.persona) return null;
  const had = s.unlocked?.[museId] ?? [];
  if (had.some((u) => now - Date.parse(u.at) < 20 * HOUR)) return null;
  const story = storyOf(s, museId, now, tz);
  const real = portraitOfSomeoneReal(muse);
  const next = MOMENTS.find((m) => !had.some((u) => u.key === m.key) && !(real && m.invents) && REACHED[m.key]?.(story, s.bank?.[museId] ?? 0)
    && (m.key !== "secret" || !!s.lives?.[museId]?.secret));
  return next?.key ?? null;
}

export function unlock(s: SoloState, museId: string, key: string, now = Date.now()): SoloState {
  const had = s.unlocked?.[museId] ?? [];
  if (had.some((u) => u.key === key)) return s;
  return { ...s, unlocked: { ...(s.unlocked ?? {}), [museId]: [...had, { key, at: new Date(now).toISOString() }] } };
}

/** The story page: what has been unlocked, and the next one to come. */
export function momentsOf(s: SoloState, museId: string, now = Date.now(), tz?: string) {
  const muse = findMuse(s, museId);
  const had = s.unlocked?.[museId] ?? [];
  const real = portraitOfSomeoneReal(muse);
  const story = storyOf(s, museId, now, tz);
  const open = MOMENTS.filter((m) => !(real && m.invents));
  const unlocked = had
    .map((u) => ({ ...u, label: MOMENTS.find((m) => m.key === u.key)?.label ?? u.key }))
    .sort((a, b) => a.at.localeCompare(b.at));
  const next = open.find((m) => !had.some((u) => u.key === m.key) && !REACHED[m.key]?.(story, s.bank?.[museId] ?? 0));
  return { unlocked, next: next ? { label: next.label, toGo: TO_GO[next.key](story) } : null };
}

/** Between 9pm and 5am where they are. */
export function isNight(ts: number, timeZone?: string): boolean {
  const h = Number(formatter("en-GB", { hour: "numeric", hourCycle: "h23", timeZone }).format(new Date(ts)));
  return h >= 21 || h < 5;
}

/** "bye", "gn", "talk later", "chal bye": they are leaving. */
export function saidBye(text: string): boolean {
  return /\b(bye+|byee*|good ?night|gn+|ttyl|talk (to you )?later|gotta go|got to go|see (you|ya)|cya|chal(o)? bye|so(ne)? ja(ta|ti|ra|rha|rhi)?|sleep(ing)? now|going to sleep)\b/i.test(text);
}

/* ----------------------------------------------------------------- bond */

/* How close you have got: your messages, the days you have talked and the
   calls, as points. Someone living, who agreed to this, already knows you, so
   starts at Comfortable. Null for someone who died or a public figure. */
export function bondOf(s: SoloState, museId: string, now = Date.now(), tz?: string) {
  const muse = findMuse(s, museId);
  const mode = muse?.persona?.mode;
  if (!muse || mode === "memorial" || mode === "figure") return null;
  const st = storyOf(s, museId, now, tz);
  const points = (mode === "living" ? LEVELS[2].at : 0) + (s.bank?.[museId] ?? 0) + st.yours + 12 * st.daysTalked + 25 * st.calls;
  const level = LEVELS.findLastIndex((l) => points >= l.at);
  const next = LEVELS[level + 1];
  return {
    level,
    label: LEVELS[level].label,
    /* 0..1 of the way to the next level; 1 at the top. */
    progress: next ? (points - LEVELS[level].at) / (next.at - LEVELS[level].at) : 1,
    next: next ? { label: next.label, toGo: next.at - points } : null,
  };
}

/* ---------------------------------------------------------------- secret */

/** Their secret and where it stands: hinted from Comfortable, told when the
 *  "secret" moment is due, shared once it has been. Null below Comfortable. */
export function secretFor(s: SoloState, museId: string, moment: string | null | undefined, now = Date.now()) {
  const text = hasOwnLife(findMuse(s, museId)) ? s.lives?.[museId]?.secret : undefined;
  if (!text) return null;
  if (moment === "secret") return { text, stage: "tell" as const };
  if ((s.unlocked?.[museId] ?? []).some((u) => u.key === "secret")) return { text, stage: "told" as const };
  return (bondOf(s, museId, now)?.level ?? 0) >= 2 ? { text, stage: "hint" as const } : null;
}

/* ------------------------------------------------------------------ quiz */

/** "[point: Piyush]" or "[point: me]", anywhere in a message: who won a quiz question. */
export function readPoint(text: string): { point: "user" | "muse" | null; rest: string } {
  const m = /\[point:\s*([^\]]{1,40})\]\s*/i.exec(text);
  if (!m) return { point: null, rest: text };
  const who = m[1].trim().toLowerCase();
  const rest = (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim();
  return { point: who === "me" || who === "muse" ? "muse" : "user", rest };
}

export function addPoint(s: SoloState, museId: string, who: "user" | "muse", now = Date.now()): SoloState {
  const cur = s.scores?.[museId] ?? { user: 0, muse: 0, rounds: 0, lastAt: new Date(now).toISOString() };
  const next = { ...cur, [who]: cur[who] + 1, rounds: cur.rounds + 1, lastAt: new Date(now).toISOString() };
  return { ...s, scores: { ...(s.scores ?? {}), [museId]: next } };
}

/* ---------------------------------------------------- plans made together */

/* A dated plan that names the Muse is one made with her: the notes are about
   the user, so the Muse only appears in one when she is part of it. */
const TOGETHER = /\bthe muse\b/i;
/** How long a plan made together runs once started. */
const RUNS_MS = 3 * HOUR;

function together(s: SoloState, museId: string): SoloMemory[] {
  const name = findMuse(s, museId)?.name.toLowerCase();
  return s.memories.filter((m) =>
    m.museId === museId && m.at && !m.circleId &&
    (TOGETHER.test(m.content) || (!!name && m.content.toLowerCase().includes(`with ${name}`))));
}

/** A plan made together whose time has come and that has not been started. */
export function planDue(s: SoloState, museId: string, now = Date.now()): SoloMemory | null {
  return together(s, museId).find((m) => {
    const t = Date.parse(m.at!);
    return now >= t - 10 * 60_000 && now < t + RUNS_MS && !s.started?.[m.id];
  }) ?? null;
}

/** The plan made together that is on right now, if one is. */
export function togetherNow(s: SoloState, museId: string, now = Date.now()): { id: string; what: string; since: number } | null {
  for (const m of together(s, museId)) {
    const startedAt = s.started?.[m.id];
    if (!startedAt) continue;
    const since = now - Date.parse(startedAt);
    if (since >= 0 && since < RUNS_MS) return { id: m.id, what: m.content.slice(0, 300), since };
  }
  return null;
}

export function markStarted(s: SoloState, memoryId: string, now = Date.now()): SoloState {
  if (s.started?.[memoryId]) return s;
  return { ...s, started: { ...(s.started ?? {}), [memoryId]: new Date(now).toISOString() } };
}

/* ---------------------------------------------------------- the nudge */

/* Left on read. When she asked something and they have gone quiet, she sends
   one more -- "hello?? kahan gaya" -- a few minutes on, the way people do.
   Once per question, never when they said they were going, never at night,
   and never for a conversation that went quiet long ago. */
const LEAVING = /\b(good ?night|gn|bye|ttyl|baad me|baadme|so ja|sone ja|sleep|brb|busy)\b/i;
const NUDGE_AFTER_MS = 3 * 60_000;
const NUDGE_SPREAD_MS = 3 * 60_000;
/** Past this, the moment has gone: opening the chat later never sets one off. */
export const NUDGE_STALE_MS = 2 * 60_000;

/** When she would nudge, as a time, or null when she would not. */
export function nudgeAt(thread: SoloMessage[], timeZone?: string): number | null {
  const last = thread.at(-1);
  if (!last || last.from !== "muse" || last.proactive || last.callId) return null;
  let i = thread.length - 1;
  const run: SoloMessage[] = [];
  while (i >= 0 && thread[i].from === "muse") run.unshift(thread[i--]);
  const theirs = i >= 0 ? thread[i] : null;
  if (!theirs || run.some((m) => m.nudge) || theirs.callId) return null;
  if (!run.some((m) => m.content.includes("?"))) return null;
  if (LEAVING.test(theirs.content)) return null;
  const shownAt = Date.parse(last.showAt ?? last.at);
  if (!Number.isFinite(shownAt)) return null;
  let h = 0;
  for (let k = 0; k < last.id.length; k++) h = (h * 31 + last.id.charCodeAt(k)) | 0;
  const at = shownAt + NUDGE_AFTER_MS + (Math.abs(h) % NUDGE_SPREAD_MS);
  const hour = Number(formatter("en-GB", { hour: "numeric", hourCycle: "h23", timeZone }).format(new Date(at)));
  return hour >= 1 && hour < 8 ? null : at;
}
