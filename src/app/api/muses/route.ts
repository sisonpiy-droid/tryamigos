import { z } from "zod";

import { errorResponse, requireUserId } from "@/lib/authorize";
import { prisma } from "@/lib/db";
import { screenMuse } from "@/lib/muse/moderation";

/* §Screen 5 / §57. Creation is one request: the wizard is a client-side
   sequence over a single form, so a half-finished Muse never reaches the
   database and there is no draft state to reconcile. */

const createSchema = z.object({
  name: z.string().trim().min(1).max(40),
  description: z.string().trim().min(1).max(300),
  relationshipType: z.string().trim().min(1).max(40),
  category: z.string().trim().max(40).optional(),
  languages: z.array(z.string().trim().min(1).max(40)).max(5).optional(),

  traits: z.array(z.string().trim().min(1).max(30)).max(8).default([]),
  customInstructions: z.string().trim().max(600).optional(),
  tone: z.string().trim().max(80).optional(),
  formality: z.string().trim().max(40).optional(),
  sentenceLength: z.string().trim().max(40).optional(),
  humour: z.string().trim().max(120).optional(),
  catchphrases: z.string().trim().max(160).optional(),
  dialect: z.string().trim().max(60).optional(),

  /* §Step 5. Seeded as PERMANENT because the user stated them directly, and
     confidence 1 for the same reason -- these are not inferred. */
  seedMemories: z.array(z.string().trim().min(1).max(300)).max(10).default([]),
});

export async function POST(req: Request) {
  try {
    const userId = await requireUserId();

    let raw: unknown;
    try { raw = await req.json(); } catch { return Response.json({ error: "Invalid request." }, { status: 400 }); }

    const parsed = createSchema.safeParse(raw);
    if (!parsed.success) {
      const field = parsed.error.issues[0]?.path[0];
      return Response.json(
        { error: field === "name" ? "They need a name." : field === "description" ? "Say a line about who they are." : "Check the details and try again." },
        { status: 400 }
      );
    }
    const input = parsed.data;

    /* §36: moderation at persona creation. Deliberately shallow -- it catches
       the obvious and states plainly that it is not a full safety system. */
    const verdict = screenMuse(input);
    if (!verdict.ok) {
      return Response.json({ error: verdict.reason }, { status: 422 });
    }

    const muse = await prisma.muse.create({
      data: {
        ownerUserId: userId,
        name: input.name,
        description: input.description,
        relationshipType: input.relationshipType,
        category: input.category ?? null,
        languages: input.languages?.length ? input.languages : ["English"],
        /* §37: created Muses are private. Sharing is a later, deliberate act,
           never a default -- a default of PUBLIC would publish someone's
           private companion the moment they made it. */
        visibility: "PRIVATE",
        personality: {
          create: {
            traits: input.traits,
            customInstructions: input.customInstructions ?? null,
            tone: input.tone ?? null,
            formality: input.formality ?? null,
            sentenceLength: input.sentenceLength ?? null,
            humour: input.humour ?? null,
            catchphrases: input.catchphrases ?? null,
            dialect: input.dialect ?? null,
          },
        },
        // Proactive is off by default (§16, §61).
        behaviour: { create: {} },
      },
      select: { id: true, name: true },
    });

    if (input.seedMemories.length) {
      await prisma.memory.createMany({
        data: input.seedMemories.map((content) => ({
          userId,
          museId: muse.id,
          content,
          type: "PERMANENT" as const,
          importance: 4,
          confidence: 1,
          /* No embedding yet. Generating one per seed would add a round trip to
             creation, and lexical matching covers them until the first real
             conversation re-embeds nothing -- retrieval falls back cleanly. */
          embedding: [],
        })),
      });
    }

    return Response.json({ muse }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

/* GET /api/muses — the signed-in user's own Muses. */
export async function GET() {
  try {
    const userId = await requireUserId();
    const muses = await prisma.muse.findMany({
      where: { ownerUserId: userId, status: "ACTIVE" },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true, name: true, description: true, relationshipType: true,
        visibility: true, createdAt: true,
        personality: { select: { traits: true } },
      },
    });
    return Response.json({ muses });
  } catch (err) {
    return errorResponse(err);
  }
}
