"use client";

import { DEFAULT_VIBE, REGISTERS, hasFeelings, wornPhrases, type Vibe } from "@/lib/presence/persona";
import {
  QUOTE_CHARS, callbackForTurn, feelingsOf, findMuse, heardForTurn, isMediaCaption, knownTo, mediaAllowed, memoriesForTurn, plansForTurn,
  promisesForTurn, promptPersona, quoteOf, sharedForTurn, windowOf, worthRecalling, type SoloMessage, type SoloMuse, type SoloState,
} from "./store";
import { bondOf, isNight, lifeForTurn, momentDue, saidBye, secretFor, togetherNow } from "./life";
import { photoBase64 } from "./photos";
import { VIDEO_ONLY, clipLength, framesBase64 } from "./attach";
import { storyLine, storyOf } from "./story";
import { embedTexts } from "./learn";
import { worldFor } from "./world";

/* One reply's request to /api/solo/chat, and reading its stream.
 *
 * Shared by the text chat and the voice call, so a call is the same character
 * with the same memories, plans, feelings and history -- only the register
 * differs ("live": spoken aloud). There is one place that decides what the
 * model is told, and a call cannot drift from a chat because it has no copy of
 * its own.
 */

export const MAX_MESSAGE = 8000;

/* Recall by meaning needs the conversation embedded, about half a second. It
   used to start only once the reply did; now it starts the moment a message is
   sent, during the pause before the reply, and the reply picks up the result. */
const recalling = new Map<string, Promise<(number[] | null)[] | null>>();

function recall(query: string): Promise<(number[] | null)[] | null> {
  const ready = recalling.get(query);
  recalling.delete(query);
  return ready ?? embedTexts([query]);
}

/** Starts recall for the thread as it will be once this message is in it. */
export function primeRecall(thread: { content: string }[]): void {
  const query = thread.slice(-4).map((m) => m.content).join("\n");
  if (!worthRecalling(query) || recalling.has(query)) return;
  if (recalling.size > 8) recalling.clear();
  recalling.set(query, embedTexts([query]));
}

export interface PreparedTurn {
  person: SoloMuse;
  vibe: Vibe;
  body: Record<string, unknown>;
  /* The id of each message in body.messages, in order; null for one the app
     added (withAppMessage). How a "trimmed" reply is turned into a cutoff. */
  sent: (string | null)[];
}

/** Everything a reply needs, from the state as it is now. */
export async function prepareTurn(
  s: SoloState,
  museId: string,
  opts: {
    signal?: AbortSignal;
    register?: string;
    fallback?: SoloMuse;
    /* On a call, recall by meaning only if it is quick: past this the turn
       goes ahead on word overlap, because silence on the line costs more than
       a slightly worse memory match. */
    embedWithinMs?: number;
    /** Whether this device can keep photos and voice notes. */
    canStore?: boolean;
    /** A milder heat for this one reply only (after a block), over the chat's own. */
    heat?: string;
  } = {}
): Promise<PreparedTurn | null> {
  const person = findMuse(s, museId) ?? opts.fallback;
  if (!person) return null;
  const thread = s.conversations[museId] ?? [];
  /* What the model is shown starts at the cutoff, if the provider refused
     everything before it. Everything else -- tics, the story -- still reads
     the whole thread. */
  const cut = s.cutoffs?.[museId];
  const from = cut?.from ? thread.findIndex((m) => m.id === cut.from) : -1;
  const visible = from > 0 ? thread.slice(from) : thread;
  const stored: Vibe = s.vibes?.[museId] ?? DEFAULT_VIBE;
  const vibe: Vibe = opts.register ? { ...stored, register: opts.register } : stored;
  const feelingsNow = feelingsOf(s, museId);
  const together = togetherNow(s, museId);

  /* How close you are, back after days away, and a goodnight at night: each
     shapes this one reply (see awayBlock, goodnightBlock). Not on a call. */
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const bond = bondOf(s, museId, Date.now(), tz);
  const lastIn = thread.at(-1);
  const away = (() => {
    if (!bond || lastIn?.from !== "user" || opts.register === "live") return null;
    let i = thread.length - 1;
    while (i >= 0 && thread[i].from === "user") i--;
    const before = thread[i];
    const gap = before ? Date.now() - Date.parse(before.at) : 0;
    return gap >= 2 * 86_400_000 ? { days: Math.floor(gap / 86_400_000), level: bond.level } : null;
  })();
  const goodnight = !!bond && bond.level >= 2 && opts.register !== "live" && lastIn?.from === "user"
    && saidBye(lastIn.content) && isNight(Date.now(), tz);

  // The last few turns, so retrieval follows the subject rather than a
  // two-word reply carrying no signal.
  const query = visible.slice(-4).map((m) => m.content).join("\n");
  /* One extra round trip before the reply, and it is what makes recall work on
     meaning rather than shared words. Falls back to overlap when it fails, so
     the cost of it going wrong is a worse memory, not a failed message.
     Skipped entirely when the last few turns are "hmm" and "yeah": there is
     nothing to recall against, and a vector for filler still lands nearest to
     something. Also where most of the half-second goes. */
  const embedding = worthRecalling(query) ? recall(query) : Promise.resolve(null);
  const timed = opts.embedWithinMs
    ? Promise.race([embedding, new Promise<null>((r) => setTimeout(() => r(null), opts.embedWithinMs))])
    : embedding;
  const [queryVector] = (await timed) ?? [null];
  if (opts.signal?.aborted) return null;
  const memories = memoriesForTurn(s, museId, query, queryVector);
  const sending = windowOf(visible);

  const body = {
    muse: {
      name: person.name.slice(0, 40),
      description: person.description.slice(0, 400),
      /* Clamped to what the route accepts rather than sent as stored.
         These caps are one-sided -- the wizard let a relationship run to
         120 characters while the route rejects past 40 -- and the reply
         path has no tolerance for a rejection: the offending value is in
         localStorage, so every future request carries it and 400s too.
         One long word typed once during setup ended the character. */
      relationshipType: person.relationshipType.slice(0, 40) || "someone close",
      languages: person.languages ?? ["English"],
      personality: {
        traits: (person.traits ?? []).slice(0, 8),
        values: person.values, humour: person.humour, emotionalStyle: person.emotionalStyle,
        opinions: person.opinions, customInstructions: person.customInstructions,
        tone: person.tone, formality: person.formality, sentenceLength: person.sentenceLength,
        catchphrases: person.catchphrases, dialect: person.dialect,
      },
    },
    // Bounded by size rather than count -- see windowOf.
    messages: withReactions(await withPhotos(sending, cut?.photosAfter)).map(({ m, image, frames, note }) => {
      const q = quoteOf(thread, m);
      return {
        role: m.from === "user" ? ("user" as const) : ("assistant" as const),
        /* Same reasoning: one pasted message over the route's limit sat in
           the window and killed every turn after it, permanently. */
        content: `${note}${m.voiceNote ? "(voice note) " : ""}${m.video ? videoNote(m, !!frames) : m.content}`.slice(0, MAX_MESSAGE),
        at: m.at,
        ...(image ? { image } : {}),
        ...(frames ? { frames } : {}),
        ...(q
          ? { quote: { role: q.from === "user" ? "user" : "assistant", content: q.content.slice(0, QUOTE_CHARS) } }
          : {}),
      };
    }),
    /* Present only for someone with a full profile. When it is, the
       server ignores the simple shape above and uses Presence's prompt. */
    persona: promptPersona(person, s.userName),
    /* Everyone they share a circle with. Capped: someone in circles with nine
       or more other people exceeded the route's limit and could no longer hold
       a one-to-one conversation at all. */
    knows: knownTo(s, museId).slice(0, 8).map((k) => ({
      name: k.name.slice(0, 60),
      relationship: k.relationshipType.slice(0, 120),
    })),
    mood: vibe.mood,
    topic: vibe.topic,
    register: vibe.register,
    /* How they are generally, as opposed to how this conversation is
       going. Sent every turn: it is a state, not an event. */
    feelings: hasFeelings(feelingsNow) ? feelingsNow : null,
    /* Clamped on read as well as on write: anything already in someone's
       browser over the limit would 400 the whole request the moment it ranks
       into the top few. */
    memories: memories.map((m) => m.slice(0, 400)),
    /* Dated plans, each with its instant, so the reply knows whether
       "tomorrow at 11" is still ahead or already behind. */
    /* A plan made together that is on right now goes as `together` instead:
       the plan list would call it "time passed, outcome unknown". */
    plans: plansForTurn(s, museId)
      .filter((p) => !together || p.what.slice(0, 300) !== together.what)
      .map((p) => ({ what: p.what.slice(0, 420), at: p.at })),
    together: together ? { what: together.what, since: together.since } : null,
    /* Her own storylines, what she owes them, and a moment if one is due. */
    life: lifeForTurn(s, museId),
    promises: promisesForTurn(s, museId).map((p) => ({ what: p.what.slice(0, 300), ago: Math.round(p.ago) })),
    moment: opts.register === "live" ? null : momentDue(s, museId, Date.now(), Intl.DateTimeFormat().resolvedOptions().timeZone),
    score: s.scores?.[museId] ?? null,
    secret: secretFor(s, museId, opts.register === "live" ? null : momentDue(s, museId, Date.now(), Intl.DateTimeFormat().resolvedOptions().timeZone)),
    /* What was said about them in the other chats, and an old thing to bring up
       -- not on a call, and not alongside a moment: one special thing a reply. */
    heard: heardForTurn(s, museId),
    callback: opts.register === "live" || momentDue(s, museId, Date.now(), Intl.DateTimeFormat().resolvedOptions().timeZone)
      ? null : callbackForTurn(s, museId),
    bond: bondOf(s, museId, Date.now(), Intl.DateTimeFormat().resolvedOptions().timeZone)?.level ?? null,
    userName: s.userName,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    /* How often you actually talk, here. Background for the model. */
    story: storyLine(storyOf(s, museId, Date.now(), Intl.DateTimeFormat().resolvedOptions().timeZone), Date.now()),
    /* Nicknames and running jokes: theirs, used now and then. */
    shared: sharedForTurn(s, museId).map((m) => m.slice(0, 400)),
    /* Their own tics across the last fifty texts, most of which are no longer
       in the window -- counted here, where the whole thread is. */
    worn: wornPhrases(
      thread.filter((m) => m.from === "muse" && !m.voiceNote && !isMediaCaption(m.content)).slice(-50).map((m) => m.content)
    ),
    /* What they can send besides texts this turn. Only in a texting register:
       a letter or a call is one piece, spoken or written, not a chat. */
    can: person.persona && (REGISTERS[vibe.register as keyof typeof REGISTERS] ?? REGISTERS.texts).burst
      ? mediaAllowed(s, museId, { canStore: opts.canStore, level: bond?.level, goodnight })
      : null,
    away,
    goodnight,
    heat: opts.heat ?? vibe.heat,
    /* The weather where they are and the festival coming up. On a call only the
       festival: a weather lookup is a pause on the line. */
    world: await worldFor(opts.register === "live" ? undefined : s.place, Date.now(), tz),
    /* A long thread: the character is put back in front of the model (anchorBlock). */
    long: thread.length > 40,
  };
  return { person, vibe, body, sent: sending.map((m) => m.id) };
}

/* The most recent few photos go with the reply, as pictures; older ones stay
   words. Loaded from IndexedDB only for the messages that need them. */
export async function withPhotos(window: SoloMessage[], after?: string): Promise<{
  m: SoloMessage;
  image?: { mime: string; data: string };
  frames?: { mime: string; data: string }[];
}[]> {
  const recent = new Set(window
    .filter((m) => m.from === "user" && m.image && (!after || m.at > after))
    .slice(-3).map((m) => m.id));
  /* Videos: only the latest goes as frames. Four pictures each, and an older
     clip is not what anyone is talking about now. */
  const clip = window.filter((m) => m.from === "user" && m.video?.frames.length && (!after || m.at > after)).at(-1)?.id;
  return Promise.all(window.map(async (m) => {
    if (m.id === clip) {
      const frames = await framesBase64(m);
      return frames.length ? { m, frames } : { m };
    }
    if (!recent.has(m.id) || !m.image) return { m };
    const image = await photoBase64(m.image.id).catch(() => null);
    return image ? { m, image } : { m };
  }));
}

/* How a video reads in the transcript: what it was, and whether its frames
   are attached to this message. */
export function videoNote(m: SoloMessage, withFrames: boolean): string {
  if (!m.video) return "";
  const caption = m.content === VIDEO_ONLY ? "" : m.content;
  return `(sent a video, ${clipLength(m.video.seconds)}${withFrames ? " -- the pictures with this are frames from through it, in order" : ""})${caption ? `
${caption}` : ""}`;
}

/* Reactions, as the model reads them. Theirs to one of the Muse's texts rides
   on their next message ("(reacted ❤️ to your "…")"), so it lands where the
   conversation is; the Muse's own reaction to one of theirs is noted on that
   message, so it knows it already answered with an emoji. Parentheses, not
   brackets: brackets at the start of a line are the app's timestamps. */
function withReactions<T extends { m: SoloMessage }>(rows: T[]): (T & { note: string })[] {
  let pending: string[] = [];
  return rows.map((row) => {
    const { m } = row;
    if (m.from === "muse") {
      if (m.reactions?.user) pending.push(`(reacted ${m.reactions.user} to your "${m.content.slice(0, 60)}")`);
      return { ...row, note: "" };
    }
    const mine = m.reactions?.muse ? `(you reacted ${m.reactions.muse} to this)\n` : "";
    const note = (pending.length ? `${pending.join("\n")}\n` : "") + mine;
    pending = [];
    return { ...row, note };
  });
}

/* One message from the app itself, after the conversation: "the call just
   connected", "they asked how it is going". The window is already at the
   route's limit in a long thread, so it gives up its oldest message to make
   room -- appending to a full window was a 400 on every call greeting and
   every story note in any conversation longer than sixty messages. */
export function withAppMessage(prepared: PreparedTurn, content: string): void {
  const messages = prepared.body.messages as { role: string; content: string; at?: string }[];
  prepared.body.messages = [...messages.slice(-(ROUTE_MAX_MESSAGES - 1)), { role: "user", content, at: new Date().toISOString() }];
  prepared.sent = [...prepared.sent.slice(-(ROUTE_MAX_MESSAGES - 1)), null];
}

/** What /api/solo/chat accepts in one request. */
const ROUTE_MAX_MESSAGES = 60;

export type ReplyOutcome =
  /* `trimmed`: it only went through on part of the conversation -- the last
     `kept` messages sent, and without photos if `photos` is false. */
  | { ok: true; text: string; trimmed?: { kept: number; photos: boolean }; /** It went through at this milder heat. */ softened?: string }
  | { ok: false; message: string; retryable: boolean; partial: string; /** A filter stopped it. */ blocked?: boolean };

/* Reads /api/solo/chat's SSE stream, calling onDelta with the text so far. A
   reply that ended in an error is not a reply, however much of it arrived
   first -- the caller decides what, if anything, to keep. */
export async function streamReply(
  body: Record<string, unknown>,
  signal: AbortSignal,
  onDelta: (soFar: string, delta: string) => void
): Promise<ReplyOutcome> {
  const res = await fetch("/api/solo/chat", {
    method: "POST",
    signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    return { ok: false, message: data.error ?? "Something went wrong. Try again.", retryable: true, partial: "" };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let acc = "";
  let failure: { message: string; retryable: boolean; blocked?: boolean } | null = null;
  let softened: string | undefined;
  let trimmed: { kept: number; photos: boolean } | undefined;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const line = frame.split(/\r?\n/).find((l) => l.startsWith("data:"));
      if (!line) continue;
      let evt: { type?: string; text?: string; message?: string; retryable?: boolean; kept?: number; photos?: boolean; to?: string; blocked?: boolean };
      try { evt = JSON.parse(line.slice(5).trim()); } catch { continue; }
      if (evt.type === "delta" && evt.text) { acc += evt.text; onDelta(acc, evt.text); }
      else if (evt.type === "trimmed" && typeof evt.kept === "number") trimmed = { kept: evt.kept, photos: evt.photos !== false };
      else if (evt.type === "softened" && typeof evt.to === "string") softened = evt.to;
      else if (evt.type === "error") {
        failure = { message: evt.message ?? "Something went wrong.", retryable: evt.retryable !== false, blocked: evt.blocked === true };
      }
    }
  }
  return failure ? { ok: false, ...failure, partial: acc } : { ok: true, text: acc, ...(trimmed ? { trimmed } : {}), ...(softened ? { softened } : {}) };
}

/** The cutoff a trimmed reply implies, for the state. Null when nothing changes. */
export function cutoffFrom(
  prepared: PreparedTurn,
  trimmed: { kept: number; photos: boolean },
  now = Date.now()
): { from?: string; photosAfter?: string } | null {
  const first = trimmed.kept < prepared.sent.length ? prepared.sent[prepared.sent.length - trimmed.kept] : undefined;
  const out = {
    ...(first ? { from: first } : {}),
    ...(trimmed.photos ? {} : { photosAfter: new Date(now).toISOString() }),
  };
  return out.from || out.photosAfter ? out : null;
}
