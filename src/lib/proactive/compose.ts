import { getProvider } from "@/lib/ai";
import { looksLikeRefusal } from "@/lib/ai/refusal";
import { bondBlock, personaSystem, type Feelings, type PersonaDraft } from "@/lib/presence/persona";
import { nowBlock, resolveWhen, wallClock } from "@/lib/presence/time";
import type { TriggerType } from "./timing";

/* Turning memories into reasons to text, and a reason into the text.
 *
 * Two calls, on purpose. The first only decides which notes are worth reaching
 * out about and what kind of reason each is -- strictly, because relevance is
 * the whole point and most notes are not reasons. Only then is the send time
 * known, and the second call writes the message as of that moment, in the
 * Muse's own voice: the same personaSystem prompt the chat uses, with the clock
 * set to when it will arrive, so "tomorrow" means tomorrow when they read it.
 *
 * The message is written from the one note that justifies it and nothing else,
 * and is checked for details the note does not contain before it is kept.
 */

export interface Candidate {
  id: string;
  content: string;
  type: string;
  at?: string | null;
  createdAt?: string;
}

export interface Classified {
  id: string;
  kind: TriggerType;
  reason: string;
  remindAt: string | null;
  dateOnly: boolean;
  /** When the event is, if the note says and the memory had no date stored. */
  eventAt: string | null;
  keywords: string[];
}

const KINDS = new Set(["UPCOMING_EVENT", "REMINDER", "FOLLOW_UP", "GOAL_CHECK_IN"]);

function jsonArray(text: string): unknown[] {
  const s = text.trim().replace(/^```(?:json)?\s*|```$/g, "");
  const a = s.indexOf("["), b = s.lastIndexOf("]");
  if (a < 0 || b < a) return [];
  try {
    const v = JSON.parse(s.slice(a, b + 1));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export async function classify(candidates: Candidate[], opts: { now: number; tz: string }): Promise<Classified[]> {
  if (!candidates.length) return [];
  const list = candidates
    .map((c) => `- id ${c.id} [${c.type}${c.at ? `, dated ${wallClock(Date.parse(c.at), opts.tz)}` : ""}]: ${c.content}`)
    .join("\n");
  const { text } = await getProvider().generateResponse({
    system: `You decide which notes about a user give a close friend a real reason to text them first, and what kind of reason.

It is now ${wallClock(opts.now, opts.tz)} where the user is.

Kinds:
- UPCOMING_EVENT: something specific is going to happen to them at a known date -- an interview, exam, presentation, flight, appointment, date.
- REMINDER: they explicitly asked to be reminded of something.
- FOLLOW_UP: they said they would report back on something, or something significant has just happened to them (within the last day) whose outcome they have not shared.
- GOAL_CHECK_IN: an important effort they are in the middle of with a near deadline ("finish the pitch deck this week").
- A plan the user made to do something together with the Muse (the note names the Muse: a movie night, a call, a game): REMINDER, with remindAt the moment it starts -- the text is the Muse starting it.
- null: anything else. Preferences, facts about them, relationships, routines, vague wishes, anything long past or far off. Most notes are null.

Relevance matters more than frequency: when in doubt, null. One kind per note.

Return ONLY a JSON array, one item per note:
{"id": string, "kind": "UPCOMING_EVENT"|"REMINDER"|"FOLLOW_UP"|"GOAL_CHECK_IN"|null, "reason": string (at most eight words, only from the note), "remindAt": string|null (REMINDER only: when they want reminding, ISO 8601 with their UTC offset), "dateOnly": boolean (true if remindAt has no time of day), "eventAt": string|null (UPCOMING_EVENT or FOLLOW_UP: when the thing itself is, ISO 8601 with their UTC offset, or just the date if no time is given -- only if the note says), "keywords": string[] (one to three words they would use talking about it)}`,
    messages: [{ role: "user", content: list }],
    temperature: 0.1,
  });

  const byId = new Set(candidates.map((c) => c.id));
  return jsonArray(text)
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .filter((x) => byId.has(String(x.id)) && KINDS.has(String(x.kind)))
    .map((x) => ({
      id: String(x.id),
      kind: String(x.kind) as TriggerType,
      reason: String(x.reason ?? "").trim().slice(0, 120) || "something they mentioned",
      remindAt: x.kind === "REMINDER" ? resolveWhen(x.remindAt, opts.tz) : null,
      dateOnly: Boolean(x.dateOnly),
      eventAt: x.kind === "UPCOMING_EVENT" || x.kind === "FOLLOW_UP" ? resolveWhen(x.eventAt, opts.tz) : null,
      keywords: (Array.isArray(x.keywords) ? x.keywords : [])
        .map((k) => String(k).toLowerCase().trim())
        .filter((k) => k.length > 2)
        .slice(0, 3),
    }));
}

/* Numbers in the message that the note does not contain: a time, a date, a
   count invented to sound specific. The cheapest reliable check for the most
   common way a grounded message drifts. */
export function inventedNumbers(message: string, note: string): string[] {
  const inNote = new Set(note.match(/\d+/g) ?? []);
  return (message.match(/\d+/g) ?? []).filter((n) => !inNote.has(n));
}

/** What a text she starts is told about herself, and about why she is texting. */
export type ComposeOpts = {
  persona: PersonaDraft;
  /** Their standing state, as the chat sends it: the same person in the thread and out of it. */
  feelings?: Feelings;
  /** How close you are (0-4), as the chat sends it. */
  bond?: number | null;
  you: string;
  tz: string;
  kind: TriggerType;
  reason: string;
  note: string;
  sendAt: number;
  eventAt?: string | null;
  /** The last few lines of their conversation, for where things stand. Not stored. */
  recent: { role: "user" | "assistant"; content: string; at?: string }[];
  /* Something she said she would tell them: the text is her telling it, made
     up in keeping with her storylines -- the one case where inventing is the
     job, because it is her own life. */
  promise?: boolean;
  life?: string[];
};

/* The prompt for a text she starts. The character part is personaSystem -- the
   very function the chat and the voice call use -- so a proactive text is the
   same person with the same rules, plus the same standing mood, closeness and
   hour-of-day as the chat; only the reason for writing is new. */
export function composeSystem(opts: ComposeOpts): string {
  const { persona, you, tz } = opts;
  const together = /\bthe muse\b/i.test(opts.note);
  const lastAt = opts.recent.at(-1)?.at ?? null;
  return (
    personaSystem(
      { ...persona, you },
      [opts.note],
      false,
      { mood: "any", topic: "any", register: "texts" },
      tz,
      opts.feelings,
      {
        now: opts.sendAt,
        previousAt: lastAt,
        plans: opts.eventAt ? [{ what: opts.note, at: opts.eventAt }] : [],
      }
    ) +
    (opts.promise
      ? `

YOU ARE TEXTING FIRST
Nobody has said anything yet: this message starts the conversation, and it reaches ${you} at the time given above.
Earlier you told ${you} you would tell them something later: "${opts.note}"
Now you are telling it, because you have been dying to. Tell the actual story, specific and in your own voice, the way you would text it -- it is your own life, so make it up, in keeping with what is going on with you:
${(opts.life ?? []).map((l) => `- ${l}`).join("\n") || "- (nothing in particular this week)"}
- Two to four texts in a burst separated by a line of ---, exactly the way you text ${you}.
- Nothing about ${you}'s life that you do not know.
- Never mention reminders, apps, notifications, memory or being told to text.`
      : `

YOU ARE TEXTING FIRST
Nobody has said anything yet: this message starts the conversation, and it reaches ${you} at the time given above.
Why you are texting: ${opts.reason}.
All you know about it is this note, and nothing else: "${opts.note}"
${opts.kind === "FOLLOW_UP" ? "It has happened, or is due. Ask how it went. Do not assume how it went.\n" : ""}${opts.kind === "REMINDER" && together ? "This is the time you two planned. Start it: text them the way you would when it is time, and get it going.\n" : opts.kind === "REMINDER" ? "They asked to be reminded. Remind them, the way you would, not like an alarm.\n" : ""}- One short text, or two or three in a burst separated by a line of ---, exactly the way you text ${you}.
- About this reason only. Never a generic hello or "what are you up to".
- Do not invent anything the note does not say: no times, places, names, companies or other details, and nothing about what they have already done or how they feel about it.
- Never mention reminders, apps, notifications, memory or being told to text.`) +
    bondBlock(opts.bond, you) +
    nowBlock(you, tz, opts.sendAt)
  );
}

export async function compose(opts: ComposeOpts): Promise<string | null> {
  const system = composeSystem(opts);

  const merged: { role: "user" | "assistant"; content: string }[] = [];
  for (const m of opts.recent.slice(-6)) {
    const last = merged.at(-1);
    if (last && last.role === m.role) last.content += `\n${m.content}`;
    else merged.push({ role: m.role, content: m.content.slice(0, 1500) });
  }
  const ask = "(Write the text you send them now, starting the conversation.)";
  const messages = merged.at(-1)?.role === "user"
    ? [...merged.slice(0, -1), { role: "user" as const, content: `${merged.at(-1)!.content}\n\n${ask}` }]
    : [...merged, { role: "user" as const, content: ask }];

  for (let attempt = 0; attempt < 2; attempt++) {
    const { text } = await getProvider().generateResponse({
      system: attempt === 0 ? system : `${system}\n- Your last draft added a detail the note does not contain. Leave out every number, time and specific the note does not give.`,
      messages,
    });
    const message = (text || "").trim().replace(/^\(|\)$/g, "").trim();
    if (!message || looksLikeRefusal(message)) continue;
    if (!opts.promise && inventedNumbers(message, opts.note).length) continue;
    return message.slice(0, 1200);
  }
  return null;
}
