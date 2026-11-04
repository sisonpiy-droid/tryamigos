import { errorResponse, requireUserId, requireViewableMuse } from "@/lib/authorize";
import { prisma } from "@/lib/db";

/* GET /api/muses/:id/memories — §12. What this Muse knows about you.
   Scoped to the signed-in user: two people talking to the same public Muse
   have entirely separate memories, and §51 says one must never reach the
   other's through an API request. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUserId();
    const { id: museId } = await ctx.params;
    await requireViewableMuse(museId, userId);

    const memories = await prisma.memory.findMany({
      where: { userId, museId },
      orderBy: [{ importance: "desc" }, { createdAt: "desc" }],
      // embedding is excluded: several thousand floats per row, useless to a client.
      select: {
        id: true, content: true, type: true, importance: true,
        confidence: true, createdAt: true, lastRetrievedAt: true,
      },
    });
    return Response.json({ memories });
  } catch (err) {
    return errorResponse(err);
  }
}

/* DELETE /api/muses/:id/memories — §12 "delete all memories". */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUserId();
    const { id: museId } = await ctx.params;
    await requireViewableMuse(museId, userId);

    const { count } = await prisma.memory.deleteMany({ where: { userId, museId } });
    return Response.json({ deleted: count });
  } catch (err) {
    return errorResponse(err);
  }
}
