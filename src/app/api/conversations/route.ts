import { z } from "zod";

import { errorResponse, requireUserId, requireViewableMuse } from "@/lib/authorize";
import { prisma } from "@/lib/db";

const createSchema = z.object({ museId: z.string().min(1) });

/* POST /api/conversations — start or resume talking to a Muse.
   Resumes the most recent thread rather than opening a new one each time: §2's
   loop is about returning to someone, and a fresh empty conversation per visit
   would throw away the continuity that makes it feel like a relationship. */
export async function POST(req: Request) {
  try {
    const userId = await requireUserId();

    let raw: unknown;
    try { raw = await req.json(); } catch { return Response.json({ error: "Invalid request." }, { status: 400 }); }
    const parsed = createSchema.safeParse(raw);
    if (!parsed.success) return Response.json({ error: "Which Muse?" }, { status: 400 });

    const muse = await requireViewableMuse(parsed.data.museId, userId);

    const existing = await prisma.conversation.findFirst({
      where: { userId, museId: muse.id, deletedAt: null },
      orderBy: { lastMessageAt: "desc" },
      select: { id: true },
    });
    if (existing) return Response.json({ conversation: existing, resumed: true });

    const conversation = await prisma.conversation.create({
      data: { userId, museId: muse.id },
      select: { id: true },
    });
    return Response.json({ conversation, resumed: false }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

/* GET /api/conversations — the "Continue talking" rail on Home (§Screen 2). */
export async function GET() {
  try {
    const userId = await requireUserId();
    const conversations = await prisma.conversation.findMany({
      where: { userId, deletedAt: null },
      orderBy: { lastMessageAt: "desc" },
      take: 30,
      select: {
        id: true, lastMessageAt: true,
        muse: { select: { id: true, name: true, avatarUrl: true, relationshipType: true } },
        messages: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { content: true, senderType: true, createdAt: true },
        },
      },
    });

    return Response.json({
      conversations: conversations.map((c) => ({
        id: c.id,
        muse: c.muse,
        lastMessageAt: c.lastMessageAt,
        lastMessage: c.messages[0] ?? null,
      })),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
