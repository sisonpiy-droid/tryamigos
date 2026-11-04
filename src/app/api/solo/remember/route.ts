import { z } from "zod";

import { getProvider } from "@/lib/ai";
import { resolveWhen } from "@/lib/presence/time";

/* Memory extraction for solo mode. Stateless: the client sends the turn and
   what it already knows, and gets back new memories to store itself.

   Without this, solo mode would be a chatbot with characters — which §69 says
   explicitly is not the product. */

export const runtime = "nodejs";

export const maxDuration = 60;

/* `known` is advisory. It exists so the model does not propose a memory the
   caller already has, and the caller deduplicates again on the way in anyway.
   
   It used to be validated like input that matters -- at most 60 entries, each at
   most 400 characters -- and a request that broke either bound was rejected
   whole, answered with 200 and an empty list, and logged nowhere. So the
   sixty-first memory stopped a character ever forming another one, silently and
   permanently, and a single over-long memory did the same at any count. Nothing
   bounded a memory's length when it was written, so that was reachable too.
   
   Now it is clamped rather than enforced: too many, or too long, costs a little
   deduplication accuracy on one turn. It cannot cost the feature. */
const KNOWN_MAX = 80;
const KNOWN_CHARS = 400;

const bodySchema = z.object({
  messages: z
    .array(z.object({
      role: z.enum(["user", "assistant"]),
      content: z.string().max(8000),
      /* When it was said. What lets "tomorrow at 11" become a date. */
      at: z.string().max(40).optional(),
    }))
    .min(1)
    .max(40),
  known: z
    .array(z.unknown())
    .default([])
    .transform((xs) =>
      xs
        .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
        /* Newest last from the client, and the recent ones are the ones a turn
           is likely to repeat, so keep the tail. */
        .slice(-KNOWN_MAX)
        .map((x) => x.slice(0, KNOWN_CHARS))
    ),
  timezone: z.string().max(64).nullish(),
});

export async function POST(req: Request) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    /* Only `messages` can fail now, and that means the caller is broken rather
       than the data being large. Logged either way: the previous silence here
       is what let a dead memory pipeline look like a working one. */
    console.error(
      "solo extraction rejected:",
      parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.code}`).join("; ")
    );
    return Response.json({ memories: [] });
  }

  try {
    const { messages, known, timezone } = parsed.data;
    const tz = timezone ?? undefined;
    const found = await getProvider().extractMemories(
      messages.map(({ role, content }) => ({ role, content })),
      known,
      { timeZone: tz, now: Date.now(), at: messages.map((m) => m.at) }
    );
    /* Resolved here, against the user's own timezone, so the client only ever
       stores an absolute instant. */
    const memories = found.map((m) => ({ ...m, when: resolveWhen(m.when, tz) }));
    return Response.json({ memories });
  } catch (err) {
    /* Never fails the caller. A missed memory is a smaller harm than an error
       banner after a conversation the user thought went fine. */
    console.error("solo extraction failed", err);
    return Response.json({ memories: [] });
  }
}
