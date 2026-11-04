import { z } from "zod";

import { streamGuarded, userFacingError } from "@/lib/ai";
import { banterNote } from "@/lib/solo/banter";
import { circleBlock, circleHistory, coveredBlock, coveredGround, oneToOneBlock, personaSystem, togetherBlock } from "@/lib/presence/persona";
import { feelingsSchema, personaSchema } from "@/lib/presence/schema";
import { nowBlock, previousMoment, stampPauses } from "@/lib/presence/time";

/* One turn in a circle: several people in a room, one of them replying.
 *
 * A separate route from /api/solo/chat on purpose. The one-to-one path works
 * and is what almost every conversation uses; bolting a second mode into it
 * would put a branch through the middle of the thing that already works.
 *
 * The prompt is the member's own personaSystem output plus a circle block. So
 * whoever is speaking is exactly who they are one to one, in a room with
 * others -- not a different character who happens to share a name.
 *
 * Stateless, like everything else in solo mode.
 */

export const runtime = "nodejs";
export const maxDuration = 60;

const persona = personaSchema("character");

const traitList = z.array(z.string().max(30)).max(8).optional();

const bodySchema = z.object({
  circleName: z.string().trim().min(1).max(60),
  /** The member being asked to speak. */
  speaker: z.object({ id: z.string().max(60), persona }),
  /** Everyone else in the room, for the roster. */
  others: z
    .array(
      z.object({
        id: z.string().max(60),
        name: z.string().max(60),
        relationship: z.string().max(120),
        traits: traitList,
      })
    )
    .max(7),
  log: z
    .array(
      z.object({
        from: z.enum(["user", "muse"]),
        speakerId: z.string().max(60).optional(),
        content: z.string().min(1).max(8000),
        quote: z
          .object({
            from: z.enum(["user", "muse"]),
            speakerId: z.string().max(60).optional(),
            content: z.string().min(1).max(300),
          })
          .optional(),
        /** When it was sent, ISO. */
        at: z.string().max(40).optional(),
        /* A photo the user sent to the room, recent ones only; and frames
           from the latest video. Shrunk in the browser first. */
        image: z.object({ mime: z.enum(["image/jpeg", "image/png", "image/webp"]), data: z.string().max(1_600_000) }).optional(),
        frames: z.array(z.object({ mime: z.enum(["image/jpeg", "image/png", "image/webp"]), data: z.string().max(400_000) })).max(4).optional(),
      })
    )
    .min(1)
    .max(80),
  /** What the room is about and how it is, both set by the user. */
  topic: z.string().max(300).optional(),
  roomTraits: traitList,
  /** What the speaker remembers about the user from talking one to one. */
  /* Everything the speaker remembers about the user. Lines learned anywhere
     but this circle arrive marked "(private)" -- see circleBlock. */
  memories: z.array(z.string().max(420)).max(12).default([]),
  /** The recent end of the speaker's own one-to-one chat with the user. */
  oneToOne: z
    .array(z.object({ from: z.enum(["user", "muse"]), content: z.string().max(600), at: z.string().max(40).optional() }))
    .max(32)
    .default([]),
  /** Everything before that, digested: what the two of them have talked about over time. */
  digest: z.string().max(2000).nullish(),
  /** The speaker's dated plans and events, each with its instant. */
  plans: z.array(z.object({ what: z.string().max(430), at: z.string().max(40) })).max(8).default([]),
  /** A plan the speaker and the user have on right now. */
  together: z.object({ what: z.string().max(300), since: z.number().min(0) }).nullish(),
  /** Nobody spoke to them: one says something to another (lib/solo/banter.ts). */
  banter: z.boolean().optional(),
  /** Maps a speakerId to a display name, so the transcript reads as a room. */
  names: z.record(z.string(), z.string().max(60)),
  userName: z.string().trim().max(80).nullish(),
  timezone: z.string().max(64).nullish(),
  mood: z.string().max(20).optional(),
  register: z.string().max(20).optional(),
  /* Whoever is speaking brings their own standing state into the room. Keyed
     by speaker rather than shared: one person can be having a bad month while
     everyone else is fine, which is most group chats. */
  feelings: feelingsSchema.nullish(),
});

const MAX_TOTAL_CHARS = 60_000;

export async function POST(req: Request) {
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
  const { circleName, speaker, others, log, names, userName, timezone, mood, register, feelings, topic, roomTraits, memories, plans, oneToOne, digest, together, banter } =
    parsed.data;
  const tz = timezone ?? undefined;
  const now = Date.now();
  const asTimed = log.map((m) => ({ role: m.from === "user" ? ("user" as const) : ("assistant" as const), content: m.content, at: m.at }));
  const clock = { now, previousAt: previousMoment(asTimed), plans };
  /* Pauses marked on the user's lines, before the room is labelled. */
  const stamped = stampPauses(asTimed, tz, now);
  const timedLog = log.map((m, i) => ({
    ...m,
    content: stamped[i].content,
    images: m.from === "user" && (m.image || m.frames?.length) ? [...(m.image ? [m.image] : []), ...(m.frames ?? [])] : undefined,
  }));
  const seesPictures = timedLog.some((m) => m.images?.length);

  if (log.reduce((n, m) => n + m.content.length, 0) > MAX_TOTAL_CHARS) {
    return Response.json({ error: "This conversation has got too long to send." }, { status: 413 });
  }

  const you = userName?.trim() || speaker.persona.you || "them";

  const messages = circleHistory(timedLog, speaker.id, you, (id) => names[id] ?? "Someone");
  /* Banter has no message from the user to answer: say what is wanted in its place. */
  if (banter) {
    const note = banterNote(you, others.map((o) => o.name));
    const tail = messages.at(-1);
    if (tail?.role === "user") tail.content += `\n\n${note}`;
    else messages.push({ role: "user", content: note });
  }

  const system =
    personaSystem(
      { ...speaker.persona, you },
      memories,
      false,
      { mood: mood || "any", topic: "any", register: register || "texts" },
      tz,
      feelings ?? undefined,
      clock
    ) +
    coveredBlock(coveredGround(messages), you) +
    oneToOneBlock(oneToOne, you, tz, digest) +
    togetherBlock(together, you) +
    circleBlock({ you, me: speaker.persona.them, others, circleName, topic, roomTraits }) +
    (seesPictures
      ? `

PHOTOS AND VIDEOS
${you} can send photos and videos to the group, and you can see them -- a video as a few frames from through it. React the way you would to a photo in a group chat: to what matters in it, in your own voice, and off what the others said about it. Never describe the picture, and never mention frames.`
      : "") +
    nowBlock(you, tz, now);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      try {
        /* Low thinking, as in one-to-one texts: a room of three answering one
           after another made the default wait three times over. */
        for await (const evt of streamGuarded({ system, messages, name: speaker.persona.them, thinking: "low" })) {
          if (evt.type === "delta") send({ type: "delta", text: evt.text });
          else if (evt.type === "refused") {
            /* In a circle a refusal is quieter: that member simply says
               nothing this turn, which is normal in a group anyway. */
            send({ type: "silent" });
          } else send({ type: "done" });
        }
      } catch (err) {
        console.error("circle generation failed", err);
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
