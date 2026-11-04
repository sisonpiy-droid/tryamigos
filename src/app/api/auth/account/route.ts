import { errorResponse, requireUserId } from "@/lib/authorize";
import { prisma } from "@/lib/db";

/* DELETE /api/auth/account — §37, §56.
   Everything the user owns cascades from the User row: muses, conversations,
   messages, memories, relationships, calls, schedules, notifications. */
export async function DELETE() {
  try {
    const userId = await requireUserId();
    await prisma.user.delete({ where: { id: userId } });
    return Response.json({ deleted: true });
  } catch (err) {
    return errorResponse(err);
  }
}
