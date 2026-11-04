"use client";

import { MADE_TAB, PERSONAS, TABS, type Persona } from "@/lib/personas";
import { storyOf } from "./story";
import { DEFAULT_FEELINGS, type Feelings, type PersonaDraft, type Vibe } from "@/lib/presence/persona";
import { rankMemories, type RankableMemory } from "@/lib/memory/rank";

/* Solo mode's storage layer — localStorage, no database, no account.
 *
 * Everything a signed-in MUSE keeps in Postgres lives here instead: the Muses,
 * the conversations, and the memories. The ranking is the same pure module the
 * server uses; it runs in the browser without embeddings and falls back to
 * lexical scoring, which is exactly the path rankMemories already takes when a
 * provider has no embedding model.
 *
 * Every read and write is guarded. localStorage throws outright in some privacy
 * modes rather than returning null, and a companion that crashes on open is
 * worse than one that forgets.
 */

export const KEY = "muse.solo/1";

export interface SoloMemory {
  id: string;
  museId: string;
  content: string;
  type: string;
  importance: number;
  confidence: number;
  createdAt: string;
  /* 256 dimensions, unit length. Absent on anything stored before recall
     worked on meaning, and on any turn where embedding failed -- ranking falls
     back to word overlap rather than breaking, so this stays optional. */
  embedding?: number[];
  /* The absolute moment a plan or an event is for, ISO. Set when the
     conversation fixed one ("tomorrow at 11" said at 11pm Wednesday is
     Thursday 11:00 in their timezone), so it can be said every turn whether
     that moment is still ahead or has passed. */
  at?: string;
  /* The circle this was learned in. Absent: learned one to one. A memory is
     the character's wherever it was learned -- what they were told privately
     goes into a group with them, marked private so it is not repeated there. */
  circleId?: string;
}

export interface SoloMessage {
  id: string;
  from: "user" | "muse";
  content: string;
  at: string;
  /* Which Muse said it. Absent in a one-to-one thread, where there is only one
     possible speaker; required in a circle, where there are several. Optional
     so conversations saved before circles existed still load. */
  speakerId?: string;
  /** Set when the user has changed the text after the fact. */
  edited?: boolean;
  /** The id of the message this one answers, WhatsApp-style. */
  replyTo?: string;
  /* Said out loud on a call rather than typed. The content is the transcript,
     so everything downstream -- the window, memory, export -- treats it as an
     ordinary message. No audio is kept. */
  via?: "voice";
  /** The call it was said on. */
  callId?: string;
  /** A spoken reply cut off by the user talking over it: content is what was actually heard. */
  interrupted?: boolean;
  /* A photo they sent. The file is in IndexedDB under `id`, never here; the
     message content is the caption, or PHOTO_ONLY. */
  image?: { id: string; w: number; h: number };
  /* When this text appears. A burst arrives from the model all at once but is
     saved with each text a little after the last, the way someone types them
     -- so leaving or reloading halfway loses nothing, it just shows the rest. */
  showAt?: string;
  /** A one-emoji reaction to this message, from either side. */
  reactions?: { user?: string; muse?: string };
  /* The Muse texted first: this came from the server's outreach, collected
     into the thread like any other message. `responded` once they replied. */
  proactive?: { interactionId: string; responded?: boolean };
  /* A voice note from the Muse. The audio is in IndexedDB under `id`, beside
     the photos; the content is what was said, so the window, memory and export
     read it as an ordinary message. */
  voiceNote?: { id: string; seconds: number };
  /* A song the Muse sent. The content says so in words, for the model. */
  song?: { title: string; artist: string };
  /** A quiz point this reply awarded: to the user, or to the Muse. */
  point?: "user" | "muse";
  /** A follow-up she sent because they went quiet after her question. */
  nudge?: boolean;
  /** A photo of theirs sent blurred, until it is tapped. */
  veiled?: boolean;
  /** The reply only went through one step milder (a Heat), so it is marked as such. */
  softened?: string;
  /* A video they sent. The file and a few frames from through it are in
     IndexedDB, never here; the model is sent the frames. */
  video?: { id: string; w: number; h: number; seconds: number; frames: string[] };
}

/* Her own life, going on between conversations: a few storylines, each moving
   on a little every day. See lib/solo/life.ts. */
/** `rough`: a bad day she may text them about; `texted`: she has. */
export interface LifeBeat { id: string; at: string; text: string; told?: boolean; rough?: boolean; texted?: boolean }
export interface LifeArc { id: string; title: string; done?: boolean; beats: LifeBeat[] }
export interface Life {
  arcs: LifeArc[];
  advancedAt: string;
  /** Something they have never told the user, invented once (lib/solo/life.ts). */
  secret?: string;
}

/** A moment unlocked by how far the two of you have come. */
export interface Unlocked { key: string; at: string }

/** "How well do you know each other", kept per Muse. */
export interface Score { user: number; muse: number; rounds: number; lastAt: string }

/* Outreach, as the app knows it. The server holds the finished messages and
   their times; this is the app's side -- the settings it last saved, which
   memories it has already offered, and what is pending, so it can call one
   off when the user brings the subject up first. */
export interface OutreachSettings {
  proactiveEnabled: boolean;
  initiationFrequency: "NEVER" | "RARELY" | "SOMETIMES" | "OFTEN";
  /** Minutes from local midnight. */
  quietHoursStart: number;
  quietHoursEnd: number;
  maxDailyProactive: number;
  allowedMuseIds: string[];
}

export const DEFAULT_OUTREACH: OutreachSettings = {
  proactiveEnabled: false,
  initiationFrequency: "SOMETIMES",
  quietHoursStart: 22 * 60,
  quietHoursEnd: 8 * 60,
  maxDailyProactive: 1,
  allowedMuseIds: [],
};

export interface OutreachTrigger {
  id: string;
  museId: string;
  sourceMemoryId: string;
  type: string;
  reason: string;
  scheduledFor: string;
  keywords: string[];
  createdAt: string;
  status: "PENDING" | "CANCELLED" | "SENT";
}

export interface OutreachState {
  settings?: OutreachSettings;
  /** Memory ids already offered to the server, so none is classified twice. */
  evaluated?: Record<string, true>;
  triggers?: OutreachTrigger[];
}

/* A voice call, as a record beside the conversation rather than a second
   conversation. Shaped like the account app's Prisma Call model so it can move
   there unchanged once accounts are on. */
export type CallStatus = "COMPLETED" | "MISSED" | "CANCELLED" | "FAILED";

export interface SoloCall {
  id: string;
  museId: string;
  startedAt: string;
  endedAt?: string;
  durationSeconds: number;
  status: CallStatus;
  /** First and last message said on it, in the Muse's ordinary thread. */
  firstMessageId?: string;
  lastMessageId?: string;
}

/* A fresh message, id and timestamp included.
 *
 * Pulled out of the components that build one rather than inlined at the call
 * site: React Compiler treats Date.now()/Math.random() reached from a
 * component's own body as impure and refuses to memoise around it, even when
 * the call only ever happens inside an event handler. Here it is neither in a
 * component nor in render, so there is nothing for the compiler to worry
 * about. */
export function newMessage(
  from: SoloMessage["from"],
  content: string,
  extra: { speakerId?: string; replyTo?: string } = {}
): SoloMessage {
  return {
    id: `${from === "user" ? "u" : "m"}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    from,
    content,
    at: new Date().toISOString(),
    ...(extra.speakerId ? { speakerId: extra.speakerId } : {}),
    ...(extra.replyTo ? { replyTo: extra.replyTo } : {}),
  };
}

/** What gets shown and sent for a quoted message. Short on purpose: the quote
 *  says which message, it does not need to repeat it. */
export const QUOTE_CHARS = 200;

export function quoteOf(log: SoloMessage[], m: SoloMessage): SoloMessage | undefined {
  return m.replyTo ? log.find((x) => x.id === m.replyTo) : undefined;
}

/* A circle is both halves of what was asked for: a set of people who know one
   another, and a thread they are all in. Keeping it one concept rather than two
   means membership cannot disagree with itself -- being in the group is what it
   means to know the others. */
export interface SoloCircle {
  id: string;
  name: string;
  memberIds: string[];
  createdAt: string;
  /** What the user wants the room talking about, in their own words. */
  topic?: string;
  /** How the group is together -- on top of who each member is. */
  traits?: string[];
}

/* The Presence fields are required on a starter and absent on a built
   character, which carries them inside `persona` instead. */
type PresenceFields = "arch" | "texture" | "mode" | "brief" | "samples" | "extra";

export interface SoloMuse
  extends Omit<Persona, PresenceFields>,
    Partial<Pick<Persona, PresenceFields>> {
  id: string;
  /** Personas that shipped with the app cannot be edited or deleted. */
  builtin: boolean;
  /* Someone built from real material carries Presence's full profile --
     archetype, texture, mode, the verbatim samples, the measured statistics.
     Present only for built characters; the four starters have none, and are
     described by the fields above instead. */
  persona?: PersonaDraft;
  /* Which voice they speak in on a call. A prebuilt voice id from
     lib/voice/voices.ts; absent until chosen, at which point one is picked to
     fit them and saved here. Never hard-coded: the provider's ids live in one
     catalogue, and this is only a reference into it. */
  voiceId?: string;
  /** Their picture, if they have one. See MuseAvatar. */
  avatar?: MuseAvatar | null;
}

/** Something kept in a scrapbook: a copy, so it survives clearing the chat. */
export interface Kept {
  id: string;
  from: "user" | "muse";
  text: string;
  /** When it was said. */
  at: string;
  keptAt: string;
  /** A photo, copied under its own id so deleting the message does not take it. */
  image?: { id: string; w: number; h: number };
  song?: { title: string; artist: string };
}

export interface SoloState {
  userName: string | null;
  muses: SoloMuse[];
  conversations: Record<string, SoloMessage[]>;
  memories: SoloMemory[];
  /* How each person is being spoken to right now, keyed by Muse. Kept per Muse
     rather than globally: someone can be prickly with you while someone else is
     not, and a single shared setting would be nonsense. */
  vibes?: Record<string, Vibe>;
  /** Circles share the `conversations` map; ids never collide. */
  circles?: SoloCircle[];
  /** Voice calls, newest last. Metadata only; what was said is in `conversations`. */
  calls?: SoloCall[];
  /** Texting first. Off unless switched on. */
  outreach?: OutreachState;
  /** Her storylines, keyed by Muse. */
  lives?: Record<string, Life>;
  /** Moments unlocked, keyed by Muse. */
  unlocked?: Record<string, Unlocked[]>;
  /** Quiz scores, keyed by Muse. */
  scores?: Record<string, Score>;
  /** Closeness points banked when a chat was cleared, keyed by Muse, so the level survives it. */
  bank?: Record<string, number>;
  /** Things kept from a chat, keyed by Muse (scrapbook.ts). */
  scrapbook?: Record<string, Kept[]>;
  /** Chats kept at the top of the list, and chats put away (chatlist.ts), by id. */
  pinned?: string[];
  archived?: string[];
  /** Where the user is, if they said, so characters can know their weather (world.ts). */
  place?: { name: string; lat: number; lon: number };
  /* Plans made together that have been started, by the memory id of the plan,
     so a movie night begins once. */
  started?: Record<string, string>;
  /* Where the model's view of a conversation starts, keyed by thread, when
     the provider refused everything before it (PROHIBITED_CONTENT on an old
     message or photo). `from`: the first message still sent. `photosAfter`:
     photos before this go as words only. The thread itself is untouched. */
  cutoffs?: Record<string, { from?: string; photosAfter?: string }>;
  /* What each character and the user have talked about one to one, before
     the stretch a group gets word for word. See refreshDigests. */
  digests?: Record<string, { text: string; upTo: string; at: string }>;
  /** "How it's going", in their words, from the story screen. Kept until asked again. */
  stories?: Record<string, { text: string; at: string }>;
  /* Changes to a starter, kept as an overlay rather than a copy so the
     originals stay the source of truth. Built characters are edited in place
     and never appear here. */
  edits?: Record<string, MusePatch>;
  /* Standing emotional state, keyed by Muse. Unlike a vibe this persists: it
     is meant to be set once and left, and it is still true next week. */
  feelings?: Record<string, Feelings>;
  /* What the user has deliberately made a character forget, keyed by Muse.
     
     Deleting a memory is not enough on its own. Extraction runs over the last
     several messages every turn, and dedup only compares against memories that
     currently exist -- so a memory removed on Tuesday is re-proposed on
     Wednesday from the same conversation that produced it, matches nothing, and
     comes back. Delete would appear to work and then silently undo itself,
     which is worse than not offering it.
     
     PRD §59: once deleted it must never be retrieved. That means remembering
     the deletion, not just performing it. */
  forgotten?: Record<string, string[]>;
  /* Set only when stored data existed but could not be read. Never persisted;
     it exists to stop an empty state being written over something recoverable. */
  corrupt?: boolean;
  /* Bumped on every write and stored first in the string, so another tab can
     tell whether disk has moved on since it last looked. See sync.ts. */
  rev?: number;
}

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export function builtinMuses(): SoloMuse[] {
  return PERSONAS.map((p) => ({
    ...p,
    id: `builtin-${slug(p.name)}`,
    builtin: true,
    /* `you` is left empty and filled at send time from whatever the user
       called themselves -- it is the one field that cannot be authored here. */
    persona: {
      them: p.name,
      you: "",
      relationship: p.relationshipType,
      arch: p.arch,
      texture: p.texture,
      mode: p.mode,
      brief: p.brief,
      samples: p.samples,
      extra: p.extra,
    },
  }));
}

function empty(): SoloState {
  return { userName: null, muses: [], conversations: {}, memories: [], vibes: {}, circles: [] };
}

/* Characters built before the Presence port stored their voice profile in
   `customInstructions` and had no `persona` at all. Those take the generic
   prompt rather than personaSystem, which means the mood and register controls
   have nothing to act on and the panel does not appear for them — reported as
   "change how this goes isn't working" on a character built days earlier.
   Rebuilt here from what was saved, so old characters get the same treatment as
   new ones without anyone having to make them again. */
function migrate(m: SoloMuse): SoloMuse {
  if (m.persona || m.builtin) return m;
  const brief = m.customInstructions?.trim() || m.description?.trim() || "";
  if (!brief) return m;
  return {
    ...m,
    persona: {
      them: m.name,
      you: "",
      relationship: m.relationshipType || "someone close",
      /* The originals recorded none of these, and guessing would put words in
         a character's mouth. "other" tells the prompt to lean entirely on the
         profile below rather than assume a relationship script. */
      arch: "other",
      texture: "close",
      mode: "character",
      brief,
    },
  };
}

export function loadState(): SoloState {
  let raw: string | null;
  try {
    raw = localStorage.getItem(KEY);
  } catch (err) {
    console.error("solo state could not be read", err);
    return { ...empty(), corrupt: true };
  }
  return parseState(raw);
}

/** A stored state, from its serialised form, wherever it was kept. */
export function parseState(raw: string | null | undefined): SoloState {
  try {
    if (!raw) return empty();
    const parsed = JSON.parse(raw) as Partial<SoloState>;
    return {
      userName: parsed.userName ?? null,
      muses: Array.isArray(parsed.muses) ? parsed.muses.map(migrate) : [],
      conversations: parsed.conversations ?? {},
      memories: Array.isArray(parsed.memories) ? parsed.memories : [],
      vibes: parsed.vibes ?? {},
      circles: Array.isArray(parsed.circles) ? parsed.circles : [],
      calls: Array.isArray(parsed.calls) ? parsed.calls : [],
      outreach: parsed.outreach ?? {},
      lives: parsed.lives ?? {},
      unlocked: parsed.unlocked ?? {},
      scores: parsed.scores ?? {},
      bank: parsed.bank ?? {},
      scrapbook: parsed.scrapbook ?? {},
      ...(Array.isArray(parsed.pinned) ? { pinned: parsed.pinned } : {}),
      ...(Array.isArray(parsed.archived) ? { archived: parsed.archived } : {}),
      ...(parsed.place && typeof parsed.place === "object" ? { place: parsed.place } : {}),
      started: parsed.started ?? {},
      cutoffs: parsed.cutoffs ?? {},
      digests: parsed.digests ?? {},
      stories: parsed.stories ?? {},
      edits: parsed.edits ?? {},
      feelings: parsed.feelings ?? {},
      forgotten: parsed.forgotten ?? {},
      rev: typeof parsed.rev === "number" ? parsed.rev : 0,
    };
  } catch (err) {
    /* Unreadable, which is not the same as absent.
     *
     * Returning a blank state here made the app open as though it were brand
     * new, and the very next write -- a keystroke, a vibe chip -- saved that
     * blank state over the top. Whatever was in there, damaged or merely
     * unparseable by a newer build, was then genuinely gone. A truncated write
     * or a half-synced profile is recoverable right up until the moment it is
     * overwritten.
     *
     * `corrupt` tells the caller not to write, so the raw text stays on disk
     * and can still be rescued. */
    console.error("solo state could not be read", err);
    return { ...empty(), corrupt: true };
  }
}

/* Roughly where browsers stop accepting writes to one origin. Not a real limit
   -- it varies by browser and by how much else the origin has stored -- so it is
   used to warn early rather than to refuse anything. */
export const STORAGE_BUDGET = 4_500_000;

export type SaveResult =
  | { ok: true; bytes: number; nearlyFull: boolean }
  | { ok: false; reason: "quota" | "unavailable" | "corrupt"; bytes: number };

/* Saving used to swallow its own failure.
 *
 * Every conversation and every memory lives in one localStorage key, and it only
 * grows. When the browser finally refuses the write, the old code logged to a
 * console nobody has open and carried on -- so the app kept working perfectly
 * for the rest of the session and lost every word of it on reload, with no
 * indication at any point that anything was wrong. For something whose whole
 * promise is that it remembers you, that is the worst failure in the product.
 *
 * It now reports, and the caller is expected to say something. */
/** rev first, so the revision can be read off the front without parsing megabytes. */
export function serialiseState(state: SoloState): string {
  const { corrupt: _corrupt, ...rest } = state;
  void _corrupt;
  return JSON.stringify({ rev: state.rev ?? 0, ...rest });
}

export function saveState(state: SoloState): SaveResult {
  /* Refuse to overwrite data we failed to read. The user is told, and can take
     the file out of the browser's storage by hand if they want it back. */
  if (state.corrupt) return { ok: false, reason: "corrupt", bytes: 0 };

  let serialised: string;
  try {
    serialised = serialiseState(state);
  } catch (err) {
    console.error("solo save failed to serialise", err);
    return { ok: false, reason: "unavailable", bytes: 0 };
  }

  const bytes = serialised.length;
  try {
    localStorage.setItem(KEY, serialised);
    return { ok: true, bytes, nearlyFull: bytes > STORAGE_BUDGET };
  } catch (err) {
    /* QuotaExceededError is name-checked rather than instanceof-checked: Safari
       throws a differently-named error for the same condition, and private
       browsing throws on write even with space to spare. */
    const name = err instanceof Error ? err.name : "";
    const quota = /quota/i.test(name) || name === "NS_ERROR_DOM_QUOTA_REACHED";
    console.error("solo save failed", name, bytes);
    return { ok: false, reason: quota ? "quota" : "unavailable", bytes };
  }
}

/** Built-ins are not persisted — they ship with the build, so storing copies
 *  would freeze them at whatever they were when someone first visited. Any
 *  changes the user has made to one are replayed over the top instead. */
export function allMuses(state: SoloState): SoloMuse[] {
  const edits = state.edits ?? {};
  return [
    ...state.muses,
    ...builtinMuses().map((m) => (edits[m.id] ? applyPatch(m, edits[m.id]) : m)),
  ];
}

export function findMuse(state: SoloState, id: string): SoloMuse | undefined {
  return allMuses(state).find((m) => m.id === id);
}

/** Which home-screen tab someone sits under. Anyone whose category is not one
 *  of the starter tabs -- built from an export, a public figure, invented --
 *  goes under the user's own. */
export function tabOf(m: SoloMuse): string {
  return TABS.some((t) => t.id === m.category) ? m.category : MADE_TAB;
}

export function inTab(state: SoloState, tab: string): SoloMuse[] {
  return allMuses(state).filter((m) => tabOf(m) === tab);
}

/* What the prompt reads for this person.
 *
 * Traits live on the card, where the edit screen writes them, and the model
 * reads `persona` -- which never had them. So every trait anyone ever edited
 * was saved, shown, and ignored. Joined here, at send time, so there is still
 * only one copy of them. `you` is filled the same way: the starters are
 * authored without knowing who will read them. */
export function promptPersona(m: SoloMuse, userName: string | null): PersonaDraft | null {
  if (!m.persona) return null;
  return {
    ...m.persona,
    you: m.persona.you || userName || "them",
    traits: (m.traits ?? []).slice(0, 8).map((t) => t.slice(0, 30)),
  };
}

/** The memories worth sending with this turn (§13). Lexical, since solo mode
 *  has no embeddings; the gate is the same absolute threshold rankMemories
 *  applies whenever it is scoring lexically. */
/* Is there anything in this to recall against?
 *
 * "hmm", "yeah", "ok" carry no subject, but they still produce a vector, and
 * that vector still lands nearest to something -- measured, "hmm" scored 0.704
 * against "User has been trying to quit smoking", higher than a genuinely
 * relevant query scored on its right answer. A character bringing up your
 * smoking because you said "hmm" is worse than one that says nothing.
 *
 * It is also most of the latency saved: embedding the query costs about half a
 * second, and a good share of messages in a real conversation are exactly these.
 */
const FILLER = new Set(
  ("the and but for you your are was were have has had will would just like they them there here" +
   " what when where which who how why not now all any some more most very too also then than" +
   " because get got know think want need tell said say going really okay yeah yes nope nah" +
   " hai hain ho hu tum tera mera main kya kar karo raha rahi rahe kuch nahi nhi yeh woh toh" +
   " bhi abhi phir aur bas sab agar lekin acha arre yaar hmm hmmm mmm lol haan").split(/\s+/)
);

export function worthRecalling(query: string): boolean {
  return query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .some((w) => w.length > 3 && !FILLER.has(w));
}

export function relevantMemories(
  state: SoloState,
  museId: string,
  query: string,
  /* When present, ranking compares meaning instead of shared words. Word
     overlap missed three of five ordinary paraphrases -- "my puppy chewed the
     sofa" never reached "User's dog is called Bruno". */
  queryEmbedding?: number[] | null
): string[] {
  const mine: RankableMemory[] = state.memories
    .filter((m) => m.museId === museId)
    .map((m) => ({
      id: m.id,
      content: m.content,
      type: m.type,
      importance: m.importance,
      confidence: m.confidence,
      embedding: m.embedding ?? null,
      createdAt: new Date(m.createdAt),
      lastRetrievedAt: null,
    }));

  if (!mine.length) return [];
  /* rankMemories uses embeddings only when the query AND every memory has one,
     because mixing cosine and overlap scores in a single ranking compares
     incomparable scales. Until a backfill finishes, that means lexical. */
  return rankMemories(query, mine, { limit: 8, queryEmbedding: queryEmbedding ?? undefined })
    .map((r) => r.memory.content);
}

/** Most memories the chat route accepts in one turn. */
export const MEMORIES_PER_TURN = 12;
/* Kinds of memory that do not go stale the way a plan, a job or a mood does. */
const STABLE = new Set(["PERMANENT", "RELATIONSHIP"]);

/* What someone has in mind when they reply to you.
 *
 * Retrieval alone was not enough. It only surfaces what matches the last few
 * messages, so a fact that matters to everything -- "User is working from home
 * this week" -- was invisible the moment the talk moved on to lunch. Reported
 * exactly that way: told she was working from home, the character asked a few
 * messages later whether she was in the office.
 *
 * A person does not look up where you work before each sentence. So the most
 * important standing facts and the most recent things you said are always to
 * hand, and retrieval adds what the conversation calls up on top. */
export function memoriesForTurn(
  state: SoloState,
  museId: string,
  query: string,
  queryEmbedding?: number[] | null,
  opts: {
    /* In a circle: anything not learned in this one is marked (private), and
       the prompt says not to repeat it to the room. */
    room?: string;
    now?: number;
  } = {}
): string[] {
  const now = opts.now ?? Date.now();
  /* Plans near enough to matter go through plansForTurn, with their status. */
  /* Inside jokes go separately, through sharedForTurn: they are not facts to
     rank against the subject, and they would crowd out the ones that are. */
  const mine = state.memories.filter((m) => m.museId === museId && !isPlan(m, now) && m.type !== "SHARED" && m.type !== "PROMISE");
  if (!mine.length) return [];
  const byContent = new Map(mine.map((m) => [m.content, m]));
  /* Marked as private (learned outside this room) and, for anything that can go
     stale, as told a while ago -- people change jobs, cities and minds, and the
     character should hold an old fact loosely rather than state it as current. */
  const label = (m: SoloMemory | undefined, c: string) => {
    const old = m && !STABLE.has(m.type) ? Math.floor((now - Date.parse(m.createdAt)) / (30 * 86_400_000)) : 0;
    const aged = old >= 3 ? `${c} (told about ${old} months ago; may have changed)` : c;
    return opts.room !== undefined && m?.circleId !== opts.room ? `(private) ${aged}` : aged;
  };

  const newest = [...mine].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  /* Who they are rather than what happened: events are what retrieval is for. */
  const standing = newest
    .filter((m) => m.type !== "EVENT")
    .sort((a, b) => b.importance - a.importance)
    .slice(0, 4);

  const out: string[] = [];
  const seen = new Set<string>();
  const add = (c: string) => {
    const k = c.trim().toLowerCase();
    if (!k || seen.has(k) || out.length >= MEMORIES_PER_TURN) return;
    seen.add(k);
    out.push(c);
  };
  for (const m of standing) add(m.content);
  /* Only the two newest regardless of topic; the rest come in by relevance. */
  for (const m of newest.slice(0, 2)) add(m.content);
  for (const c of relevantMemories(state, museId, query, queryEmbedding)) if (byContent.has(c)) add(c);
  return out.map((c) => label(byContent.get(c), c));
}

/* How far either side of now a dated memory counts as a plan, rather than as
   something that happened once and is simply a fact now. */
const PLAN_PAST_MS = 14 * 24 * 3600_000;
const PLAN_AHEAD_MS = 90 * 24 * 3600_000;
const PLANS_PER_TURN = 8;

function isPlan(m: SoloMemory, now: number): boolean {
  if (!m.at) return false;
  const t = Date.parse(m.at);
  return Number.isFinite(t) && t > now - PLAN_PAST_MS && t < now + PLAN_AHEAD_MS;
}

/** Dated plans and events for this turn, nearest first, each with its moment. */
export function plansForTurn(
  state: SoloState,
  museId: string,
  opts: { room?: string; now?: number } = {}
): { what: string; at: string }[] {
  const now = opts.now ?? Date.now();
  return state.memories
    .filter((m) => m.museId === museId && isPlan(m, now))
    .sort((a, b) => Math.abs(Date.parse(a.at!) - now) - Math.abs(Date.parse(b.at!) - now))
    .slice(0, PLANS_PER_TURN)
    .map((m) => ({
      what: (opts.room !== undefined && m.circleId !== opts.room ? "(private) " : "") + m.content,
      at: m.at!,
    }));
}

/* How much of the conversation goes with each turn.
 *
 * It was the last twenty messages. A character texting in bursts sends three
 * or four per reply, so twenty was about five exchanges -- something said ten
 * minutes ago had already fallen out of what the model could see. Measured by
 * size now, up to what the routes accept. */
export const WINDOW_MESSAGES = 60;
export const WINDOW_CHARS = 24_000;

export function windowOf<T extends { content: string }>(
  log: T[],
  maxMessages = WINDOW_MESSAGES,
  maxChars = WINDOW_CHARS
): T[] {
  const out: T[] = [];
  let chars = 0;
  for (let i = log.length - 1; i >= 0 && out.length < maxMessages; i--) {
    chars += Math.min(log[i].content.length, 8000);
    /* Always keep the newest, whatever it costs: it is what is being answered. */
    if (chars > maxChars && out.length) break;
    out.unshift(log[i]);
  }
  return out;
}

/** Memories with no vector yet, oldest first, for backfilling in batches. */
export function needsEmbedding(state: SoloState, museId: string, limit = 32): SoloMemory[] {
  return state.memories
    .filter((m) => m.museId === museId && !m.embedding?.length)
    .slice(0, limit);
}

/** Attaches vectors to memories by id, ignoring any that failed. */
export function attachEmbeddings(
  state: SoloState,
  vectors: Record<string, number[] | null>
): SoloState {
  return {
    ...state,
    memories: state.memories.map((m) =>
      vectors[m.id]?.length ? { ...m, embedding: vectors[m.id] as number[] } : m
    ),
  };
}

/* A memory is one fact in one sentence. Nothing enforced that, so the model
   could write a paragraph and it was stored verbatim -- which then made every
   later extraction request fail validation, permanently. Clamped at the only
   place memories are created. */
export const MEMORY_CHARS = 400;

/* Memories are never deleted otherwise, so a character talked to for a year
   accumulates thousands, every one of them ranked on every single turn. Kept to
   what a person would plausibly hold: the most important, and within that the
   most recent. */
export const MEMORIES_PER_MUSE = 300;

/* What is between the two of them: nicknames, running jokes, bits.
 *
 * Not ranked by the subject, because the point of an inside joke is that it
 * turns up when nobody was talking about it. The newest few always, and a
 * couple of older ones that change from day to day, so an old joke comes back
 * now and then instead of the same three forever. */
export function sharedForTurn(state: SoloState, museId: string, now = Date.now(), n = 5): string[] {
  const all = state.memories
    .filter((m) => m.museId === museId && m.type === "SHARED")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (all.length <= n) return all.map((m) => m.content);
  const fresh = all.slice(0, 3);
  const older = all.slice(3);
  const day = Math.floor(now / 86_400_000);
  const picked = Array.from({ length: Math.min(n - fresh.length, older.length) }, (_, i) => older[(day * 7 + i * 13) % older.length]);
  return [...new Set([...fresh, ...picked])].map((m) => m.content);
}

/* What they have said about this character to the others: their own lines in
 * other one-to-one chats from the last two weeks, and what the others remember,
 * wherever the character is named. Without it, "Maya proposed to Kabir" told to
 * Rhea was news to Maya and to Kabir. The prompt sorts out who would know what
 * (heardBlock): what happened to you, you were there for.
 * ponytail: first-name match, so someone in their life who shares the name is
 * caught too; tag people per memory if that turns out to matter. */
export function heardForTurn(state: SoloState, museId: string, now = Date.now()): string[] {
  const first = findMuse(state, museId)?.name.trim().split(/\s+/)[0] ?? "";
  if (first.length < 3) return [];
  const named = new RegExp(`(^|[^\\p{L}])${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}])`, "iu");
  const nameOf = (id: string) => {
    const circle = (state.circles ?? []).find((c) => c.id === id);
    return findMuse(state, id)?.name ?? (circle ? `the group "${circle.name}"` : "someone");
  };
  const said = Object.entries(state.conversations)
    .filter(([id]) => id !== museId)
    .flatMap(([id, log]) => log
      .filter((m) => m.from === "user" && named.test(m.content) && now - Date.parse(m.at) < 14 * 86_400_000)
      .map((m) => ({ at: m.at, line: `to ${nameOf(id)}: "${m.content.slice(0, 280)}"` })));
  const known = state.memories
    .filter((m) => m.museId !== museId && m.type !== "PROMISE" && named.test(m.content))
    .map((m) => ({ at: m.createdAt, line: `${nameOf(m.museId)} remembers: ${m.content.slice(0, 280)}` }));
  return [...said.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 6), ...known.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 6)]
    .map((x) => x.line);
}

/* Something they told this character a while ago, to bring up unprompted --
 * "wait, did your sister ever hear back?". Only when the conversation picks up
 * again after a few hours, so it opens a conversation rather than interrupting
 * one, and a different one each day. */
export function callbackForTurn(state: SoloState, museId: string, now = Date.now()): { what: string; days: number } | null {
  const log = state.conversations[museId] ?? [];
  const lastTheirs = log.findLast((m) => m.from !== "user");
  if (lastTheirs && now - Date.parse(lastTheirs.at) < 3 * 3_600_000) return null;
  const old = state.memories.filter((m) =>
    m.museId === museId && (m.type === "EVENT" || m.type === "GOAL") && !isPlan(m, now) && now - Date.parse(m.createdAt) >= 5 * 86_400_000);
  if (!old.length) return null;
  const m = old[Math.floor(now / 86_400_000) % old.length];
  return { what: m.content.slice(0, 300), days: Math.floor((now - Date.parse(m.createdAt)) / 86_400_000) };
}

/* What the Muse said it would tell them later and has not yet. With how long
   ago, because "remind me to tell you" means something different after five
   minutes and after a day. */
export function promisesForTurn(state: SoloState, museId: string, now = Date.now()): { what: string; ago: number }[] {
  return state.memories
    .filter((m) => m.museId === museId && m.type === "PROMISE" && !m.circleId)
    .map((m) => ({ what: m.content, ago: now - Date.parse(m.createdAt) }))
    /* Owed for up to three days; past that it has quietly lapsed, as it would. */
    .filter((p) => Number.isFinite(p.ago) && p.ago < 3 * 86_400_000)
    .slice(-3);
}

/* The end of someone's own one-to-one chat with the user, for when they are in
 * a group. Memory alone carried only distilled facts, so a person who had just
 * spent an hour talking to you walked into the group knowing "User works at a
 * bank" and nothing about the last hour. This is theirs -- only their own chat,
 * never anyone else's -- and only the recent end of it. */
export function recentOneToOne(
  state: SoloState,
  museId: string,
  now = Date.now(),
  opts: { messages?: number; chars?: number } = {}
): { from: "user" | "muse"; content: string; at: string }[] {
  const max = opts.messages ?? 30;
  let budget = opts.chars ?? 6000;
  const shown = (state.conversations[museId] ?? []).filter((m) => !m.showAt || Date.parse(m.showAt) <= now);
  const out: { from: "user" | "muse"; content: string; at: string }[] = [];
  for (let i = shown.length - 1; i >= 0 && out.length < max; i--) {
    const content = shown[i].content.slice(0, 500);
    if (content.length > budget) break;
    budget -= content.length;
    out.unshift({ from: shown[i].from, content, at: shown[i].at });
  }
  return out;
}

export function addMemories(
  state: SoloState,
  museId: string,
  incoming: {
    content: string; type: string; importance: number; confidence: number;
    /* Indexes into `known` that this fact makes untrue. */
    replaces?: number[];
    /** The moment a plan or event is for, already resolved to ISO by the route. */
    when?: string | null;
  }[],
  /* The list the indexes point into -- exactly what was sent for extraction, in
     the same order. Without it a `replaces` index means nothing. */
  known: string[] = [],
  /** Where it was learned. Absent: one to one. */
  where: { circleId?: string } = {}
): SoloState {
  const alreadyHave = new Set(
    state.memories.filter((m) => m.museId === museId).map((m) => m.content.trim().toLowerCase())
  );
  /* Anything the user has thrown away stays thrown away, even when the
     conversation that produced it is still in the extraction window. */
  const tombstoned = new Set(state.forgotten?.[museId] ?? []);

  const fresh = incoming
    .map((m) => ({ ...m, content: (m.content || "").trim().slice(0, MEMORY_CHARS) }))
    .filter(
      (m) =>
        m.content &&
        !alreadyHave.has(m.content.toLowerCase()) &&
        !tombstoned.has(m.content.toLowerCase())
    );
  if (!fresh.length) return state;

  /* DONE only closes a promise, through `replaces`; it is not a memory. */
  const added: SoloMemory[] = fresh.filter((m) => m.type !== "DONE").map((m, i) => ({
    id: `mem-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}`,
    museId,
    content: m.content,
    type: m.type,
    importance: m.importance,
    confidence: m.confidence,
    createdAt: new Date().toISOString(),
    ...(typeof m.when === "string" && Number.isFinite(Date.parse(m.when)) ? { at: new Date(m.when).toISOString() } : {}),
    ...(where.circleId ? { circleId: where.circleId } : {}),
  }));

  /* Things that have stopped being true.
   *
   * People change jobs, leave cities, quit smoking. Without this the old fact
   * simply stayed alongside the new one and both were injected into the same
   * prompt -- measured: a user who said they had quit engineering for
   * photography ended up with a character holding "User works as a structural
   * engineer" and "User is now a full-time photographer" at once, with nothing
   * marking either as dead.
   *
   * Superseded memories are deleted rather than flagged, and tombstoned like
   * any other deletion, so the conversation that produced them cannot put them
   * straight back. */
  const superseded = new Set<string>();
  for (const m of fresh) {
    for (const i of m.replaces ?? []) {
      const stale = known[i];
      if (stale) superseded.add(stale.trim().toLowerCase());
    }
  }

  const survives = (m: SoloMemory) =>
    m.museId !== museId || !superseded.has(m.content.trim().toLowerCase());

  const mine = [
    ...state.memories.filter((m) => m.museId === museId && survives(m)),
    ...added,
  ];
  const others = state.memories.filter((m) => m.museId !== museId);

  /* `mine`, not `added` -- `others` is everyone else's memories, so appending
     only the new ones here would drop everything this character already knew on
     every successful extraction. */
  const forgotten = superseded.size
    ? {
        ...(state.forgotten ?? {}),
        [museId]: [...(state.forgotten?.[museId] ?? []), ...superseded].slice(-200),
      }
    : state.forgotten;

  if (mine.length <= MEMORIES_PER_MUSE) {
    return { ...state, memories: [...others, ...mine], forgotten };
  }

  /* Over the cap: keep the important ones, and break ties by recency. Dropping
     the least important thing said longest ago is the closest this gets to how
     forgetting actually works. */
  const kept = [...mine]
    .sort((a, b) => (b.importance - a.importance) || (Date.parse(b.createdAt) - Date.parse(a.createdAt)))
    .slice(0, MEMORIES_PER_MUSE);

  return { ...state, memories: [...others, ...kept], forgotten };
}

export function download(filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking synchronously cancels the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(href), 0);
}


/* ------------------------------------------------ correcting what they know */

/* A character's memories were invisible and permanent.
 *
 * The card said "remembers 12" and there was no way to see what those twelve
 * were. A wrong one -- a sister's name misheard, a job the user left -- sat
 * there shaping every reply, and the only way out was deleting the character
 * and everything they knew along with it. For a product whose whole promise is
 * that it remembers you, being unable to look at or correct that is the gap
 * that matters most.
 *
 * The database-backed app has had this since the start (PATCH and DELETE on
 * /api/memories/:id); solo mode, which is what anyone actually uses, had
 * neither. These are the same semantics, locally.
 */

/** Rewriting something a character got wrong. */
export function editMemory(
  state: SoloState,
  memoryId: string,
  patch: { content?: string; importance?: number }
): SoloState {
  return {
    ...state,
    memories: state.memories.map((m) => {
      if (m.id !== memoryId) return m;
      const content = patch.content?.trim().slice(0, MEMORY_CHARS);
      return {
        ...m,
        ...(content ? { content } : {}),
        ...(patch.importance ? { importance: Math.min(5, Math.max(1, patch.importance)) } : {}),
        /* Typed by the person it is about, so there is nothing to be unsure of.
           Confidence is a ranking weight, so this also makes a corrected memory
           beat the guess it replaced. */
        ...(content ? { confidence: 1 } : {}),
      };
    }),
  };
}

/** Forgetting one thing, permanently. */
/** Whether a memory mentions this word or phrase, whole words only: "goa" is not "goal". */
export function mentions(content: string, about: string): boolean {
  const q = about.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return !!q && new RegExp(`(^|[^\\p{L}\\p{N}])${q}($|[^\\p{L}\\p{N}])`, "iu").test(content);
}

export function deleteMemory(state: SoloState, memoryId: string): SoloState {
  const going = state.memories.find((m) => m.id === memoryId);
  if (!going) return state;

  const key = going.content.trim().toLowerCase();
  const before = state.forgotten?.[going.museId] ?? [];
  /* Capped, and oldest-first, because this list is only ever appended to.
     Two hundred is far more than anyone will correct by hand, and a tombstone
     that has fallen off is one the conversation has long since moved past. */
  const after = [...before.filter((k) => k !== key), key].slice(-200);

  return {
    ...state,
    memories: state.memories.filter((m) => m.id !== memoryId),
    forgotten: { ...(state.forgotten ?? {}), [going.museId]: after },
  };
}

/** Everything one character knows, newest first. */
export function memoriesOf(state: SoloState, museId: string): SoloMemory[] {
  return state.memories
    .filter((m) => m.museId === museId)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/** Clears one character's memories without touching the conversation. Kept
 *  separate from deleteConversation: forgetting what someone learned about you
 *  and deleting what you said are different things to want. */
export function forgetAll(state: SoloState, museId: string): SoloState {
  const keys = state.memories
    .filter((m) => m.museId === museId)
    .map((m) => m.content.trim().toLowerCase());

  return {
    ...state,
    memories: state.memories.filter((m) => m.museId !== museId),
    forgotten: {
      ...(state.forgotten ?? {}),
      [museId]: [...(state.forgotten?.[museId] ?? []), ...keys].slice(-200),
    },
  };
}


/* ------------------------------------------------------------- restoring */

/* The other half of "Export everything".
 *
 * That button wrote the entire state to a JSON file and nothing in the app
 * could ever read it back -- the only file input anywhere parses WhatsApp
 * exports. So the one safety net the product offered was a file you could not
 * use, and a user who backed up religiously still lost everything to a cleared
 * browser. With no accounts and a storage ceiling that will eventually be hit,
 * this is what makes the data recoverable at all.
 */
export interface RestoreSummary {
  people: number;
  messages: number;
  memories: number;
  circles: number;
}

export type RestoreResult =
  | { ok: true; state: SoloState; summary: RestoreSummary }
  | { ok: false; error: string };

/** Parses and validates an exported backup. Structural only -- the point is to
 *  refuse a file that would corrupt the app, not to police its contents. */
export function parseBackup(text: string): RestoreResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "That file isn't readable JSON. Pick the file the export button made." };
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "That doesn't look like a MUSE backup." };
  }
  const p = raw as Partial<SoloState>;

  /* A chat export dropped in here by mistake is the likely wrong file, and it
     has none of these. Checking two keys distinguishes them without demanding a
     backup from a newer version match exactly. */
  if (!Array.isArray(p.muses) || typeof p.conversations !== "object" || p.conversations === null) {
    return { ok: false, error: "That doesn't look like a MUSE backup — it has no people or conversations in it." };
  }

  const conversations: Record<string, SoloMessage[]> = {};
  for (const [id, log] of Object.entries(p.conversations as Record<string, unknown>)) {
    if (!Array.isArray(log)) continue;
    conversations[id] = log.filter(
      (m): m is SoloMessage =>
        Boolean(m) && typeof m === "object" &&
        typeof (m as SoloMessage).content === "string" &&
        ((m as SoloMessage).from === "user" || (m as SoloMessage).from === "muse")
    );
  }

  const muses = (p.muses as SoloMuse[]).filter(
    (m) => m && typeof m.id === "string" && typeof m.name === "string"
  ).map(migrate);

  const memories = Array.isArray(p.memories)
    ? (p.memories as SoloMemory[]).filter(
        (m) => m && typeof m.content === "string" && typeof m.museId === "string"
      )
    : [];

  const state: SoloState = {
    userName: typeof p.userName === "string" ? p.userName : null,
    muses,
    conversations,
    memories,
    vibes: (p.vibes as SoloState["vibes"]) ?? {},
    circles: Array.isArray(p.circles) ? (p.circles as SoloCircle[]) : [],
    edits: (p.edits as SoloState["edits"]) ?? {},
    feelings: (p.feelings as SoloState["feelings"]) ?? {},
  };
  /* Everything added since -- closeness, their life, secrets, the scrapbook,
     what was forgotten -- comes back too. Restoring used to keep only the above and
     quietly lose the rest, including the record that stops a deleted memory
     being learned again. */
  for (const k of ["forgotten", "lives", "unlocked", "scores", "started", "cutoffs", "digests", "bank", "scrapbook", "stories"] as const) {
    const v = p[k];
    if (v && typeof v === "object" && !Array.isArray(v)) (state as unknown as Record<string, unknown>)[k] = v;
  }
  if (p.place && typeof p.place === "object") state.place = p.place as SoloState["place"];
  for (const k of ["pinned", "archived"] as const) if (Array.isArray(p[k])) state[k] = (p[k] as unknown[]).filter((x): x is string => typeof x === "string");

  return {
    ok: true,
    state,
    summary: {
      /* Built characters only. The starters ship with the build and are not in
         the backup, so counting them would overstate what is being restored. */
      people: muses.length,
      messages: Object.values(conversations).reduce((n, l) => n + l.length, 0),
      memories: memories.length,
      circles: state.circles?.length ?? 0,
    },
  };
}

/** How much room the saved state is taking, for warning before it runs out. */
export function storageBytes(): number {
  try {
    return localStorage.getItem(KEY)?.length ?? 0;
  } catch {
    return 0;
  }
}


/* ------------------------------------------------------------- circles */

export function circleOf(state: SoloState, id: string): SoloCircle | undefined {
  return state.circles?.find((c) => c.id === id);
}

/** The Muses in a circle, in membership order, skipping any since deleted. */
export function membersOf(state: SoloState, circle: SoloCircle): SoloMuse[] {
  return circle.memberIds
    .map((id) => findMuse(state, id))
    .filter((m): m is SoloMuse => Boolean(m));
}

/** Everyone this Muse knows: the other members of every circle they are in.
 *  Deduplicated, since two people can share more than one circle. */
export function knownTo(state: SoloState, museId: string): SoloMuse[] {
  const ids = new Set<string>();
  for (const c of state.circles ?? []) {
    if (!c.memberIds.includes(museId)) continue;
    for (const id of c.memberIds) if (id !== museId) ids.add(id);
  }
  return [...ids].map((id) => findMuse(state, id)).filter((m): m is SoloMuse => Boolean(m));
}

/* ------------------------------------------------- editing and deleting */

export function editMessage(
  state: SoloState,
  threadId: string,
  messageId: string,
  content: string
): SoloState {
  const log = state.conversations[threadId] ?? [];
  return {
    ...state,
    conversations: {
      ...state.conversations,
      [threadId]: log.map((m) =>
        m.id === messageId ? { ...m, content, edited: true } : m
      ),
    },
  };
}

export function deleteMessage(state: SoloState, threadId: string, messageId: string): SoloState {
  const log = state.conversations[threadId] ?? [];
  return {
    ...state,
    conversations: { ...state.conversations, [threadId]: log.filter((m) => m.id !== messageId) },
  };
}

/** Everything from this message onward. Useful for taking a conversation back
 *  to a fork rather than deleting one line out of the middle of it. */
export function deleteFrom(state: SoloState, threadId: string, messageId: string): SoloState {
  const log = state.conversations[threadId] ?? [];
  const at = log.findIndex((m) => m.id === messageId);
  if (at < 0) return state;
  return {
    ...state,
    conversations: { ...state.conversations, [threadId]: log.slice(0, at) },
  };
}

/** Everything after this message goes, the message itself stays. What an edit
 *  that should change the conversation does before asking for a new reply. */
export function rewindTo(state: SoloState, threadId: string, messageId: string): SoloState {
  const log = state.conversations[threadId] ?? [];
  const at = log.findIndex((m) => m.id === messageId);
  if (at < 0) return state;
  return {
    ...state,
    conversations: { ...state.conversations, [threadId]: log.slice(0, at + 1) },
  };
}

/* Replies land after the message they were written to, not at the end.
 *
 * Someone who double-texts while a reply is being written has sent something
 * the reply never saw. Appending would put an answer to the first message
 * underneath the second, and leave the last line of the thread a Muse's -- so
 * nothing would ever answer the second one. Placed after the anchor, the
 * unanswered message stays last and gets its own turn. */
export function insertAfter(
  state: SoloState,
  threadId: string,
  anchorId: string | undefined,
  msgs: SoloMessage[]
): SoloState {
  const log = state.conversations[threadId] ?? [];
  const at = anchorId ? log.findIndex((m) => m.id === anchorId) : -1;
  const next = at < 0 ? [...log, ...msgs] : [...log.slice(0, at + 1), ...msgs, ...log.slice(at + 1)];
  return { ...state, conversations: { ...state.conversations, [threadId]: next } };
}

export function editCircle(
  state: SoloState,
  circleId: string,
  patch: Partial<Pick<SoloCircle, "topic" | "traits">>
): SoloState {
  return {
    ...state,
    circles: (state.circles ?? []).map((c) => (c.id === circleId ? { ...c, ...patch } : c)),
  };
}


/** Clears one thread. `alsoForget` drops what was learned in it too — deleting
 *  a conversation while the Muse still remembers every word of it is not what
 *  anybody means by delete, but the two are separable and worth asking about. */
export function deleteConversation(
  state: SoloState,
  threadId: string,
  alsoForget: boolean
): SoloState {
  const conversations = { ...state.conversations };
  delete conversations[threadId];
  /* Clearing a chat keeps how close you are: its points are banked first. Clearing
     chat and memories forgets that too. (Calls stay counted on their own.) */
  const bank = { ...(state.bank ?? {}) };
  /* Clearing chat and memories forgets the scrapbook too; clearing the chat keeps it. */
  const scrapbook = { ...(state.scrapbook ?? {}) };
  if (alsoForget) delete scrapbook[threadId];
  if (alsoForget) delete bank[threadId];
  else if (findMuse(state, threadId)) {
    const st = storyOf(state, threadId, Date.now(), Intl.DateTimeFormat().resolvedOptions().timeZone);
    bank[threadId] = (bank[threadId] ?? 0) + st.yours + 12 * st.daysTalked;
  }
  return {
    ...state,
    conversations,
    bank,
    scrapbook,
    memories: alsoForget ? state.memories.filter((m) => m.museId !== threadId) : state.memories,
  };
}

/** Removes a Muse you built, with its conversation and memories. Built-ins
 *  cannot be removed: they come from the build, not from storage. */
export function deleteMuse(state: SoloState, museId: string): SoloState {
  const conversations = { ...state.conversations };
  delete conversations[museId];
  return {
    ...state,
    muses: state.muses.filter((m) => m.id !== museId),
    conversations,
    memories: state.memories.filter((m) => m.museId !== museId),
    vibes: Object.fromEntries(Object.entries(state.vibes ?? {}).filter(([k]) => k !== museId)),
    scrapbook: Object.fromEntries(Object.entries(state.scrapbook ?? {}).filter(([k]) => k !== museId)),
    feelings: Object.fromEntries(Object.entries(state.feelings ?? {}).filter(([k]) => k !== museId)),
    edits: Object.fromEntries(Object.entries(state.edits ?? {}).filter(([k]) => k !== museId)),
    forgotten: Object.fromEntries(Object.entries(state.forgotten ?? {}).filter(([k]) => k !== museId)),
    circles: (state.circles ?? [])
      .map((c) => ({ ...c, memberIds: c.memberIds.filter((id) => id !== museId) }))
      /* A circle needs two people to be a circle. */
      .filter((c) => c.memberIds.length >= 2),
  };
}

/** Removes a circle and its thread. The people in it are untouched. */
export function deleteCircle(state: SoloState, circleId: string): SoloState {
  const conversations = { ...state.conversations };
  delete conversations[circleId];
  return {
    ...state,
    conversations,
    circles: (state.circles ?? []).filter((c) => c.id !== circleId),
  };
}

/* ------------------------------------------------- editing who they are */

/* What the user is allowed to change about a Muse.
 *
 * Every field here exists twice: once on the card, where it is display, and
 * once inside `persona`, which is what the model actually reads. They are kept
 * in step by applyPatch rather than by the caller, because letting a rename
 * update the card and not the prompt would produce someone who is called Maya
 * on screen and answers to a different name.
 */
export interface MusePatch {
  name?: string;
  /** Which tab they sit under on the home screen. */
  category?: string;
  relationshipType?: string;
  description?: string;
  traits?: string[];
  /** WHO YOU ARE — the voice profile. */
  brief?: string;
  /** Verbatim messages the model copies the texture of. */
  samples?: string;
  /** Behaviour, in the user's own words. */
  extra?: string;
  arch?: string;
  texture?: string;
  /** The voice they speak in on a call. */
  voiceId?: string;
  /** Their picture; null takes it away. */
  avatar?: MuseAvatar | null;
}

/* A character's picture, kept in IndexedDB beside the photos. `made`: drawn
   for them by the app, rather than chosen by the user. */
export interface MuseAvatar { id: string; made?: boolean }

/** Fields that were explicitly set, so an untouched field is left alone and a
 *  deliberately-emptied one is honoured. */
function defined<T extends object>(patch: T): Partial<T> {
  return Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export function applyPatch(m: SoloMuse, patch: MusePatch): SoloMuse {
  const p = defined(patch);
  const merged: SoloMuse = { ...m, ...p };

  /* A character with no profile at all -- one built before the Presence port,
     whose customInstructions were too thin for migrate() to rebuild from. If
     the user has now written a brief, that is enough to give them one, which
     turns this screen into the way to rescue those rather than start again. */
  if (!m.persona) {
    if (!merged.brief?.trim()) return merged;
    return {
      ...merged,
      persona: {
        them: merged.name,
        you: "",
        relationship: merged.relationshipType || "someone close",
        arch: merged.arch ?? "other",
        texture: merged.texture ?? "close",
        mode: "character",
        brief: merged.brief,
        samples: merged.samples,
        extra: merged.extra,
      },
    };
  }

  return {
    ...merged,
    persona: {
      ...m.persona,
      them: merged.name,
      relationship: merged.relationshipType,
      arch: p.arch ?? m.persona.arch,
      texture: p.texture ?? m.persona.texture,
      brief: p.brief ?? m.persona.brief,
      samples: p.samples ?? m.persona.samples,
      extra: p.extra ?? m.persona.extra,
    },
  };
}

/** Edits a Muse, whoever owns it.
 *
 *  A built character is stored, so it is changed in place. A starter is not --
 *  it comes from the build, and storing a copy would freeze it at whatever it
 *  was the day someone first opened the app. So a starter's changes are kept as
 *  an overlay against its id and replayed by allMuses.
 *
 *  Keeping the id either way is the point: the conversation, the memories, the
 *  circles and the vibe are all keyed by it, so editing someone never costs you
 *  the history you have with them. */
export function editMuse(state: SoloState, museId: string, patch: MusePatch): SoloState {
  if (state.muses.some((m) => m.id === museId)) {
    return { ...state, muses: state.muses.map((m) => (m.id === museId ? applyPatch(m, patch) : m)) };
  }
  return {
    ...state,
    edits: {
      ...(state.edits ?? {}),
      [museId]: { ...(state.edits?.[museId] ?? {}), ...defined(patch) },
    },
  };
}

/** Puts a starter back to how it shipped. Only meaningful for a starter: a
 *  built character has no original to go back to.
 *
 *  Clears the standing state as well as the profile. They shipped without one,
 *  and a reset that leaves "prickly, a bit off with you" sitting in the header
 *  looks like the reset failed. The conversation and the memories are kept --
 *  those are the user's, not the character's. */
export function resetMuse(state: SoloState, museId: string): SoloState {
  const edits = { ...(state.edits ?? {}) };
  const feelings = { ...(state.feelings ?? {}) };
  delete edits[museId];
  delete feelings[museId];
  return { ...state, edits, feelings };
}

export function isEdited(state: SoloState, museId: string): boolean {
  return Boolean(state.edits?.[museId] && Object.keys(state.edits[museId]).length);
}

/* --------------------------------------------------------- how they feel */

export function feelingsOf(state: SoloState, museId: string): Feelings {
  return state.feelings?.[museId] ?? DEFAULT_FEELINGS;
}

export function setFeelings(state: SoloState, museId: string, feelings: Feelings): SoloState {
  return { ...state, feelings: { ...(state.feelings ?? {}), [museId]: feelings } };
}

/* ------------------------------------------------------------------ calls */

export function newCallId(): string {
  return `call-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** A call that has just been answered. Written straight away, so a call the
 *  browser kills halfway through still leaves a record. */
export function startCall(state: SoloState, museId: string, id: string, at = new Date()): SoloState {
  const call: SoloCall = { id, museId, startedAt: at.toISOString(), durationSeconds: 0, status: "CANCELLED" };
  return { ...state, calls: [...(state.calls ?? []), call] };
}

/** Closes a call: when, how long, how it ended, and which messages were said on it. */
export function endCall(
  state: SoloState,
  id: string,
  status: CallStatus,
  at = new Date()
): SoloState {
  const calls = state.calls ?? [];
  const call = calls.find((c) => c.id === id);
  if (!call) return state;
  const said = (state.conversations[call.museId] ?? []).filter((m) => m.callId === id);
  const ended: SoloCall = {
    ...call,
    endedAt: at.toISOString(),
    durationSeconds: Math.max(0, Math.round((at.getTime() - Date.parse(call.startedAt)) / 1000)),
    /* Nothing said either way is a call that never really happened. */
    status: status === "COMPLETED" && !said.length ? "CANCELLED" : status,
    firstMessageId: said[0]?.id,
    lastMessageId: said[said.length - 1]?.id,
  };
  return { ...state, calls: calls.map((c) => (c.id === id ? ended : c)) };
}

export function callsOf(state: SoloState, museId: string): SoloCall[] {
  return (state.calls ?? []).filter((c) => c.museId === museId);
}

/* ------------------------------------------------------------ pacing */

/* How long the next text in a burst takes to "type": longer for longer texts,
   never instant, never a wait. Stable per message, so a re-render does not move it. */
export function typingMs(m: { id: string; content: string }): number {
  let h = 0;
  for (let i = 0; i < m.id.length; i++) h = (h * 31 + m.id.charCodeAt(i)) | 0;
  const jitter = Math.abs(h) % 300;
  return Math.min(2400, Math.max(700, 500 + m.content.length * 18)) + jitter;
}

/** A burst, paced: the first text now (or after `after`), each next one after a typing pause. */
export function paced(parts: SoloMessage[], start = Date.now()): SoloMessage[] {
  let t = start;
  return parts.map((m, i) => {
    if (i > 0) t += typingMs(m);
    return { ...m, showAt: new Date(t).toISOString() };
  });
}

/** When the last text in a thread appears; texts still to come push a new burst back. */
export function lastShowAt(log: SoloMessage[]): number {
  return log.reduce((max, m) => (m.showAt ? Math.max(max, Date.parse(m.showAt)) : max), 0);
}

/* -------------------------------------------------------------- reactions */

export const REACTIONS = ["❤️", "😂", "😮", "😢", "🔥", "👍"];

/** Sets (or, the same emoji again, removes) one side's reaction to a message. */
export function react(state: SoloState, threadId: string, messageId: string, who: "user" | "muse", emoji: string | null): SoloState {
  const log = state.conversations[threadId] ?? [];
  return {
    ...state,
    conversations: {
      ...state.conversations,
      [threadId]: log.map((m) => {
        if (m.id !== messageId) return m;
        const next = { ...(m.reactions ?? {}) };
        if (!emoji || next[who] === emoji) delete next[who];
        else next[who] = emoji;
        return { ...m, reactions: Object.keys(next).length ? next : undefined };
      }),
    },
  };
}

/* A reply that opens with "[react: 😂]" is the Muse reacting to the message it
   answers. Returns the emoji and whatever text came after it. */
export function readReaction(text: string): { emoji: string | null; rest: string } {
  const m = /^\s*\[react:\s*([^\]\s]{1,8})\s*\]\s*/i.exec(text);
  return m ? { emoji: m[1], rest: text.slice(m[0].length).trim() } : { emoji: null, rest: text };
}

/* ------------------------------------------------------------------ media */

/* Besides texts, the Muse can send a voice note, a photo of what is in front of
 * them, or a song. Each is one message of a burst, opened with a tag:
 *
 *   [voice] arre sun na, aaj kya hua...
 *   [photo: half-eaten maggi in a steel bowl on my hostel bed]
 *   [song: Kun Faya Kun - A.R. Rahman]
 *
 * Which of them are on offer is decided before the turn (mediaAllowed) and
 * the prompt only mentions those. A tag that turns up anyway is not trusted:
 * the photo is dropped, the voice note is sent as the text it would have said. */
export type MediaPart =
  | { kind: "text"; text: string }
  | { kind: "voice"; text: string }
  /* `caption`: anything written after the tag in the same message, sent as a
     text of its own after it. */
  | { kind: "photo"; description: string; caption: string }
  | { kind: "song"; title: string; artist: string; caption: string };

export function readMedia(part: string): MediaPart {
  const voice = /^\s*\[voice(?: note)?\]\s*/i.exec(part);
  if (voice) {
    const text = part.slice(voice[0].length).trim();
    return text ? { kind: "voice", text } : { kind: "text", text: part };
  }
  const photo = /^\s*\[photo:\s*([^\]]{3,400})\]\s*/i.exec(part);
  if (photo) return { kind: "photo", description: photo[1].trim(), caption: part.slice(photo[0].length).trim() };
  const song = /^\s*\[song:\s*([^\]]{1,160})\]\s*/i.exec(part);
  if (song) {
    /* "Title - Artist", or failing that "Title by Artist" -- split at the last
       "by", so "Stand by Me by Ben E. King" keeps its title. */
    const raw = song[1].trim();
    const dash = /\s+[-–—]\s+/.exec(raw);
    const by = raw.toLowerCase().lastIndexOf(" by ");
    const [title, artist] = dash
      ? [raw.slice(0, dash.index), raw.slice(dash.index + dash[0].length)]
      : by > 0 ? [raw.slice(0, by), raw.slice(by + 4)] : [raw, ""];
    if (title.trim()) {
      return { kind: "song", title: title.trim().slice(0, 100), artist: artist.trim().slice(0, 80), caption: part.slice(song[0].length).trim() };
    }
  }
  return { kind: "text", text: part };
}

/** How a photo or song the Muse sent reads in the transcript, for the model and for memory. */
export const sentPhoto = (description: string) => `(sent a photo: ${description})`;
export const sentSong = (s: { title: string; artist: string }) =>
  `(sent a song: ${s.title}${s.artist ? ` by ${s.artist}` : ""})`;
/** True for the words standing in for a photo or song, which the thread does not show. */
export const isMediaCaption = (content: string) => /^\(sent a (photo|song)[:)]/.test(content);

/* How often each one is on offer, per conversation. They are seasoning: a
   photo every few hours is someone sharing their day, every message is a bot.
   A photo also costs real money to make. */
const MEDIA_GAP_MS = { photo: 2 * 3_600_000, voice: 3 * 3_600_000, song: 24 * 3_600_000 };

export interface MediaAllowed { photo: boolean; voice: boolean; song: boolean }

/* Asked for outright: "photo bhej", "send a voice note", "koi gaana suggest kar". */
const ASKED = {
  photo: /\b(photo|photos|pic|pics|picture|pictures|image|images|img|snap|selfie|tasveer|foto|show me|dikha|dikhao|dikhana)\b/i,
  voice: /\b(voice ?notes?|vn|voice|audio|awaaz|aawaz|bol ke bhej)\b/i,
  song: /\b(song|songs|gaana|gaane|gana|music|playlist)\b/i,
};
/** Unasked, they are on offer about one turn in three. */
const OFFERED = 0.35;

export function mediaAllowed(
  state: SoloState,
  museId: string,
  /* `roll`, 0 to 1, is whether this turn is one where they are on offer; by
     default it comes from the message being answered, so asking again gets the
     same answer rather than a re-roll. */
  /* `level`: how close you are (0-4); voice notes come more often the closer. `goodnight`: a
     goodnight at night from someone close, which is a voice note. */
  opts: { now?: number; canStore?: boolean; roll?: number; level?: number; goodnight?: boolean } = {}
): MediaAllowed {
  const now = opts.now ?? Date.now();
  const person = findMuse(state, museId);
  const mode = person?.persona?.mode;
  const log = state.conversations[museId] ?? [];
  const lastOf = (has: (m: SoloMessage) => boolean) => {
    for (let i = log.length - 1; i >= 0; i--) if (log[i].from === "muse" && has(log[i])) return Date.parse(log[i].at);
    return -Infinity;
  };
  /* What they said since the last reply. */
  const theirs: string[] = [];
  for (let i = log.length - 1; i >= 0 && log[i].from === "user"; i--) theirs.push(log[i].content);
  const said = theirs.join("\n");
  const roll = opts.roll ?? rollFor(log.at(-1)?.id ?? "");
  const level = opts.level ?? 0;
  const allowed = (kind: keyof typeof MEDIA_GAP_MS, has: (m: SoloMessage) => boolean) => {
    const since = now - lastOf(has);
    /* Voice notes come more often the closer you are. */
    const odds = kind === "voice" ? Math.min(0.6, OFFERED + 0.08 * level) : OFFERED;
    const gap = kind === "voice" && level >= 3 ? 3_600_000 : MEDIA_GAP_MS[kind];
    /* Asked for: always. */
    return ASKED[kind].test(said) || (roll < odds && since >= gap);
  };
  const canStore = opts.canStore !== false;
  return {
    /* Not for a public figure, whose private life is off limits, and not for
       someone who has died: a photo of "my lunch today" from them is not a
       comfort, it is a lie with a picture attached. */
    photo: canStore && mode !== "figure" && mode !== "memorial" && allowed("photo", (m) => !!m.image),
    voice: canStore && (!!opts.goodnight || allowed("voice", (m) => !!m.voiceNote)),
    song: allowed("song", (m) => !!m.song),
  };
}

function rollFor(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return (Math.abs(h) % 1000) / 1000;
}

/* A tag on a line of its own inside a message, rather than at the start of
   one. Happens when the model forgets the --- between texts and writes them on
   separate lines instead -- and a tag left inside a text would show up as
   "[photo: ...]" in the bubble. Each tag line becomes its own message. */
export function splitMediaLines(parts: string[]): string[] {
  const tag = /^\s*\[(voice(?: note)?\]|photo:|song:)/i;
  const out: string[] = [];
  for (const part of parts) {
    let acc: string[] = [];
    for (const line of part.split("\n")) {
      if (!tag.test(line)) { acc.push(line); continue; }
      if (acc.join("\n").trim()) out.push(acc.join("\n").trim());
      out.push(line.trim());
      acc = [];
    }
    if (acc.join("\n").trim()) out.push(acc.join("\n").trim());
  }
  return out;
}
