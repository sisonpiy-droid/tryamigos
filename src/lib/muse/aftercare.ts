/* Everything that happens after a reply is delivered (PRD §11, §14, §58).
 *
 * All of it runs after the user already has their answer. None of it may fail
 * their turn: a memory that does not get extracted is a smaller harm than a
 * message that errors, so every step here swallows its own errors and logs.
 */

import { getEmbeddingProvider, getProvider } from "@/lib/ai";
import type { ChatMessage } from "@/lib/ai/types";
import { prisma } from "@/lib/db";
import { RECENT_WINDOW, SUMMARY_TRIGGER } from "./context";
import type { RelationshipStage } from "@prisma/client";

/* §14. Thresholds are message counts because that is what MVP has; affinity is
   tracked alongside so the boundaries can move to something better without a
   migration. Never shown to users. */
function stageFor(messageCount: number): RelationshipStage {
  if (messageCount >= 400) return "DEEP";
  if (messageCount >= 150) return "ESTABLISHED";
  if (messageCount >= 50) return "FAMILIAR";
  if (messageCount >= 10) return "ACQUAINTED";
  return "NEW";
}

export interface RelationshipUpdate {
  stage: RelationshipStage;
  stageChanged: boolean;
  messageCount: number;
}

/** One user turn plus one Muse reply counts as a single interaction. */
export async function recordInteraction(userId: string, museId: string): Promise<RelationshipUpdate> {
  const existing = await prisma.relationship.findUnique({
    where: { userId_museId: { userId, museId } },
    select: { stage: true, messageCount: true },
  });

  const messageCount = (existing?.messageCount ?? 0) + 2;
  const stage = stageFor(messageCount);

  await prisma.relationship.upsert({
    where: { userId_museId: { userId, museId } },
    create: {
      userId, museId,
      messageCount, interactionCount: 1, stage,
      /* A rough proxy while there is nothing better: how much someone talks to
         a Muse is the only affinity signal MVP actually has. */
      affinityScore: 1,
    },
    update: {
      messageCount,
      interactionCount: { increment: 1 },
      lastInteractionAt: new Date(),
      stage,
      affinityScore: { increment: 1 },
    },
  });

  await prisma.muse.update({
    where: { id: museId },
    data: { interactionCount: { increment: 1 } },
  }).catch(() => { /* denormalised counter; not worth failing over */ });

  return { stage, stageChanged: (existing?.stage ?? "NEW") !== stage, messageCount };
}

/** §11. Runs over the turn just completed, against what is already known so the
 *  extractor does not keep re-recording the same fact. */
export async function extractAndStoreMemories(opts: {
  userId: string;
  museId: string;
  turn: ChatMessage[];
  sourceMessageId?: string;
}): Promise<number> {
  const { userId, museId, turn, sourceMessageId } = opts;

  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { memoryEnabled: true },
    });
    if (user?.memoryEnabled === false) return 0;

    const existing = await prisma.memory.findMany({
      where: { userId, museId },
      select: { content: true },
      orderBy: { createdAt: "desc" },
      take: 60,
    });

    const extracted = await getProvider().extractMemories(
      turn,
      existing.map((m) => m.content)
    );
    if (!extracted.length) return 0;

    /* The model is told not to repeat known facts but does anyway, so dedupe
       here too. Exact-match on normalised text only -- near-duplicate merging
       needs the embeddings below and is not worth the extra calls yet. */
    const known = new Set(existing.map((m) => m.content.trim().toLowerCase()));
    const fresh = extracted.filter((m) => !known.has(m.content.trim().toLowerCase()));
    if (!fresh.length) return 0;

    /* Solo-only kinds -- a promise the Muse made, and one kept -- have no
       place in the database, which records facts about the user. */
    type Stored = Exclude<(typeof fresh)[number]["type"], "PROMISE" | "DONE">;
    const keep = fresh.filter((m): m is (typeof fresh)[number] & { type: Stored } => m.type !== "PROMISE" && m.type !== "DONE");
    if (!keep.length) return 0;

    const embedder = getEmbeddingProvider();
    const embeddings = await Promise.all(
      keep.map((m) => embedder?.generateEmbedding(m.content).catch(() => null) ?? Promise.resolve(null))
    );

    await prisma.memory.createMany({
      data: keep.map((m, i) => ({
        userId, museId,
        content: m.content,
        /* The database has no SHARED kind; it is closest to RELATIONSHIP. */
        type: m.type === "SHARED" ? "RELATIONSHIP" : m.type,
        importance: m.importance,
        confidence: m.confidence,
        embedding: embeddings[i] ?? [],
        sourceMessageId: sourceMessageId ?? null,
      })),
    });

    return keep.length;
  } catch (err) {
    console.error("memory extraction failed", err);
    return 0;
  }
}

/** §10 layer B. Once enough turns have fallen out of the verbatim window,
 *  fold them into the rolling summary so old context survives in bounded form. */
export async function maybeSummarize(conversationId: string): Promise<boolean> {
  try {
    const total = await prisma.message.count({
      where: { conversationId, senderType: { in: ["USER", "MUSE"] } },
    });
    const older = total - RECENT_WINDOW;
    if (older < SUMMARY_TRIGGER) return false;

    const convo = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { summary: true },
    });

    const toFold = await prisma.message.findMany({
      where: { conversationId, senderType: { in: ["USER", "MUSE"] } },
      orderBy: { createdAt: "asc" },
      take: older,
      select: { senderType: true, content: true },
    });

    const transcript = toFold
      .map((m) => `${m.senderType === "USER" ? "User" : "Muse"}: ${m.content}`)
      .join("\n");

    const summary = await getProvider().summarize(
      convo?.summary ? `Summary so far:\n${convo.summary}\n\nNewer turns:\n${transcript}` : transcript,
      "Update the running summary of this relationship in under 150 words. Keep what the " +
        "user cares about, decisions, plans, and anything unresolved. Drop small talk. " +
        "Write plainly, no preamble, no headings."
    );

    await prisma.conversation.update({
      where: { id: conversationId },
      data: { summary },
    });
    return true;
  } catch (err) {
    console.error("summarisation failed", err);
    return false;
  }
}
