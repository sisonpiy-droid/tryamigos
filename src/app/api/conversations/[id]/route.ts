import { errorResponse, requireOwnConversation, requireUserId } from "@/lib/authorize";
import { prisma } from "@/lib/db";

/* GET /api/conversations/:id — message history for one thread. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUserId();
    const { id } = await ctx.params;
    await requireOwnConversation(id, userId);

    const [messages, conversation] = await Promise.all([
      prisma.message.findMany({
        where: { conversationId: id, senderType: { in: ["USER", "MUSE"] } },
        orderBy: { createdAt: "asc" },
        // metadata is deliberately not selected: §8 keeps model details server-side.
        select: { id: true, senderType: true, content: true, createdAt: true },
      }),
      prisma.conversation.findUnique({
        where: { id },
        select: {
          id: true,
          muse: { select: { id: true, name: true, avatarUrl: true, relationshipType: true, description: true } },
        },
      }),
    ]);

    return Response.json({ conversation, messages });
  } catch (err) {
    return errorResponse(err);
  }
}

/* DELETE /api/conversations/:id — §37. Soft delete so it leaves the UI at once
   while the row stays available for a moment if support ever needs it. */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUserId();
    const { id } = await ctx.params;
    await requireOwnConversation(id, userId);
    await prisma.conversation.update({ where: { id }, data: { deletedAt: new Date() } });
    return Response.json({ deleted: true });
  } catch (err) {
    return errorResponse(err);
  }
}
