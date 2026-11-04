/* Context assembly (PRD §9, §10, §13).
 *
 * §9 is explicit: do NOT send the whole conversation on every request. So a
 * turn is built from four bounded pieces —
 *
 *   permanent + relationship memories, retrieved by relevance
 *   a rolling summary of everything older than the window
 *   the last N turns verbatim
 *   the message just sent
 *
 * — which keeps cost flat as a relationship gets long (§53) instead of growing
 * without limit, while still letting a Muse know things from months ago.
 */

import { getEmbeddingProvider } from "@/lib/ai";
import { prisma } from "@/lib/db";
import { rankMemories } from "@/lib/memory/rank";
import { buildMuseSystemPrompt } from "@/lib/muse/prompt";
import type { ChatMessage } from "@/lib/ai/types";
import type { MuseWithConfig } from "@/lib/authorize";

/** Turns kept verbatim. Beyond this, history reaches the model as a summary. */
export const RECENT_WINDOW = 20;
/** Turns that must accumulate past the window before it is worth re-summarising. */
export const SUMMARY_TRIGGER = 10;

const MAX_MEMORIES = 8;

export interface BuiltContext {
  system: string;
  messages: ChatMessage[];
  /** Ids of the memories used, so lastRetrievedAt can be updated after. */
  usedMemoryIds: string[];
}

export async function buildContext(opts: {
  userId: string;
  muse: MuseWithConfig;
  conversationId: string;
  userMessage: string;
}): Promise<BuiltContext> {
  const { userId, muse, conversationId, userMessage } = opts;

  const [user, conversation, relationship] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, timezone: true, memoryEnabled: true },
    }),
    prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { summary: true },
    }),
    prisma.relationship.findUnique({
      where: { userId_museId: { userId, museId: muse.id } },
      select: { stage: true, messageCount: true, lastInteractionAt: true },
    }),
  ]);

  const recent = await prisma.message.findMany({
    where: { conversationId, senderType: { in: ["USER", "MUSE"] } },
    orderBy: { createdAt: "desc" },
    take: RECENT_WINDOW,
    select: { senderType: true, content: true },
  });
  recent.reverse();

  /* §12: memory can be switched off entirely, and off must mean off -- not
     "retrieved but unused". Nothing is read when it is disabled. */
  let memories: string[] = [];
  let usedMemoryIds: string[] = [];

  if (user?.memoryEnabled !== false) {
    const stored = await prisma.memory.findMany({
      where: { userId, museId: muse.id },
      select: {
        id: true, content: true, type: true, importance: true,
        confidence: true, embedding: true, createdAt: true, lastRetrievedAt: true,
      },
      /* Bounded so a long relationship cannot turn every message into a huge
         read. Ranking happens over this slice, newest and most important first. */
      orderBy: [{ importance: "desc" }, { createdAt: "desc" }],
      take: 300,
    });

    if (stored.length) {
      /* The query is embedded, not just the last message: retrieval should
         follow what is being talked about, and a two-word reply carries almost
         no signal on its own. */
      const queryText = [
        ...recent.slice(-3).map((m) => m.content),
        userMessage,
      ].join("\n");

      const queryEmbedding = await getEmbeddingProvider()
        ?.generateEmbedding(queryText)
        .catch(() => null);

      const ranked = rankMemories(queryText, stored, {
        queryEmbedding,
        limit: MAX_MEMORIES,
      });

      memories = ranked.map((r) => r.memory.content);
      usedMemoryIds = ranked.map((r) => r.memory.id);
    }
  }

  const system = buildMuseSystemPrompt({
    name: muse.name,
    description: muse.description,
    relationshipType: muse.relationshipType,
    languages: muse.languages,
    personality: muse.personality,
    userName: user?.name ?? null,
    memories,
    conversationSummary: conversation?.summary ?? null,
    relationship: relationship ?? null,
    localTime: new Date(),
    timezone: user?.timezone,
  });

  const messages: ChatMessage[] = [
    ...recent.map((m) => ({
      role: (m.senderType === "USER" ? "user" : "assistant") as ChatMessage["role"],
      content: m.content,
    })),
    { role: "user", content: userMessage },
  ];

  return { system, messages, usedMemoryIds };
}

/** Marks retrieved memories as used. Best-effort: a failure here must not cost
 *  the user their reply, and the field only feeds diagnostics. */
export async function markRetrieved(ids: string[]): Promise<void> {
  if (!ids.length) return;
  try {
    await prisma.memory.updateMany({
      where: { id: { in: ids } },
      data: { lastRetrievedAt: new Date() },
    });
  } catch (err) {
    console.error("markRetrieved failed", err);
  }
}
