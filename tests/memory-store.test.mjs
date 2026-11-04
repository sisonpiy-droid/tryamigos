/* What happens to memories over a long relationship.
 *
 * Every bug this pins is one that only appears after a character has been
 * talked to for a while, which is the exact window no amount of trying the app
 * covers. Three of them shipped:
 *
 *   - extraction died permanently at the 61st memory, because the client sent
 *     every memory it had as an advisory list and the route validated that list
 *     like input that mattered, then answered 200 with an empty array
 *   - one memory longer than 400 characters did the same at any count, and
 *     nothing bounded a memory's length when it was written
 *   - and then, fixing those, I added a cap and dropped every existing memory
 *     on the common path. That one survived a typecheck, a build and a manual
 *     read; it was caught by an audit, an hour after I wrote it.
 *
 * The through-line is that all three are invisible: the character keeps
 * replying, the card keeps counting, and nothing anywhere says a word.
 */
import assert from "node:assert";
import {
  addMemories, deleteMemory, editMemory, forgetAll, memoriesOf, worthRecalling,
  MEMORIES_PER_MUSE, MEMORY_CHARS,
} from "../src/lib/solo/store.ts";

const results = [];
const check = (n, f) => results.push([n, f]);

const blank = () => ({ userName: "Sam", muses: [], conversations: {}, memories: [] });

const say = (content, over = {}) => ({
  content, type: "PERMANENT", importance: 3, confidence: 0.9, ...over,
});

const mineOf = (state, id) => state.memories.filter((m) => m.museId === id);

check("adding a memory keeps the ones already there", () => {
  /* The regression. `others` is everyone else's memories, so returning
     [...others, ...added] silently wiped this character's entire history on
     every successful extraction -- while the header kept counting up, because
     it recounts from the state that had just been emptied. */
  let s = addMemories(blank(), "aditi", [say("User's sister is called Priya.")]);
  s = addMemories(s, "aditi", [say("User works as a structural engineer.")]);
  s = addMemories(s, "aditi", [say("User is allergic to cats.")]);

  assert.equal(mineOf(s, "aditi").length, 3, "each extraction must add, never replace");
  const texts = mineOf(s, "aditi").map((m) => m.content);
  assert.ok(texts.some((t) => t.includes("Priya")), "the first memory must survive the third");
});

check("one character's memories never touch another's", () => {
  let s = addMemories(blank(), "aditi", [say("User's sister is called Priya.")]);
  s = addMemories(s, "maya", [say("User supports Arsenal.")]);
  s = addMemories(s, "aditi", [say("User is allergic to cats.")]);

  assert.equal(mineOf(s, "aditi").length, 2);
  assert.equal(mineOf(s, "maya").length, 1, "writing to one Muse must not disturb another");
});

check("a memory too long to send is never stored in the first place", () => {
  /* The route rejected any entry over 400 characters, and rejecting the list
     rejected the whole request -- so a single long memory ended extraction for
     that character permanently. Clamped at the one place memories are made. */
  const s = addMemories(blank(), "aditi", [say("x".repeat(1200))]);
  const stored = mineOf(s, "aditi")[0];
  assert.ok(stored, "it should still be stored, just shorter");
  assert.ok(
    stored.content.length <= MEMORY_CHARS,
    `stored ${stored.content.length} chars, over the ${MEMORY_CHARS} the routes accept`
  );
});

check("nothing stored can ever exceed what the routes will accept", () => {
  let s = blank();
  for (let i = 0; i < 40; i++) {
    s = addMemories(s, "aditi", [say(`${"y".repeat(600)} ${i}`)]);
  }
  const over = s.memories.filter((m) => m.content.length > MEMORY_CHARS);
  assert.equal(over.length, 0, `${over.length} memories are longer than the routes allow`);
});

check("memories do not grow without bound", () => {
  let s = blank();
  for (let i = 0; i < MEMORIES_PER_MUSE + 120; i++) {
    s = addMemories(s, "aditi", [say(`Fact number ${i} about the user.`, { importance: (i % 5) + 1 })]);
  }
  assert.equal(
    mineOf(s, "aditi").length,
    MEMORIES_PER_MUSE,
    "a character talked to for a year must not rank thousands of memories every turn"
  );
});

check("what survives the cap is the important, then the recent", () => {
  let s = blank();
  for (let i = 0; i < MEMORIES_PER_MUSE + 50; i++) {
    // importance 5 only for the last fifty, so the cap must keep those.
    s = addMemories(s, "aditi", [
      say(`Fact ${i}.`, { importance: i >= MEMORIES_PER_MUSE ? 5 : 1 }),
    ]);
  }
  const kept = mineOf(s, "aditi");
  assert.equal(kept.length, MEMORIES_PER_MUSE);
  assert.ok(
    kept.filter((m) => m.importance === 5).length === 50,
    "forgetting must drop the trivial, not the things that matter"
  );
});

check("the same thing said twice is stored once", () => {
  let s = addMemories(blank(), "aditi", [say("User's sister is called Priya.")]);
  s = addMemories(s, "aditi", [say("user's SISTER is called priya.")]);
  assert.equal(mineOf(s, "aditi").length, 1, "dedup is case- and space-insensitive");
});

check("an empty extraction changes nothing", () => {
  const before = addMemories(blank(), "aditi", [say("User's sister is called Priya.")]);
  const after = addMemories(before, "aditi", []);
  assert.equal(after, before, "no new memories should not mean a new state object");
});

check("a blank memory is not stored", () => {
  const s = addMemories(blank(), "aditi", [say("   "), say("")]);
  assert.equal(mineOf(s, "aditi").length, 0);
});

/* ------------------------------------------- seeing and correcting memories */

/* Deleting is the one with a trap in it.
 *
 * Extraction runs over the last several messages every turn, and dedup only
 * compares against memories that currently exist. So a memory removed on
 * Tuesday gets re-proposed on Wednesday from the same conversation that
 * produced it, matches nothing, and comes back. Delete would appear to work and
 * then quietly undo itself, which is worse than not offering it -- the app
 * would look like it was ignoring the user. §59 says once deleted it must never
 * be retrieved, which means remembering the deletion, not just performing it.
 */

check("a deleted memory does not come back on the next extraction", () => {
  const wrong = "User's sister is called Neha.";
  let s = addMemories(blank(), "aditi", [say(wrong)]);
  assert.equal(memoriesOf(s, "aditi").length, 1);

  s = deleteMemory(s, memoriesOf(s, "aditi")[0].id);
  assert.equal(memoriesOf(s, "aditi").length, 0, "it should be gone immediately");

  // The next turn extracts the same fact from a conversation that still says it.
  s = addMemories(s, "aditi", [say(wrong)]);
  assert.equal(memoriesOf(s, "aditi").length, 0, "a deleted memory must stay deleted");
});

check("forgetting is case- and whitespace-insensitive, like the dedup it guards", () => {
  let s = addMemories(blank(), "aditi", [say("User's sister is called Neha.")]);
  s = deleteMemory(s, memoriesOf(s, "aditi")[0].id);
  s = addMemories(s, "aditi", [say("  user's SISTER is called neha.  ")]);
  assert.equal(memoriesOf(s, "aditi").length, 0);
});

check("forgetting one thing does not stop them learning anything else", () => {
  let s = addMemories(blank(), "aditi", [say("User's sister is called Neha.")]);
  s = deleteMemory(s, memoriesOf(s, "aditi")[0].id);
  s = addMemories(s, "aditi", [say("User's sister is called Priya.")]);
  assert.equal(memoriesOf(s, "aditi").length, 1, "the correction must be able to land");
  assert.match(memoriesOf(s, "aditi")[0].content, /Priya/);
});

check("one character forgetting does not mute another", () => {
  let s = addMemories(blank(), "aditi", [say("User works nights.")]);
  s = deleteMemory(s, memoriesOf(s, "aditi")[0].id);
  s = addMemories(s, "maya", [say("User works nights.")]);
  assert.equal(memoriesOf(s, "maya").length, 1, "tombstones are per character");
});

check("a corrected memory is treated as certain", () => {
  /* confidence is a ranking weight, so a hand-typed correction should also
     outrank the guess it replaced rather than merely sitting beside it. */
  let s = addMemories(blank(), "aditi", [say("User's sister is called Neha.", { confidence: 0.4 })]);
  const id = memoriesOf(s, "aditi")[0].id;
  s = editMemory(s, id, { content: "User's sister is called Priya." });
  const m = memoriesOf(s, "aditi")[0];
  assert.match(m.content, /Priya/);
  assert.equal(m.confidence, 1, "the user's own words are not a guess");
});

check("editing only importance leaves the wording and its confidence alone", () => {
  let s = addMemories(blank(), "aditi", [say("User is allergic to cats.", { confidence: 0.6 })]);
  const id = memoriesOf(s, "aditi")[0].id;
  s = editMemory(s, id, { importance: 5 });
  const m = memoriesOf(s, "aditi")[0];
  assert.equal(m.confidence, 0.6);
  assert.equal(m.importance, 5);
});

check("importance cannot be edited outside the scale it is ranked on", () => {
  let s = addMemories(blank(), "aditi", [say("User is allergic to cats.")]);
  const id = memoriesOf(s, "aditi")[0].id;
  assert.equal(memoriesOf(editMemory(s, id, { importance: 99 }), "aditi")[0].importance, 5);
  assert.equal(memoriesOf(editMemory(s, id, { importance: -4 }), "aditi")[0].importance, 1);
});

check("a correction cannot be made too long for the routes to accept", () => {
  let s = addMemories(blank(), "aditi", [say("short")]);
  const id = memoriesOf(s, "aditi")[0].id;
  s = editMemory(s, id, { content: "z".repeat(2000) });
  assert.ok(memoriesOf(s, "aditi")[0].content.length <= MEMORY_CHARS);
});

check("editing something that is not there changes nothing", () => {
  const s = addMemories(blank(), "aditi", [say("User is allergic to cats.")]);
  assert.deepEqual(editMemory(s, "nope", { content: "x" }).memories, s.memories);
  assert.equal(deleteMemory(s, "nope"), s);
});

check("forgetting everything clears them and stays cleared", () => {
  let s = blank();
  for (const t of ["User has a dog.", "User works nights.", "User hates coriander."]) {
    s = addMemories(s, "aditi", [say(t)]);
  }
  s = forgetAll(s, "aditi");
  assert.equal(memoriesOf(s, "aditi").length, 0);
  s = addMemories(s, "aditi", [say("User has a dog.")]);
  assert.equal(memoriesOf(s, "aditi").length, 0, "a wiped memory must not refill from the transcript");
});

check("memories are listed newest first", () => {
  let s = blank();
  s = addMemories(s, "aditi", [say("first")]);
  s = { ...s, memories: s.memories.map((m) => ({ ...m, createdAt: "2020-01-01T00:00:00.000Z" })) };
  s = addMemories(s, "aditi", [say("second")]);
  assert.equal(memoriesOf(s, "aditi")[0].content, "second");
});

/* ------------------------------------------- when a fact stops being true */

/* People change jobs, leave cities, quit smoking. The old fact does not become
 * a second fact — it stops being true. Measured before this existed: a user who
 * said they had quit engineering for photography ended up with a character
 * holding both, and both went into the same prompt.
 */

check("a fact that contradicts an old one replaces it", () => {
  const known = ["User works as a structural engineer at a firm in Pune.", "User's dog is called Bruno."];
  let s = blank();
  s = addMemories(s, "aditi", [say(known[0]), say(known[1])]);
  s = addMemories(
    s, "aditi",
    [say("User is now a full-time photographer.", { replaces: [0] })],
    known
  );
  const left = memoriesOf(s, "aditi").map((m) => m.content);
  assert.ok(left.some((c) => c.includes("photographer")), "the new fact must land");
  assert.ok(!left.some((c) => c.includes("structural engineer")), "the old one must go");
  assert.ok(left.some((c) => c.includes("Bruno")), "unrelated memories must be untouched");
});

check("a superseded fact cannot come back from the same conversation", () => {
  /* It has to be tombstoned like any other deletion, or the transcript that
     produced it re-proposes it on the next turn and the change is undone. */
  const known = ["User works as a structural engineer."];
  let s = addMemories(blank(), "aditi", [say(known[0])]);
  s = addMemories(s, "aditi", [say("User is now a photographer.", { replaces: [0] })], known);
  s = addMemories(s, "aditi", [say(known[0])]);
  assert.ok(
    !memoriesOf(s, "aditi").some((m) => m.content.includes("structural engineer")),
    "a replaced fact must stay replaced"
  );
});

check("an index pointing at nothing is ignored rather than deleting something", () => {
  /* A wrong index would destroy a memory the user never asked to lose, which is
     worse than keeping a stale one. */
  let s = addMemories(blank(), "aditi", [say("User's dog is called Bruno.")]);
  s = addMemories(s, "aditi", [say("User has a cat too.", { replaces: [7, -1] })], []);
  assert.equal(memoriesOf(s, "aditi").length, 2);
});

check("an additive detail replaces nothing", () => {
  const known = ["User's sister Priya is getting married in December."];
  let s = addMemories(blank(), "aditi", [say(known[0])]);
  s = addMemories(s, "aditi", [say("The wedding is in Pune.", { replaces: [] })], known);
  assert.equal(memoriesOf(s, "aditi").length, 2, "detail should add, not overwrite");
});

/* ------------------------------------------------ what is worth recalling */

check("a message with something in it is worth recalling against", () => {
  for (const q of [
    "i need a gift for the ceremony next month",
    "my puppy chewed the sofa again",
    "does priya know yet",
  ]) assert.ok(worthRecalling(q), q);
});

check("filler is not", () => {
  /* Measured: "hmm" embeds to a vector that scores 0.704 against "trying to
     quit smoking" -- higher than a genuinely relevant query scored on its own
     right answer. A character raising your smoking because you said "hmm" is
     worse than one that says nothing, and skipping these is also where most of
     the half-second of embedding latency is saved. */
  for (const q of ["hmm", "yeah", "ok", "yeah ok", "haan", "lol", "mmm"]) {
    assert.ok(!worthRecalling(q), `"${q}" should not trigger recall`);
  }
});

let pass = 0, fail = 0;
for (const [n, f] of results) {
  try { await f(); console.log(`  PASS  ${n}`); pass++; }
  catch (e) { console.log(`  FAIL  ${n}\n        ${e.message}`); fail++; }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
