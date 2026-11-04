/* Tabs, traits, replies and double texts.
 *
 * Each of these failed quietly before it was fixed: traits were saved and
 * shown and never sent, and a reply written while the user double-texted
 * landed under the wrong message and left the second one unanswered forever.
 */
import assert from "node:assert";
import { MADE_TAB, PERSONAS, TABS, TAB_MAX } from "../src/lib/personas.ts";
import { circleBlock, circleHistory, personaSystem, withQuote } from "../src/lib/presence/persona.ts";
import {
  MEMORIES_PER_TURN, builtinMuses, insertAfter, memoriesForTurn, newMessage, promptPersona, quoteOf,
  rewindTo, tabOf, windowOf,
} from "../src/lib/solo/store.ts";

const results = [];
const check = (n, f) => results.push([n, f]);

const draft = { them: "Maya", you: "Sam", relationship: "best friend", arch: "friend", texture: "close", mode: "character", brief: "x" };
const plain = { mood: "any", topic: "any", register: "texts" };

/* ------------------------------------------------------------------ tabs */

check("every starter sits in one of the tabs", () => {
  const ids = TABS.map((t) => t.id);
  for (const p of PERSONAS) assert.ok(ids.includes(p.category), `${p.name} is under "${p.category}", which is not a tab`);
});

check("each starter tab holds four to six people", () => {
  for (const t of TABS) {
    const n = PERSONAS.filter((p) => p.category === t.id).length;
    assert.ok(n >= 4 && n <= TAB_MAX, `${t.id} has ${n}`);
  }
});

check("anyone the user built goes under their own tab", () => {
  assert.equal(tabOf({ category: "Personal" }), MADE_TAB);
  assert.equal(tabOf({ category: "Public" }), MADE_TAB);
  assert.equal(tabOf({ category: "Family" }), "Family");
});

/* ---------------------------------------------------------------- traits */

check("traits on the card reach the prompt", () => {
  const maya = builtinMuses().find((m) => m.name === "Maya");
  const p = promptPersona({ ...maya, traits: ["blunt", "dramatic"] }, "Sam");
  assert.deepEqual(p.traits, ["blunt", "dramatic"]);
  const sys = personaSystem(p, [], false, plain);
  assert.match(sys, /YOUR TRAITS/);
  assert.match(sys, /blunt, dramatic/);
  assert.match(sys, /go with these/, "a trait has to beat a profile that disagrees with it");
});

check("no traits means no traits block", () => {
  assert.ok(!personaSystem(draft, [], false, plain).includes("YOUR TRAITS"));
  assert.equal(personaSystem(draft, [], false, plain), personaSystem({ ...draft, traits: [] }, [], false, plain));
});

check("someone with no profile has no persona to send", () => {
  assert.equal(promptPersona({ id: "x", name: "x", traits: ["a"] }, "Sam"), null);
});

/* --------------------------------------------------------------- circles */

check("the room's topic and traits reach every member", () => {
  const block = circleBlock({
    you: "Sam", me: "Maya", circleName: "The group",
    others: [{ name: "Dev", relationship: "friend", traits: ["funny"] }],
    topic: "Planning Goa", roomTraits: ["chaotic"],
  });
  assert.match(block, /Planning Goa/);
  assert.match(block, /chaotic/);
  assert.match(block, /Dev, Sam's friend \(funny\)/, "the others should know who they are dealing with");
});

check("an unset room adds nothing", () => {
  const block = circleBlock({ you: "Sam", me: "Maya", circleName: "G", others: [{ name: "Dev", relationship: "friend" }] });
  assert.ok(!block.includes("WHAT THIS CHAT IS ABOUT"));
  assert.ok(!block.includes("WHAT THIS GROUP IS LIKE"));
});

/* --------------------------------------------------------------- replies */

check("a reply carries the line it answers", () => {
  assert.equal(withQuote("yes", { who: "you", text: "coming tonight?" }), `[replying to you: "coming tonight?"]\nyes`);
  assert.equal(withQuote("yes"), "yes");
});

check("in a room, a reply to someone's own line reads as 'you' to them", () => {
  const log = [
    { from: "muse", speakerId: "maya", content: "who's driving" },
    { from: "user", content: "me", quote: { from: "muse", speakerId: "maya", content: "who's driving" } },
  ];
  const forMaya = circleHistory(log, "maya", "Sam", () => "Maya");
  assert.match(forMaya[1].content, /replying to you: "who's driving"/);
  /* For Dev both lines are someone else's, so they merge into one turn. */
  const forDev = circleHistory(log, "dev", "Sam", () => "Maya");
  assert.match(forDev[0].content, /Sam: \[replying to Maya: "who's driving"\]/);
});

check("a quote points at the message it answers", () => {
  const a = newMessage("muse", "one");
  const b = newMessage("user", "two", { replyTo: a.id });
  assert.equal(quoteOf([a, b], b)?.id, a.id);
  assert.equal(quoteOf([b], b), undefined, "a deleted original is simply missing");
});

/* ----------------------------------------------------- double texts, edits */

const state = (log) => ({ userName: "Sam", muses: [], memories: [], conversations: { t: log } });

check("a reply lands under the message it answered, not the one sent while it was written", () => {
  const first = newMessage("user", "hey");
  const second = newMessage("user", "actually wait");
  const answer = newMessage("muse", "hi");
  const log = insertAfter(state([first, second]), "t", first.id, [answer]).conversations.t;
  assert.deepEqual(log.map((m) => m.content), ["hey", "hi", "actually wait"]);
  assert.equal(log[log.length - 1].from, "user", "the second text must still be waiting for an answer");
});

check("with nothing sent in between, a reply simply follows", () => {
  const first = newMessage("user", "hey");
  const log = insertAfter(state([first]), "t", first.id, [newMessage("muse", "hi")]).conversations.t;
  assert.deepEqual(log.map((m) => m.content), ["hey", "hi"]);
});

check("redoing from an edit keeps the edited line and drops what came after", () => {
  const a = newMessage("user", "a");
  const b = newMessage("muse", "b");
  const c = newMessage("user", "c");
  const log = rewindTo(state([a, b, c]), "t", a.id).conversations.t;
  assert.deepEqual(log.map((m) => m.content), ["a"]);
});

/* ---------------------------------------------------------------- memory */

const mem = (content, type, importance, createdAt) => ({
  id: content, museId: "aditi", content, type, importance, confidence: 1, createdAt,
});

check("what they told you stays to hand after the subject moves on", () => {
  /* The reported case: told about working from home, asked a few messages
     later whether they were in the office. Retrieval against "lunch" never
     surfaces a memory about work. */
  const s = {
    userName: "Piyush", muses: [], conversations: {},
    memories: [
      mem("User is working from home this week.", "EVENT", 3, "2026-09-30T10:00:00Z"),
      mem("User's dog is called Bruno.", "PERMANENT", 4, "2026-09-01T10:00:00Z"),
    ],
  };
  const got = memoriesForTurn(s, "aditi", "what are you having for lunch", null);
  assert.ok(got.includes("User is working from home this week."), "the newest thing they said must come along");
  assert.ok(got.includes("User's dog is called Bruno."), "standing facts come along too");
});

check("there is a ceiling, and nobody else's memories get in", () => {
  const memories = Array.from({ length: 40 }, (_, i) =>
    mem(`User fact ${i}.`, "PERMANENT", (i % 5) + 1, `2026-09-${String((i % 28) + 1).padStart(2, "0")}T10:00:00Z`)
  );
  memories.push({ ...mem("Someone else's fact.", "PERMANENT", 5, "2026-09-30T11:00:00Z"), museId: "maya" });
  const got = memoriesForTurn({ userName: "P", muses: [], conversations: {}, memories }, "aditi", "", null);
  assert.ok(got.length <= MEMORIES_PER_TURN);
  assert.ok(!got.includes("Someone else's fact."));
});

check("a long conversation is kept by size, not the last twenty lines", () => {
  const log = Array.from({ length: 50 }, (_, i) => ({ content: `message ${i}` }));
  assert.equal(windowOf(log).length, 50, "fifty short texts fit easily -- twenty was about five exchanges");
  const big = Array.from({ length: 10 }, () => ({ content: "x".repeat(5000) }));
  const w = windowOf(big);
  assert.ok(w.length < 10 && w.length >= 1);
  assert.equal(w[w.length - 1], big[big.length - 1], "the newest message is always kept");
});

check("they may invent their own life, never yours", () => {
  const sys = personaSystem(draft, ["User is working from home."], false, plain);
  assert.match(sys, /Never invent details about theirs/);
  assert.match(sys, /check what they have already told you/);
  assert.match(sys, /never ask what you already know/);
});

let pass = 0, fail = 0;
for (const [n, f] of results) {
  try { await f(); console.log(`  PASS  ${n}`); pass++; }
  catch (e) { console.log(`  FAIL  ${n}\n        ${e.message}`); fail++; }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
