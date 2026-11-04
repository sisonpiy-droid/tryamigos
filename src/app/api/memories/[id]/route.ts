import { z } from "zod";

import { getEmbeddingProvider } from "@/lib/ai";
import { errorResponse, requireOwnMemory, requireUserId } from "@/lib/authorize";
import { prisma } from "@/lib/db";

const patchSchema = z.object({
  content: z.string().trim().min(1).max(500).optional(),
  importance: z.number().int().min(1).max(5).optional(),
});

/* PATCH /api/memories/:id — correct something a Muse got wrong. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUserId();
    const { id } = await ctx.params;
    await requireOwnMemory(id, userId);

    let raw: unknown;
    try { raw = await req.json(); } catch { return Response.json({ error: "Invalid request." }, { status: 400 }); }
    const parsed = patchSchema.safeParse(raw);
    if (!parsed.success) return Response.json({ error: "Nothing to change." }, { status: 400 });

    /* Re-embed when the text changes. A stale embedding would keep retrieving
       the memory for the old wording, which is worse than not having one. */
    const embedding = parsed.data.content
      ? await getEmbeddingProvider()?.generateEmbedding(parsed.data.content).catch(() => null)
      : undefined;

    const memory = await prisma.memory.update({
      where: { id },
      data: {
        ...parsed.data,
        ...(embedding ? { embedding } : {}),
        /* A hand-edited memory is the user's own word, so it is certain. */
        ...(parsed.data.content ? { confidence: 1 } : {}),
      },
      select: { id: true, content: true, type: true, importance: true, confidence: true },
    });
    return Response.json({ memory });
  } catch (err) {
    return errorResponse(err);
  }
}

/* DELETE /api/memories/:id — §59: once deleted it must never be retrieved. */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUserId();
    const { id } = await ctx.params;
    await requireOwnMemory(id, userId);
    await prisma.memory.delete({ where: { id } });
    return Response.json({ deleted: true });
  } catch (err) {
    return errorResponse(err);
  }
}
