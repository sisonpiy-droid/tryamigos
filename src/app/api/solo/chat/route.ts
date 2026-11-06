import { soloGate } from "@/lib/authorize";
import { z } from "zod";

import { streamGuarded, userFacingError } from "@/lib/ai";
import { looksLikeRefusal } from "@/lib/ai/refusal";
import { feelingsSchema, personaSchema } from "@/lib/presence/schema";
import { buildMuseSystemPrompt } from "@/lib/muse/prompt";
import {
  asHeat, softerSystems, coveredBlock, coveredGround, lifeBlock, momentBlock, personaSystem, promiseBlock, quizBlock, romanceAllowed, anchorBlock, awayBlock, worldBlock, bondBlock, callbackBlock, goodnightBlock, heardBlock, secretBlock, romanceBlock,
  sendBlock, sharedBlock, togetherBlock, withQuote, wornBlock, yesBlock, type Feelings,
} from "@/lib/presence/persona";
import { nowBlock, previousMoment, stampPauses, timeBlock } from "@/lib/presence/time";

/* Several texts in a row are one turn.
 *
 * Double-texting is how people talk, and the thread keeps each message
 * separate. Providers do not: two user turns back to back are rejected by some
 * and misread by others. Joined on a newline, so the model still sees them as
 * separate lines. Dropping a refusal can leave two replies adjacent too. */
function mergeRuns<T extends { role: "user" | "assistant"; content: string; images?: { mime: string; data: string }[] }>(msgs: T[]): T[] {
  const out: T[] = [];
  for (const m of msgs) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) {
      /* Her own texts go back separated the way she is told to write them;
         joined on bare newlines, she copied that and stopped using "---". */
      last.content += m.role === "assistant" ? `\n---\n${m.content}` : `\n${m.content}`;
      /* A photo sent in a burst stays with the burst. */
      if (m.images?.length) last.images = [...(last.images ?? []), ...m.images];
    } else out.push({ ...m });
  }
  return out;
}

/* Solo mode's only server dependency.
 *
 * Entirely stateless: no database, no session, no storage. The client holds the
 * conversation and the memories and sends what it wants used; this route builds
 * the prompt and streams a reply.
 *
 * It exists at all because the model API key must stay server-side (§50). A
 * fully static build would have to ship the key to the browser, which is not a
 * tradeoff worth making for the convenience of skipping one function.
 *
 * The system prompt is still assembled here, never sent by the client (§33) --
 * otherwise anyone could point this endpoint at any instructions they liked.
 */

export const runtime = "nodejs";

/* Replies stream, so the connection is held for the whole generation. */
export const maxDuration = 60;

const bodySchema = z.object({
  muse: z.object({
    name: z.string().trim().min(1).max(40),
    description: z.string().trim().min(1).max(400),
    relationshipType: z.string().trim().min(1).max(40),
    languages: z.array(z.string().max(40)).max(5).default(["English"]),
    personality: z
      .object({
        traits: z.array(z.string().max(30)).max(8).default([]),
        values: z.string().max(300).nullish(),
        humour: z.string().max(300).nullish(),
        emotionalStyle: z.string().max(300).nullish(),
        opinions: z.string().max(500).nullish(),
        customInstructions: z.string().max(600).nullish(),
        tone: z.string().max(80).nullish(),
        formality: z.string().max(40).nullish(),
        vocabulary: z.string().max(80).nullish(),
        sentenceLength: z.string().max(40).nullish(),
        catchphrases: z.string().max(200).nullish(),
        dialect: z.string().max(80).nullish(),
      })
      .nullish(),
  }),
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1).max(8000),
        /* The message this one replies to. Formatted here rather than by the
           client, so what the model reads for a reply is decided in one place. */
        quote: z
          .object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(300) })
          .optional(),
        /** When it was sent, ISO. Optional only so an older client still works. */
        at: z.string().max(40).optional(),
        /* A photo they sent, for the most recent few only. Shrunk in the
           browser first; the cap is a backstop, not the expected size. */
        image: z
          .object({ mime: z.enum(["image/jpeg", "image/png", "image/webp"]), data: z.string().max(1_600_000) })
          .optional(),
        /* Frames from a video they sent, small JPEGs, for the latest video only. */
        frames: z
          .array(z.object({ mime: z.enum(["image/jpeg", "image/png", "image/webp"]), data: z.string().max(400_000) }))
          .max(4)
          .optional(),
      })
    )
    .min(1)
    .max(60),
  /* Someone built from real material sends Presence's whole profile. When it is
     present it decides the prompt entirely -- the archetype, texture and mode
     blocks are the reason that build sounds like the person rather than like an
     assistant wearing their name. */
  persona: personaSchema("memorial").nullish(),
  /* People this Muse shares a circle with. Additive: absent on every request
     that does not involve circles, and the prompt is unchanged when it is. */
  knows: z
    .array(z.object({ name: z.string().max(60), relationship: z.string().max(120) }))
    .max(8)
    .optional(),
  mood: z.string().max(20).optional(),
  topic: z.string().max(20).optional(),
  register: z.string().max(20).optional(),
  /* Standing emotional state. Separate from `mood` above, which is this
     conversation only -- this one persists and the user sets it rarely. */
  feelings: feelingsSchema.nullish(),
  memories: z.array(z.string().max(400)).max(12).default([]),
  /** Dated plans and events, each with the instant it is for. */
  plans: z.array(z.object({ what: z.string().max(420), at: z.string().max(40) })).max(8).default([]),
  userName: z.string().trim().max(80).nullish(),
  timezone: z.string().max(64).nullish(),
  /** How often you talk here, as one line. See lib/solo/story.ts. */
  story: z.string().max(300).nullish(),
  /** Nicknames and running jokes between the two of them. */
  shared: z.array(z.string().max(400)).max(6).default([]),
  /** Their own repeated openers, phrases and emoji, counted by the client. */
  worn: z
    .object({
      openers: z.array(z.string().max(60)).max(6).default([]),
      phrases: z.array(z.string().max(80)).max(8).default([]),
      emoji: z.array(z.string().max(40)).max(4).default([]),
      of: z.number().int().min(0).max(1000).default(0),
    })
    .nullish(),
  /** What they can send besides texts this turn. Absent: texts only. */
  can: z.object({ photo: z.boolean(), voice: z.boolean(), song: z.boolean() }).nullish(),
  /** Her own storylines this week (lib/solo/life.ts). */
  life: z.array(z.object({ title: z.string().max(80), beats: z.array(z.string().max(300)).max(2), untold: z.boolean() })).max(3).default([]),
  /** What she said she would tell them later, and how long ago in ms. */
  promises: z.array(z.object({ what: z.string().max(300), ago: z.number().min(0) })).max(3).default([]),
  /** A moment due this turn, by key; the words for it are decided here (MOMENTS). */
  moment: z.string().max(30).nullish(),
  /** A plan made together that is on right now. */
  together: z.object({ what: z.string().max(300), since: z.number().min(0) }).nullish(),
  /** The "how well do you know each other" score. */
  score: z.object({ user: z.number().int().min(0), muse: z.number().int().min(0), rounds: z.number().int().min(0), lastAt: z.string().max(40) }).nullish(),
  /** How close you have got, as an index into LEVELS. Absent for a real person. */
  bond: z.number().int().min(0).max(10).nullish(),
  /** What was said about them in the user's other chats. */
  heard: z.array(z.string().max(320)).max(12).default([]),
  /** Something told to them days ago, to bring up unprompted. */
  callback: z.object({ what: z.string().max(300), days: z.number().int().min(0) }).nullish(),
  /** Back after days away: how many, and how close (awayBlock). */
  away: z.object({ days: z.number().int().min(2).max(3650), level: z.number().int().min(0).max(10) }).nullish(),
  /** The weather where they are and a festival coming up (worldBlock). */
  world: z.object({ place: z.string().max(80).optional(), weather: z.string().max(60).optional(), festivals: z.array(z.string().max(80)).max(2).default([]) }).nullish(),
  /** How far a romantic chat goes; honoured only for someone allowed Romantic. */
  heat: z.enum(["sweet", "flirty", "steamy"]).optional(),
  /** A long thread, so the character is restated at the end (anchorBlock). */
  long: z.boolean().nullish(),
  /** A goodnight at night from someone close (goodnightBlock). */
  goodnight: z.boolean().nullish(),
  /** Something they have never told the user, and where it stands. */
  secret: z.object({ text: z.string().max(300), stage: z.enum(["hint", "tell", "told"]) }).nullish(),
});

/* Input bounds matter more here than in the signed-in app: there is no account
   to rate-limit against, so size is the only thing keeping one caller from
   running up the bill (§53). */
const MAX_TOTAL_CHARS = 60_000;

export async function POST(req: Request) {
  const denied = await soloGate();
  if (denied) return denied;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json({ error: "Check the request and try again." }, { status: 400 });
  }
  const { muse, persona, knows, mood, topic, register, feelings, messages, memories, plans, userName, timezone, story, shared, worn, can,
    life, promises, moment, together, score, bond, heard, callback, secret, away, goodnight, long, world, heat: wantedHeat } = parsed.data;
  const tz = timezone ?? undefined;
  /* The server's clock, not the phone's: a phone set five minutes wrong should
     not move a meeting. Timestamps on messages are compared against it. */
  const now = Date.now();
  const clock = { now, previousAt: previousMoment(messages), plans };

  const standing: Feelings | undefined = feelings ?? undefined;

  /* Said last, after everything else, so it wins. "Romantic" also works as a
     standing mood, which applies when today's mood is left alone. */
  const romantic = mood === "flirty" || ((!mood || mood === "any") && standing?.mood === "flirty");
  const heat = asHeat(wantedHeat);
  const romanceOn = mood !== "yes" && !!(romantic && persona && romanceAllowed(persona));
  const last = mood === "yes" ? yesBlock(userName || "them")
    : romanceOn ? romanceBlock(userName || "them", heat) : "";

  /* Drop the model's own past refusals from the history. Once "I cannot
     roleplay this persona" is in the transcript the model continues in that
     voice, so a thread that broke once stays broken -- and the owner has no way
     to know why. Removing them here means an already-poisoned conversation
     recovers on its next message instead of needing to be deleted. */
  const cleaned = messages.filter(
    (m) => !(m.role === "assistant" && looksLikeRefusal(m.content))
  );
  /* Only the most recent few photos are sent as pictures; older ones stay in
     the transcript as words. Bounds the request, and an old photo is not what
     anyone is talking about now. */
  let photos = 0;
  for (let i = cleaned.length - 1; i >= 0; i--) {
    if (cleaned[i].image && ++photos > 3) cleaned[i] = { ...cleaned[i], image: undefined };
  }
  const hasPhoto = photos > 0 || cleaned.some((m) => m.frames?.length);
  const toModel = (list: typeof messages, withImages = true) => mergeRuns(
    stampPauses(
      list.map((m) => ({
        role: m.role,
        at: m.at,
        ...(withImages && m.role === "user" && (m.image || m.frames?.length) ? { images: [...(m.image ? [m.image] : []), ...(m.frames ?? [])] } : {}),
        content: withQuote(
          m.content,
          m.quote && { who: m.quote.role === "assistant" ? "you" : "their own earlier message", text: m.quote.content }
        ),
      })),
      tz,
      now
    ).map(({ role, content, images }) => ({ role, content, ...(images ? { images } : {}) }))
  );
  const sendable = cleaned.length ? cleaned : messages;
  const messagesForModel = toModel(sendable);

  /* Shorter histories, for when every prompt is refused before generation
     (see streamGuarded): without the photos, then the last few messages, then
     only what was just said. `kept` is how many of the request's messages each
     still carries, so the app can stop sending the rest. */
  const theirTurn = (() => { let n = 0; while (n < sendable.length && sendable[sendable.length - 1 - n].role === "user") n++; return n; })();
  /* Counted against the request as sent, not against `sendable`, which has
     past refusals taken out: the app knows its messages by that order. */
  const sendIdx = cleaned.length
    ? messages.flatMap((m, i) => (m.role === "assistant" && looksLikeRefusal(m.content) ? [] : [i]))
    : messages.map((_, i) => i);
  const keptOf = (k: number) => messages.length - sendIdx[sendIdx.length - k];
  const shorter: { kept: number; photos: boolean; messages: ReturnType<typeof toModel> }[] = [
    ...(hasPhoto ? [{ kept: messages.length, photos: false, messages: toModel(sendable, false) }] : []),
    ...(sendable.length > 8 ? [{ kept: keptOf(8), photos: false, messages: toModel(sendable.slice(-8), false) }] : []),
    ...(theirTurn && theirTurn < sendable.length ? [{ kept: keptOf(theirTurn), photos: false, messages: toModel(sendable.slice(-theirTurn), false) }] : []),
  ].filter((h) => h.messages[0]?.role === "user");

  const total = messages.reduce((n, m) => n + m.content.length, 0)
    + memories.reduce((n, m) => n + m.length, 0);
  if (total > MAX_TOTAL_CHARS) {
    return Response.json({ error: "This conversation has got too long to send." }, { status: 413 });
  }

  const system = persona
    ? personaSystem(persona, memories, false, {
        mood: mood || "any",
        topic: topic || "any",
        register: register || "texts",
      }, tz, standing, clock) +
      /* Computed from the character's own past turns, not asked of the model.
         A model cannot see its own loop -- each turn reads fine alone. */
      coveredBlock(coveredGround(messagesForModel), userName || "they") +
      wornBlock(worn) +
      sharedBlock(shared, userName || "them") +
      lifeBlock(life, userName || "them") +
      promiseBlock(promises, userName || "them") +
      togetherBlock(together, userName || "them") +
      bondBlock(bond, userName || "them") +
      heardBlock(heard, userName || "them") +
      secretBlock(secret, userName || "them") +
      (knows?.length
        ? `

PEOPLE YOU BOTH KNOW
${knows
            .map((k) => `- ${k.name}, ${userName || "their"} ${k.relationship}`)
            .join("\n")}
You may mention them, ask after them, or have opinions about them. Do not invent what they have been doing lately -- you would only know that if you had been told.`
        : "") +
      (hasPhoto
        ? `

PHOTOS
${userName || "They"} can send you photos and videos, and you can see them -- a video as a few frames from through it. React the way you would to a friend's photo or clip -- to what matters in it, in your own voice -- never with a description of the picture, and never mention frames. If you cannot make something out, say so the way a person would.`
        : "") +
      (story
        ? `

YOU TWO, HERE
${story}. Background only: let it colour what you say if it fits (noticing they have been here every day, or that it has been a while), never recite it. It is about this app, not about how long you have known each other in your own story.`
        : "") +
      /* Not on a call: everything there is spoken, and an emoji is not. */
      (register !== "live"
        ? `

REACTIONS
You can react to their latest message with one emoji, the way people do in a chat app, by putting [react: 😂] (any single emoji) at the very start of your reply.
- When their message just closes a moment -- "haha", "lol", "ok", "okay fine", "goodnight", "ttyl", a single emoji -- usually react instead of writing anything: the reaction alone is your whole reply. Write words too only if you genuinely have something to add.
- Otherwise, react now and then when something lands (a joke, good news, something sweet), alongside your reply. Most of your replies have no reaction.
- Lines in their messages like (reacted ❤️ to your "...") mean they reacted to something you said; you may notice it, you need not mention it.`
        : "") +
      /* Voice notes, photos, songs and games: texting only, never on a call. */
      (register !== "live" ? sendBlock(can, userName || "they") : "") +
      /* The quiz goes with the games: texting only. */
      (register !== "live" && can ? quizBlock(score, userName || "they") : "") +
      /* Last, so nothing after it crowds it out: a moment is the one thing this
         reply must do. */
      callbackBlock(callback, userName || "them") +
      momentBlock(moment, userName || "them") +
      awayBlock(away, userName || "them") +
      goodnightBlock(goodnight, userName || "them") +
      (persona ? anchorBlock(persona, long) : "") +
      worldBlock(world, userName || "them") +
      nowBlock(userName || "them", tz, now) +
      last
    : buildMuseSystemPrompt({
    name: muse.name,
    description: muse.description,
    relationshipType: muse.relationshipType,
    languages: muse.languages,
    personality: muse.personality
      ? {
          traits: muse.personality.traits,
          values: muse.personality.values ?? null,
          humour: muse.personality.humour ?? null,
          emotionalStyle: muse.personality.emotionalStyle ?? null,
          opinions: muse.personality.opinions ?? null,
          customInstructions: muse.personality.customInstructions ?? null,
          tone: muse.personality.tone ?? null,
          formality: muse.personality.formality ?? null,
          vocabulary: muse.personality.vocabulary ?? null,
          sentenceLength: muse.personality.sentenceLength ?? null,
          catchphrases: muse.personality.catchphrases ?? null,
          dialect: muse.personality.dialect ?? null,
        }
      : null,
    userName: userName ?? null,
    memories,
    localTime: new Date(),
    timezone: timezone ?? undefined,
      }) + `

${timeBlock({ you: userName || "them", timeZone: tz, ...clock })}` + bondBlock(bond, userName || "them") +
    heardBlock(heard, userName || "them") + callbackBlock(callback, userName || "them");

  /* Progressively less of the real message data, for when the provider will not
     accept the full profile.
     
     This ladder exists because of a reported failure that no retry could fix:
     Gemini returned blockReason PROHIBITED_CONTENT on every attempt for a
     persona built from a couple's chat export. That block is not the
     configurable safety classifier -- safetySettings govern blockReason SAFETY,
     and no threshold, BLOCK_NONE included, switches PROHIBITED_CONTENT off. The
     only lever left is to send less verbatim material.
     
     The previous fallback trimmed samples to 500 characters and kept everything
     else, which was barely a step down and got blocked exactly like the full
     prompt did. So: first drop the measured statistics and the user's notes and
     cut the samples hard, then drop the samples entirely and run on the brief
     alone. A blander version of someone is worth having. Silence is not. */
  /* A block steps the heat down before anything else is tried: the same prompt
     with the next milder romance block, and the one below that. Reached only
     when the reply was refused, so a normal turn never pays for it, and each step
     is milder than the last -- nothing here asks the model for more. */
  const steps = romanceOn && last && system.endsWith(last)
    ? softerSystems(system.slice(0, system.length - last.length), userName || "them", heat)
    : [];
  /* Rungs that drop parts of the profile are also run at the mildest heat. */
  const floor = steps.length ? romanceBlock(userName || "them", steps[steps.length - 1].heat) : last;

  const variant = (p: NonNullable<typeof persona>) =>
    personaSystem(
      p,
      memories,
      false,
      { mood: mood || "any", topic: topic || "any", register: register || "texts" },
      timezone ?? undefined,
      standing
    ) + awayBlock(away, userName || "them") + goodnightBlock(goodnight, userName || "them") + nowBlock(userName || "them", tz, now) + floor;

  const bare = { ...persona, samples: undefined, metrics: undefined, extra: undefined };

  const fallbacks = persona
    ? [
        ...steps.map((s) => s.system),
        variant({ ...persona, samples: persona.samples?.slice(0, 300), metrics: undefined, extra: undefined }),
        variant(bare as NonNullable<typeof persona>),
        /* Last rung. The relationship blocks are written material too, and the
           partner one is the most loaded thing in the prompt for a persona
           built from a couple's messages -- it talks about missing someone's
           hands and being shameless with them, which is fine in a companion app
           and is exactly the shape a classifier reacts to. "other" drops the
           relationship script entirely and leans on the brief. Whoever this is
           still has their name, their voice profile and their memories; what
           they lose is the archetype colouring. */
        variant({ ...bare, arch: "other", texture: "close" } as NonNullable<typeof persona>),
      ]
    : undefined;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      try {
        /* A refusal never reaches the client, so it can never be saved into the
           transcript and poison every turn after it. */
        for await (const evt of streamGuarded({
          system,
          fallbacks,
          messages: messagesForModel,
          name: persona?.them ?? muse.name,
          /* A live call is a sentence or two spoken aloud; long reasoning there
             is only silence on the line. */
          /* How long the model thinks before it answers -- most of the wait.
             Measured on a real persona prompt: default 6.9-8.7s to the first
             word, "low" 2.9-5.9s with replies just as grounded and in
             character, "minimal" 1.2-2.2s but it started inventing shared
             memories and getting the user's gender wrong. So: low for texts,
             minimal only on a call, where a spoken sentence or two is all
             there is and silence on the line costs most. */
          thinking: register === "live" ? "minimal" : "low",
          /* And pass the first sentence on as soon as it is safely not a
             refusal, so the call can start speaking it. */
          releaseAfter: register === "live" ? 30 : undefined,
          histories: shorter.map((h) => h.messages),
        })) {
          if (evt.type === "delta") send({ type: "delta", text: evt.text });
          else if (evt.type === "done" && evt.variant && evt.variant <= steps.length) {
            /* It went through one step milder. Said, so the reply can be marked. */
            send({ type: "softened", to: steps[evt.variant - 1].heat });
            send({ type: "done" });
          }
          else if (evt.type === "done" && evt.history !== undefined) {
            /* It only went through with less of the conversation. Tell the app
               how much, so it leaves the rest out from now on instead of every
               turn walking down this ladder again. */
            const h = shorter[evt.history];
            send({ type: "trimmed", kept: h.kept, photos: h.photos });
            send({ type: "done" });
          }
          else if (evt.type === "refused") {
            const who = persona?.them ?? muse.name;
            /* The old wording here blamed the last message and told the user
               to reword it. On the reported case that was "hi", so they
               reworded it several times and got the same wall. A prompt-level
               block is about the saved profile, and now that the profile is
               editable, saying so is something they can act on. */
            /* "blocked" is the prompt itself being refused, so the profile is
               the only thing that can change it. "stopped" is a filter cutting
               the reply off while it was being written -- that was being
               reported as "blocked" too, sending people to trim sample messages
               that were never the problem. It is about that one reply, and the
               next try usually goes through. */
            send({
              type: "error",
              message:
                /* Refused even with the older conversation left out, so it is
                   what was just said or the profile itself. */
                evt.reason === "blocked"
                  ? `Google's content filter refused this, even with the earlier chat left out — so it's either what you just sent or ${who}'s saved profile. Try saying it differently (tap your message to edit it). If even "hi" is refused, edit ${who} and cut down the sample messages.`
                  : evt.reason === "stopped"
                    ? `Google's safety filter kept stopping ${who}'s reply partway through, so nothing half-finished was sent. Try again — it usually goes through.`
                    : `${who} didn't come to the phone. Try saying it differently.`,
              retryable: evt.reason !== "blocked",
              /* A filter stopped it: the app offers ways to keep going. */
              blocked: evt.reason === "blocked" || evt.reason === "stopped",
            });
          } else send({ type: "done" });
        }
      } catch (err) {
        console.error("solo generation failed", err);
        const { message, retryable } = userFacingError(err);
        send({ type: "error", message, retryable });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
