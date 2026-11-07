import { z } from "zod";

import { errorResponse, requireUserId } from "@/lib/authorize";
import { prisma } from "@/lib/db";

/* POST /api/report — a signed-in user flags a message. Stored for the founder to
   read; nothing is shown back. Capped so a script cannot fill the table. */
const bodySchema = z.object({
  content: z.string().trim().min(1).max(2000),
  reason: z.string().trim().max(500).optional(),
});

const PER_DAY = 20;

export async function POST(req: Request) {
  try {
    const userId = await requireUserId();
    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "Check the report and try again." }, { status: 400 });

    const today = await prisma.messageReport.count({
      where: { userId, createdAt: { gt: new Date(Date.now() - 86_400_000) } },
    });
    if (today >= PER_DAY) return Response.json({ error: "Too many reports today." }, { status: 429 });

    await prisma.messageReport.create({ data: { userId, content: parsed.data.content, reason: parsed.data.reason || null } });
    return Response.json({ ok: true }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
