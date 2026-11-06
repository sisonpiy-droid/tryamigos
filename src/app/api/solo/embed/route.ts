import { soloGate } from "@/lib/authorize";
import { z } from "zod";

import { getEmbeddingProvider } from "@/lib/ai";

/* Turning memories and questions into vectors, so recall works on meaning.
 *
 * Solo mode ranked memories by shared words, which fails on the ordinary case:
 * "my puppy chewed the sofa" does not retrieve "User's dog is called Bruno",
 * and "how do i stop craving cigarettes" does not retrieve "trying to quit
 * smoking since March". Measured on five realistic paraphrases, word overlap
 * got two right.
 *
 * The vectors are 256-dimensional rather than the model's full 3,072. That is
 * a storage decision, not a modelling one: everything solo mode knows lives in
 * localStorage under a ~4.5MB ceiling, and at full width three hundred memories
 * would be 20MB. Measured on the same five queries — 128 dims got two right and
 * was actively wrong on one, 256 got four, 768 got five at 1.7MB. 256 buys most
 * of the accuracy for a third of the room.
 *
 * Server-side because the key is (§50), and stateless like everything else
 * here: the vectors go back to the browser and are stored beside the memories
 * they belong to.
 */

export const runtime = "nodejs";
export const maxDuration = 60;

/** Below the model's full width; see above. */
export const DIMS = 256;

const bodySchema = z.object({
  texts: z.array(z.string().trim().min(1).max(600)).min(1).max(64),
});

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
    console.error(
      "embed rejected:",
      parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.code}`).join("; ")
    );
    return Response.json({ error: "Nothing to embed." }, { status: 400 });
  }

  const provider = getEmbeddingProvider();
  /* No embedding model configured is not an error. Ranking falls back to word
     overlap, which is worse but works, and the caller carries on without one. */
  if (!provider) return Response.json({ vectors: null });

  try {
    const vectors = await Promise.all(
      parsed.data.texts.map((t) => provider.generateEmbedding(t, DIMS))
    );
    return Response.json({ vectors });
  } catch (err) {
    /* Same reasoning: a failed embedding costs recall quality on one turn, and
       failing the caller would cost them the conversation. */
    console.error("embedding failed", err);
    return Response.json({ vectors: null });
  }
}
