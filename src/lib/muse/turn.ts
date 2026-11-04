/* One conversational turn, end to end (PRD §58).
 *
 * Lives here rather than in the route so the pipeline can be exercised without
 * HTTP -- §67's day-1/2/4/7 scenario is the real acceptance test for this
 * product, and it needs to run in CI, not by hand in a browser.
 *
 * The route is a thin SSE wrapper over this.
 */

import { getProvider } from "@/lib/ai";
import { prisma } from "@/lib/db";
import { extractAndStoreMemories, maybeSummarize, recordInteraction } from "./aftercare";
import { buildContext, markRetrieved } from "./context";
import type { MuseWithConfig } from "@/lib/authorize";

export interface TurnResult {
  userMessageId: string;
  museMessageId: string;
  text: string;
  /** Memories that were injected into this turn's context. */
  usedMemoryIds: string[];
}

export interface RunTurnOptions {
  userId: string;
  muse: MuseWithConfig;
  conversationId: string;
  content: string;
  /** Called for each streamed fragment. Omit to generate without streaming. */
  onDelta?: (text: string) => void;
  /** Await the after-turn work instead of letting it run detached. Tests need
   *  this; the route does not, because extraction is a second model call and
   *  would otherwise add seconds to every reply. */
  awaitAftercare?: boolean;
}

export async function runTurn(opts: RunTurnOptions): Promise<TurnResult> {
  const { userId, muse, conversationId, content, onDelta } = opts;

  /* Persisted before the model is called. If generation fails the user's own
     words are still there -- losing what someone typed is worse than an error. */
  const userMessage = await prisma.message.create({
    data: { conversationId, senderType: "USER", content },
    select: { id: true },
  });

  const { system, messages, usedMemoryIds } = await buildContext({
    userId, muse, conversationId, userMessage: content,
  });

  const provider = getProvider();
  let text = "";

  if (onDelta) {
    for await (const delta of provider.streamResponse({ system, messages })) {
      text += delta;
      onDelta(delta);
    }
  } else {
    text = (await provider.generateResponse({ system, messages })).text;
  }

  text = text.trim();
  if (!text) throw new Error("empty reply");

  const museMessage = await prisma.message.create({
    data: {
      conversationId,
      senderType: "MUSE",
      content: text,
      metadata: { model: provider.name },
    },
    select: { id: true, createdAt: true },
  });

  await prisma.conversation.update({
    where: { id: conversationId },
    data: { lastMessageAt: museMessage.createdAt },
  });

  const aftercare = async () => {
    await markRetrieved(usedMemoryIds);
    await recordInteraction(userId, muse.id);
    await extractAndStoreMemories({
      userId,
      museId: muse.id,
      /* The whole context window, not just this exchange. A message like
         "I'm nervous about Friday" is only extractable as "nervous about the
         interview" when the turn that named it is still in view. */
      turn: [...messages, { role: "assistant", content: text }],
      sourceMessageId: userMessage.id,
    });
    await maybeSummarize(conversationId);
  };

  if (opts.awaitAftercare) {
    await aftercare();
  } else {
    void aftercare().catch((err) => console.error("aftercare failed", err));
  }

  return {
    userMessageId: userMessage.id,
    museMessageId: museMessage.id,
    text,
    usedMemoryIds,
  };
}
