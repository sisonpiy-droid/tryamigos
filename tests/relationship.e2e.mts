/* §67 — "the most important product test".
 *
 * Day 1  user tells Maya about an interview
 * Day 2  user returns; Maya should still have the context
 * Day 4  user says they got the job
 * Day 7  the interview should still be known
 *
 * Runs against the real database and the real model. Not a unit test: it costs
 * a few model calls and a few seconds, which is the price of knowing whether
 * the thing the product is actually for works.
 *
 *   npm run test:e2e
 */

import { config } from "dotenv";
config({ path: ".env.local" });

const { prisma } = await import("../src/lib/db.ts");
const { runTurn } = await import("../src/lib/muse/turn.ts");
const { buildContext } = await import("../src/lib/muse/context.ts");

const EMAIL = `e2e-${Date.now()}@example.test`;
let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`); fail++; }
};

const user = await prisma.user.create({
  data: { email: EMAIL, name: "Rahul", timezone: "Asia/Kolkata" },
});

const muse = await prisma.muse.create({
  data: {
    ownerUserId: user.id,
    name: "Maya",
    description: "Your brutally honest best friend who remembers the details you forget.",
    relationshipType: "best friend",
    visibility: "PRIVATE",
    personality: {
      create: {
        traits: ["funny", "direct", "caring", "sarcastic"],
        customInstructions: "Challenge me when I'm making excuses.",
        tone: "warm but blunt",
        sentenceLength: "short",
      },
    },
    behaviour: { create: {} },
  },
  include: { personality: true, behaviour: true },
});

const conversation = await prisma.conversation.create({
  data: { userId: user.id, museId: muse.id },
});

const turn = (content: string) =>
  runTurn({ userId: user.id, muse, conversationId: conversation.id, content, awaitAftercare: true });

try {
  // ---------------------------------------------------------------- day 1
  console.log("\nDay 1 — telling Maya about the interview");
  const d1 = await turn("I have an interview on Friday and I'm terrified. It's for a product manager job.");
  console.log(`  Maya: ${d1.text.slice(0, 140)}`);
  ok("Maya replied", d1.text.length > 0);

  const afterDay1 = await prisma.memory.findMany({
    where: { userId: user.id, museId: muse.id },
    select: { content: true, type: true, importance: true },
  });
  console.log(`  remembered: ${afterDay1.map((m) => `[${m.type}] ${m.content}`).join(" | ") || "(nothing)"}`);
  ok("something was remembered", afterDay1.length > 0);
  ok(
    "the interview specifically was remembered",
    afterDay1.some((m) => /interview/i.test(m.content)),
    `got: ${JSON.stringify(afterDay1.map((m) => m.content))}`
  );

  // ---------------------------------------------------------------- day 2
  console.log("\nDay 2 — returning");
  const ctx = await buildContext({
    userId: user.id, muse, conversationId: conversation.id,
    userMessage: "I'm so nervous about Friday, I can't sleep",
  });
  const injected = ctx.system.includes("WHAT YOU KNOW ABOUT THEM");
  ok("relevant memory reached the prompt", injected && /interview/i.test(ctx.system));
  ok("the prompt never leaks how memory works", !/embedding|vector|retriev/i.test(ctx.system));

  const d2 = await turn("I'm so nervous about Friday, I can't sleep.");
  console.log(`  Maya: ${d2.text.slice(0, 140)}`);
  /* The point is not that she repeats the word "interview" -- a good friend
     would not -- but that she does not ask what Friday is. */
  ok("Maya did not ask for context she already has",
     !/what('s| is) (happening )?(on )?friday|what interview|which interview|what job|remind me what/i.test(d2.text),
     `got: ${d2.text}`);

  // ---------------------------------------------------------------- day 4
  console.log("\nDay 4 — the news");
  const d4 = await turn("I got the job!");
  console.log(`  Maya: ${d4.text.slice(0, 140)}`);
  ok("Maya responded to the news", d4.text.length > 0);

  // ---------------------------------------------------------------- day 7
  console.log("\nDay 7 — still knows");
  const all = await prisma.memory.findMany({
    where: { userId: user.id, museId: muse.id },
    select: { id: true, content: true, type: true },
  });
  console.log(`  memories now: ${all.length}`);
  for (const m of all) console.log(`    [${m.type}] ${m.content}`);
  ok("the job is remembered as well as the interview",
     all.some((m) => /got the job|hired|offer|accepted|new job|product manager/i.test(m.content)),
     `got: ${JSON.stringify(all.map((m) => m.content))}`);

  /* A fresh thread, so the query carries no recent-message context. Inside an
     active conversation retrieval deliberately inherits the last few turns --
     that is continuity, not noise -- so the honest test of the relevance gate
     is an unrelated opener with nothing around it. */
  const fresh = await prisma.conversation.create({
    data: { userId: user.id, museId: muse.id },
  });
  const vague = await buildContext({
    userId: user.id, muse, conversationId: fresh.id,
    userMessage: "what should I cook tonight",
  });
  ok("an unrelated question does not drag in every memory",
     vague.usedMemoryIds.length < all.length,
     `injected ${vague.usedMemoryIds.length} of ${all.length} on an unrelated question`);

  // ------------------------------------------------------- §59 deletion
  console.log("\nDeletion (§59)");
  const target = all.find((m) => /interview/i.test(m.content)) ?? all[0];
  await prisma.memory.delete({ where: { id: target.id } });
  const after = await buildContext({
    userId: user.id, muse, conversationId: conversation.id,
    userMessage: "tell me about the interview",
  });
  ok("a deleted memory is never retrieved again",
     !after.usedMemoryIds.includes(target.id) && !after.system.includes(target.content),
     `deleted: ${target.content}`);

  // ------------------------------------------------- §14 relationship
  const rel = await prisma.relationship.findUnique({
    where: { userId_museId: { userId: user.id, museId: muse.id } },
  });
  console.log(`\nRelationship: stage=${rel?.stage} messages=${rel?.messageCount}`);
  ok("relationship metadata was updated", (rel?.messageCount ?? 0) >= 6);
  ok("stage is NEW this early", rel?.stage === "NEW");

  // --------------------------------------------------- §12 memory off
  await prisma.user.update({ where: { id: user.id }, data: { memoryEnabled: false } });
  const off = await buildContext({
    userId: user.id, muse, conversationId: conversation.id,
    userMessage: "tell me about the interview",
  });
  ok("memoryEnabled=false means nothing is retrieved at all",
     off.usedMemoryIds.length === 0 && !off.system.includes("WHAT YOU KNOW ABOUT THEM"));
} finally {
  await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}
