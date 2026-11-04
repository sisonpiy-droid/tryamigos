/* Unit tests for memory ranking (§62). No database, no network. */
import assert from "node:assert";
import { rankMemories, cosineSimilarity, lexicalSimilarity, recencyScore, standoutIndices } from "../src/lib/memory/rank.ts";

const results = [];
const check = (name, fn) => results.push([name, fn]);
const mem = (o) => ({
  id: o.id, content: o.content, type: o.type ?? "PERMANENT",
  importance: o.importance ?? 3, confidence: o.confidence ?? 0.8,
  embedding: o.embedding ?? null, createdAt: o.createdAt ?? new Date("2026-09-01"),
  lastRetrievedAt: null,
});

check("cosine similarity", () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(cosineSimilarity([1, 0], []), 0, "mismatched lengths must not throw");
});

check("lexical similarity ignores stopwords", () => {
  // "is"/"the"/"my" carry no signal; without stripping them every memory
  // would look vaguely relevant to every question.
  assert.ok(lexicalSimilarity("what is the name of my dog", "User's dog is called Bruno") > 0.4);
  assert.equal(lexicalSimilarity("the a is of", "anything at all"), 0);
});

check("recency decays by half-life", () => {
  const now = new Date("2026-09-09");
  const old = new Date(now.getTime() - 45 * 86400000);
  assert.ok(Math.abs(recencyScore(old, now, 45) - 0.5) < 0.01);
  assert.ok(recencyScore(now, now, 45) > 0.99);
});

check("the dog scenario from §59", () => {
  const memories = [
    mem({ id: "dog", content: "User's dog is called Bruno." }),
    mem({ id: "job", content: "User works as an accountant in Leeds." }),
    mem({ id: "food", content: "User dislikes coriander." }),
  ];
  const out = rankMemories("How is Bruno doing?", memories);
  assert.equal(out[0].memory.id, "dog");
  assert.ok(!out.some((r) => r.memory.id === "food"), "unrelated memories must not be injected");
});

check("lexical mode: irrelevant memories are cut, not just ranked lower", () => {
  const memories = [
    // High importance, but nothing to do with the question. The blended score
    // would clear a naive threshold; similarity must gate it instead.
    mem({ id: "birthday", content: "User's birthday is 3rd March.", importance: 5, confidence: 1 }),
  ];
  const out = rankMemories("what did you think of that film", memories);
  assert.equal(out.length, 0, "a high-importance memory must still need to be relevant");
});

check("identity memories do not decay, events do", () => {
  const now = new Date("2026-09-09");
  const longAgo = new Date(now.getTime() - 400 * 86400000);
  const out = rankMemories("tell me about my dog", [
    mem({ id: "perm", content: "User's dog is called Bruno.", type: "PERMANENT", createdAt: longAgo }),
    mem({ id: "evt", content: "User's dog Bruno was at the vet.", type: "EVENT", createdAt: longAgo }),
  ], { now });
  assert.equal(out[0].memory.id, "perm", "a name stays true; a vet trip fades");
  assert.equal(out[0].parts.recency, 1);
  assert.ok(out[1].parts.recency < 0.01);
});

check("embeddings are used when both sides have them", () => {
  const out = rankMemories("anything", [
    mem({ id: "a", content: "no shared words whatsoever", embedding: [1, 0, 0] }),
  ], { queryEmbedding: [1, 0, 0] });
  assert.equal(out.length, 1, "semantic match should win despite zero lexical overlap");
  assert.ok(out[0].parts.similarity > 0.99);
});

/* These fixtures are real cosine values measured against gemini-embedding-001.
   They are the reason the gate is relative rather than absolute: every score
   sits between 0.50 and 0.65 whether the memory is relevant or not. */
check("a standout memory is kept", () => {
  //           interview  job    name   dog    coriander     query: "tell me about the interview"
  const sims = [0.654, 0.608, 0.550, 0.543, 0.525];
  const keep = standoutIndices(sims, 0.6, 0.012);
  assert.ok(keep.includes(0), "the interview memory must survive");
  assert.ok(!keep.includes(4), "coriander must not");
});

check("a vague opener injects nothing, because nothing stands out", () => {
  //           query: "how's things" -- everything scores alike
  const sims = [0.575, 0.573, 0.562, 0.559, 0.535];
  const keep = standoutIndices(sims, 1.2, 0.012);
  assert.ok(keep.length <= 1, `expected at most one, kept ${keep.length}`);
});

check("a flat set is treated as undifferentiated", () => {
  const keep = standoutIndices([0.55, 0.551, 0.549, 0.55], 0.6, 0.012);
  assert.deepEqual(keep, [], "no spread means nothing is distinctively relevant");
});

check("an absolute threshold would have admitted everything", () => {
  // The bug this replaced: 0.25 absolute passes all five, relevant or not.
  const sims = [0.585, 0.550, 0.528, 0.520, 0.512];
  assert.equal(sims.filter((s) => s >= 0.25).length, 5);
  assert.ok(standoutIndices(sims, 0.6, 0.012).length < 5);
});

check("limit is respected and order is by score", () => {
  const memories = Array.from({ length: 20 }, (_, i) =>
    mem({ id: `m${i}`, content: `User likes football and team number ${i}`, importance: (i % 5) + 1 })
  );
  const out = rankMemories("football", memories, { limit: 3 });
  assert.equal(out.length, 3);
  assert.ok(out[0].score >= out[1].score && out[1].score >= out[2].score);
});

/* Retrieval has to survive a conversation, not just its opening line.
 *
 * lexicalSimilarity used to divide by the query's token count, and solo mode
 * retrieves against the last four messages. So the score fell as the thread grew
 * and a one-sentence memory could not clear the 0.25 gate against a realistic
 * 15-30 term query no matter how relevant it was. It worked on the first message
 * of a fresh thread -- a demo, and every test here before these ones -- and was
 * dead for the life of the character afterwards, while the card kept saying
 * "remembers 47". These pin the property that was missing: relevance must not
 * depend on how much has been said. */

const bruno = "User's dog is called Bruno.";

check("relevance stops decaying once the query is bigger than the memory", () => {
  /* The property that was missing. Under the old measure every extra word in
     the query lowered the score without limit -- 1/2, then 1/8, then 1/20 --
     so a thread could always outgrow its own memories. Dividing by the smaller
     set means that past |query| >= |memory| the score is hits/|memory| and
     stops moving, however much more gets said. It does drop once from the
     opening line, where the query is the smaller set; what matters is that it
     converges instead of collapsing. */
  const four = [
    "how is bruno",
    "he is good, ate my shoe though",
    "ha, classic. anyway how was your day",
    "long. i am shattered honestly",
  ].join("\n");
  const ten = [four,
    "did you eat",
    "not yet, going to order something in a bit",
    "get the thai place, the one near the station",
    "yeah maybe. what are you up to tomorrow",
    "nothing much, might go for a run if it stays dry",
    "sounds good, i might join you actually",
  ].join("\n");

  const a = lexicalSimilarity(four, bruno);
  const b = lexicalSimilarity(ten, bruno);
  assert.ok(a > 0, "sanity: bruno is named in the window");
  assert.equal(b, a, `score must not move as the thread grows: ${a} -> ${b}`);

  // And it is still actually retrieved at that length, which is the point.
  const out = rankMemories(ten, [
    mem({ id: "bruno", content: bruno }),
    mem({ id: "other", content: "User works as a structural engineer." }),
  ], {});
  assert.equal(out[0]?.memory.id, "bruno", "retrieval must survive a real conversation");
});

check("the four-message window still retrieves the obvious memory", () => {
  const query = [
    "hey love, how was the thing today?",
    "it was fine, long day though",
    "i am trying to figure out what to get priya for the wedding",
  ].join("\n");

  const out = rankMemories(query, [
    mem({ id: "priya", content: "User's sister Priya is getting married in December." }),
    mem({ id: "job", content: "User works as a structural engineer." }),
    mem({ id: "cat", content: "User is allergic to cats." }),
  ], {});

  assert.ok(out.length > 0, "the user named Priya and the Priya memory was dropped");
  assert.equal(out[0].memory.id, "priya");
});

check("one shared proper noun is enough to stand out", () => {
  /* 1 hit against a six-term memory scores 0.17 -- under any sane fixed floor,
     and obviously the right answer when nothing else scores at all. */
  const out = rankMemories(
    "did you hear back about the thing in december yet or are they still deciding",
    [
      mem({ id: "hit", content: "User's sister Priya is getting married in December." }),
      mem({ id: "a", content: "User drinks coffee black." }),
      mem({ id: "b", content: "User supports Arsenal." }),
    ],
    {}
  );
  assert.equal(out[0]?.memory.id, "hit");
});

check("a long query about nothing in the set still injects nothing", () => {
  const out = rankMemories(
    "i went for a walk and then sat in the park for a bit reading my book",
    [
      mem({ id: "a", content: "User's dog is called Bruno." }),
      mem({ id: "b", content: "User works as a structural engineer." }),
    ],
    {}
  );
  assert.equal(out.length, 0, "unrelated context must not drag memories in");
});

check("a character with one memory does not recite it at everything", () => {
  /* standoutIndices returns a lone memory unconditionally, so the zero check is
     what stops the only memory being attached to every single turn. */
  const out = rankMemories("what do you want for dinner", [
    mem({ id: "only", content: "User's sister Priya is getting married in December." }),
  ], {});
  assert.equal(out.length, 0);
});

check("a memory is not punished for containing other things", () => {
  const wordy = lexicalSimilarity(
    "bruno",
    "User's dog is called Bruno and he is a nine year old collie from Leeds."
  );
  assert.ok(wordy > 0, "a longer memory containing the term must still match");
});

check("standing out is not enough on its own", () => {
  /* Measured with real 256-dimension vectors over five memories: a query that
     should recall nothing ("what should i cook tonight") scored 0.632 at z 1.63,
     while a genuinely relevant one ("my puppy chewed the sofa") scored 0.703 at
     z 1.51. The false positive had the HIGHER z, because z only asks whether one
     memory beat its neighbours and with a small set something always does. Both
     gates, or neither works. */
  const near = [1, 0, 0];
  const store = [
    mem({ id: "hit", content: "a", embedding: [0.64, 0.77, 0] }),   // cos ~0.64
    mem({ id: "b", content: "b", embedding: [0.60, 0.80, 0] }),
    mem({ id: "c", content: "c", embedding: [0.59, 0.81, 0] }),
  ];
  // The top scorer stands out, but no one clears an absolute bar of 0.66.
  assert.equal(rankMemories("x", store, { queryEmbedding: near }).length, 0);
  // Lower the bar and the same set is admitted, so the gate is what changed.
  assert.ok(rankMemories("x", store, { queryEmbedding: near, minCosine: 0.5 }).length > 0);
});

check("a strong match still gets through both gates", () => {
  const store = [
    mem({ id: "hit", content: "a", embedding: [0.98, 0.2, 0] }),
    mem({ id: "b", content: "b", embedding: [0.2, 0.98, 0] }),
    mem({ id: "c", content: "c", embedding: [0, 0.3, 0.95] }),
  ];
  const out = rankMemories("x", store, { queryEmbedding: [1, 0, 0] });
  assert.equal(out[0]?.memory.id, "hit");
});

let pass = 0, fail = 0;
for (const [name, fn] of results) {
  try { await fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
