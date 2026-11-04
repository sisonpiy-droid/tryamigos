import { errorResponse, requireOwnConversation, requireUserId } from "@/lib/authorize";
import { prisma } from "@/lib/db";
import { safeFilename, transcriptMarkdown } from "@/lib/export";

/* GET /api/conversations/:id/export?format=md|json — §37.
   Ownership is checked the same way as reading the conversation: an export
   route is just another way to read, and forgetting that is how one leaks. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requireUserId();
    const { id } = await ctx.params;
    await requireOwnConversation(id, userId);

    const format = new URL(req.url).searchParams.get("format") === "json" ? "json" : "md";

    const [conversation, user, messages] = await Promise.all([
      prisma.conversation.findUnique({
        where: { id },
        select: { muse: { select: { name: true, relationshipType: true } } },
      }),
      prisma.user.findUnique({ where: { id: userId }, select: { name: true } }),
      prisma.message.findMany({
        where: { conversationId: id, senderType: { in: ["USER", "MUSE"] } },
        orderBy: { createdAt: "asc" },
        // metadata stays out: §8 keeps model details server-side, exports included.
        select: { senderType: true, content: true, createdAt: true },
      }),
    ]);

    if (!conversation) return Response.json({ error: "Not found" }, { status: 404 });

    const museName = conversation.muse.name;

    if (format === "json") {
      const body = JSON.stringify(
        {
          format: "muse.transcript/1",
          exportedAt: new Date().toISOString(),
          muse: conversation.muse,
          messages: messages.map((m) => ({
            from: m.senderType === "USER" ? "user" : "muse",
            content: m.content,
            at: m.createdAt.toISOString(),
          })),
        },
        null,
        2
      );
      return new Response(body, {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-disposition": `attachment; filename="${safeFilename(museName, "json")}"`,
          "cache-control": "no-store",
        },
      });
    }

    const md = transcriptMarkdown({
      museName,
      relationshipType: conversation.muse.relationshipType,
      userName: user?.name ?? null,
      messages,
    });

    return new Response(md, {
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": `attachment; filename="${safeFilename(museName, "md")}"`,
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
