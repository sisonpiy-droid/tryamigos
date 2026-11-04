/* Editing a Muse, and how they feel.
 *
 * Two things worth pinning down because both fail quietly.
 *
 * The overlay: a starter is not stored, so its edits are kept against its id
 * and replayed. If that ever turned into "copy the starter under a new id", the
 * copy would carry no conversation and no memories, and the user would open a
 * character they had talked to for a week and find a stranger. The id is the
 * thing being tested, not the fields.
 *
 * The precedence: feelings are standing, a vibe is for today. A standing gloom
 * that overrode "be teasing with me today" would make the vibe panel look
 * broken, which is the exact complaint that got the panel built in the first
 * place.
 */
import assert from "node:assert";
import { PERSONAS } from "../src/lib/personas.ts";
import { feelingsBlock, personaSystem } from "../src/lib/presence/persona.ts";
import { applyPatch } from "../src/lib/solo/store.ts";

const results = [];
const check = (n, f) => results.push([n, f]);

const maya = {
  ...PERSONAS[0],
  id: "builtin-maya",
  builtin: true,
  persona: {
    them: PERSONAS[0].name, you: "", relationship: PERSONAS[0].relationshipType,
    arch: PERSONAS[0].arch, texture: PERSONAS[0].texture, mode: PERSONAS[0].mode,
    brief: PERSONAS[0].brief, samples: PERSONAS[0].samples, extra: PERSONAS[0].extra,
  },
};

const draft = { them: "Maya", you: "Sam", relationship: "best friend", arch: "friend", texture: "close", mode: "character", brief: "x" };
const plain = { mood: "any", topic: "any", register: "texts" };

/* --------------------------------------------------------------- the roster */

check("every starter carries the Presence fields the vibe panel needs", () => {
  for (const p of PERSONAS) {
    for (const f of ["arch", "texture", "mode", "brief", "samples", "extra"]) {
      assert.ok(p[f]?.trim(), `${p.name} is missing ${f}, so mood and register will do nothing for them`);
    }
    assert.equal(p.mode, "character", `${p.name} must be an invented character`);
  }
});

check("starters are distinct from each other, not one voice with several names", () => {
  const seen = new Map();
  for (const p of PERSONAS) {
    assert.ok(!seen.has(p.samples), `${p.name} and ${seen.get(p.samples)} share sample messages`);
    seen.set(p.samples, p.name);
  }
  assert.equal(new Set(PERSONAS.map((p) => p.name)).size, PERSONAS.length, "duplicate names");
});

/* ------------------------------------------------------------- the overlay */

check("editing a starter keeps its id, so the conversation survives", () => {
  const edited = applyPatch(maya, { name: "Maya B", relationshipType: "oldest friend" });
  assert.equal(edited.id, maya.id, "a new id would orphan the thread and the memories");
  assert.equal(edited.name, "Maya B");
});

check("a rename reaches the prompt, not just the card", () => {
  const edited = applyPatch(maya, { name: "Maya B", relationshipType: "oldest friend" });
  assert.equal(edited.persona.them, "Maya B", "the model would still answer to the old name");
  assert.equal(edited.persona.relationship, "oldest friend");
});

check("an untouched field is left alone", () => {
  const edited = applyPatch(maya, { name: "Maya B" });
  assert.equal(edited.persona.brief, maya.persona.brief);
  assert.equal(edited.persona.samples, maya.persona.samples);
});

check("a field emptied on purpose is honoured", () => {
  const edited = applyPatch(maya, { samples: "" });
  assert.equal(edited.persona.samples, "", "clearing samples must not fall back to the original");
});

check("a character with no profile gets one once a brief is written", () => {
  const bare = { id: "made-1", builtin: false, name: "Ravi", description: "d", relationshipType: "friend", category: "Personal", traits: [] };
  assert.equal(applyPatch(bare, { description: "d2" }).persona, undefined, "no brief, no profile");
  const rescued = applyPatch(bare, { brief: "You text in one line and never punctuate." });
  assert.ok(rescued.persona, "writing a brief should be enough to rescue an old character");
  assert.equal(rescued.persona.them, "Ravi");
  assert.equal(rescued.persona.mode, "character");
});

/* ------------------------------------------------------------- the feelings */

check("a standing state reaches the prompt", () => {
  const sys = personaSystem(draft, [], false, plain, undefined, {
    mood: "prickly", warmth: "off", note: "Her landlord is selling the flat.",
  });
  assert.match(sys, /WHERE YOU ARE IN YOUR OWN LIFE AT THE MOMENT/);
  assert.match(sys, /landlord is selling the flat/);
  assert.match(sys, /irritable/, "the standing mood block is missing");
});

check("no standing state means no block at all", () => {
  const sys = personaSystem(draft, [], false, plain, undefined, { mood: "any", warmth: "normal", note: "" });
  assert.ok(!sys.includes("WHERE YOU ARE IN YOUR OWN LIFE"), "an empty state must not add an empty section");
});

check("omitting feelings gives byte-for-byte the prompt it always gave", () => {
  const before = personaSystem(draft, [], false, plain, "Asia/Kolkata");
  const after = personaSystem(draft, [], false, plain, "Asia/Kolkata", { mood: "any", warmth: "normal", note: "" });
  assert.equal(before, after, "the feelings parameter must be additive");
});

check("today's mood beats a standing one, and the rest still carries", () => {
  const sys = personaSystem(draft, [], false, { ...plain, mood: "teasing" }, undefined, {
    mood: "prickly", warmth: "off", note: "Exams next week.",
  });
  assert.match(sys, /mischievous/, "the mood asked for today should be in force");
  assert.ok(!/You are irritable/.test(sys), "a standing mood must stand down when today's is set");
  assert.match(sys, /Exams next week/, "the note is not a mood and should carry regardless");
  assert.match(sys, /unresolved/, "warmth is not a mood either");
});

check("warmth and mood are separate axes", () => {
  const f = { mood: "warm", warmth: "distant", note: "" };
  const block = feelingsBlock(f, { them: "Maya", you: "Sam" }, true);
  assert.match(block, /good mood/, "a cheerful person can still be keeping you at arm's length");
  assert.match(block, /pulled back/i);
});

check("the standing state tells them not to announce it", () => {
  const block = feelingsBlock({ mood: "any", warmth: "normal", note: "Job hunting." }, { them: "Maya", you: "Sam" }, true);
  assert.match(block, /Do not open with it/);
  assert.match(block, /Nobody announces their own state/);
});

let pass = 0, fail = 0;
for (const [n, f] of results) {
  try { await f(); console.log(`  PASS  ${n}`); pass++; }
  catch (e) { console.log(`  FAIL  ${n}\n        ${e.message}`); fail++; }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
