import { errorResponse, requireUserId } from "@/lib/authorize";
import { prisma } from "@/lib/db";
import { ARCHIVE_FORMAT, personaExport, safeFilename } from "@/lib/export";

/* GET /api/account/export — everything this account holds (§37).
   One file: profile, the Muses they made, every conversation, and every memory
   with the Muse it belongs to. Embeddings are omitted -- thousands of floats
   per memory that mean nothing outside this system. */
export async function GET() {
  try {
    const userId = await requireUserId();

    const [user, muses, conversations, memories] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: { email: true, name: true, timezone: true, createdAt: true, memoryEnabled: true },
      }),
      prisma.muse.findMany({
        where: { ownerUserId: userId },
        include: { personality: true },
      }),
      prisma.conversation.findMany({
        where: { userId, deletedAt: null },
        orderBy: { startedAt: "asc" },
        select: {
          startedAt: true,
          summary: true,
          muse: { select: { name: true } },
          messages: {
            orderBy: { createdAt: "asc" },
            select: { senderType: true, content: true, createdAt: true },
          },
        },
      }),
      prisma.memory.findMany({
        where: { userId },
        orderBy: { createdAt: "asc" },
        select: {
          content: true, type: true, importance: true, confidence: true,
          createdAt: true, muse: { select: { name: true } },
        },
      }),
    ]);

    const archive = {
      format: ARCHIVE_FORMAT,
      exportedAt: new Date().toISOString(),
      account: user,
      musesCreated: muses.map(personaExport).map((p) => p.muse),
      conversations: conversations.map((c) => ({
        muse: c.muse.name,
        startedAt: c.startedAt.toISOString(),
        summary: c.summary,
        messages: c.messages.map((m) => ({
          from: m.senderType === "USER" ? "user" : "muse",
          content: m.content,
          at: m.createdAt.toISOString(),
        })),
      })),
      memories: memories.map((m) => ({
        muse: m.muse.name,
        content: m.content,
        type: m.type,
        importance: m.importance,
        confidence: m.confidence,
        createdAt: m.createdAt.toISOString(),
      })),
    };

    return new Response(JSON.stringify(archive, null, 2), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="${safeFilename("muse-account", "json")}"`,
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
