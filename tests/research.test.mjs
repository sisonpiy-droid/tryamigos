/* Reading the public-figure lookup, and the fictional mode it can lead to.
 *
 * A name that is several people used to come back as "couldn't find them", and
 * a fictional character was refused outright. Both are parsed here from the
 * shapes the search is asked for, including the bold and bullets grounding
 * tends to add.
 */
import assert from "node:assert";
import { briefSystem, personaSystem } from "../src/lib/presence/persona.ts";
import { parseCandidates, readResearch } from "../src/lib/presence/research.ts";

const results = [];
const check = (n, f) => results.push([n, f]);
const plain = { mood: "any", topic: "any", register: "texts" };

check("a real person: known-for, full name, and the briefing without its headers", () => {
  const r = readResearch("KNOWN FOR: Hindi film star\nFULL NAME: Shah Rukh Khan\n\nHe opens with a joke about himself.");
  assert.equal(r.kind, "found");
  assert.equal(r.fictional, false);
  assert.equal(r.knownFor, "Hindi film star");
  assert.equal(r.fullName, "Shah Rukh Khan");
  assert.equal(r.research, "He opens with a joke about himself.");
});

check("headers survive markdown bold", () => {
  const r = readResearch("**KNOWN FOR:** Javelin\n**FULL NAME:** Neeraj Chopra\nCalm.");
  assert.equal(r.knownFor, "Javelin");
  assert.equal(r.fullName, "Neeraj Chopra");
  assert.equal(r.research, "Calm.");
});

check("NOT_ENOUGH is none", () => {
  assert.equal(readResearch("NOT_ENOUGH").kind, "none");
  assert.equal(readResearch("**NOT_ENOUGH**").kind, "none");
});

check("an ambiguous name comes back as candidates", () => {
  const r = readResearch("WHICH:\n- Chris Hemsworth | Plays Thor\n- **Chris Evans** | Captain America\n3. Chris Martin | Coldplay singer");
  assert.equal(r.kind, "which");
  assert.deepEqual(r.candidates.map((c) => c.name), ["Chris Hemsworth", "Chris Evans", "Chris Martin"]);
  assert.equal(r.candidates[2].knownFor, "Coldplay singer");
});

check("a WHICH that then picks someone anyway has picked someone", () => {
  const r = readResearch("WHICH: none needed\nKNOWN FOR: Coldplay\nFULL NAME: Chris Martin\nSoft-spoken.");
  assert.equal(r.kind, "found");
  assert.equal(r.fullName, "Chris Martin");
});

check("one candidate is not a question", () => {
  assert.equal(parseCandidates("WHICH:\nChris Martin | Coldplay").length, 1);
  assert.notEqual(readResearch("WHICH:\nChris Martin | Coldplay").kind, "which");
});

check("a fictional character, and their age", () => {
  const kid = readResearch("FICTIONAL: Boy wizard from Harry Potter\nFULL NAME: Harry Potter\nAGE: minor\nBrave, sarcastic.");
  assert.equal(kid.fictional, true);
  assert.equal(kid.minor, true);
  assert.equal(kid.knownFor, "Boy wizard from Harry Potter");
  assert.equal(kid.research, "Brave, sarcastic.");

  const adult = readResearch("FICTIONAL: Genius inventor, Marvel\nFULL NAME: Tony Stark\nAGE: adult\nQuips.");
  assert.equal(adult.minor, false);
});

check("a character with no stated age counts as a minor", () => {
  assert.equal(readResearch("FICTIONAL: Someone from a game\nFULL NAME: Link\nSilent.").minor, true);
});

const hp = { them: "Harry Potter", you: "Sam", relationship: "a friend", arch: "friend", texture: "close", mode: "fictional", brief: "You are brave.", interests: "Boy wizard from Harry Potter" };

check("fictional mode: in their world, knows they are a character, no reciting the book", () => {
  const sys = personaSystem(hp, [], false, plain);
  assert.match(sys, /the character, as you are in your story \(Boy wizard from Harry Potter\)/);
  assert.match(sys, /You know you are a character/);
  assert.match(sys, /Do not recite passages/);
  assert.doesNotMatch(sys, /You are a portrayal, and an honest one/);
});

check("a child in their story is never romantic, and unknown counts as a child", () => {
  assert.match(personaSystem(hp, [], false, plain), /You are under eighteen\. Nothing between you and Sam is ever romantic/);
  assert.match(personaSystem({ ...hp, minor: true }, [], false, plain), /You are under eighteen/);
  const adult = personaSystem({ ...hp, them: "Tony Stark", minor: false }, [], false, plain);
  assert.doesNotMatch(adult, /You are under eighteen/);
  assert.match(adult, /Never sexual content involving anyone under eighteen/);
});

check("the fictional build has its own prompt, with the not-enough gate", () => {
  const sys = briefSystem("fictional");
  assert.match(sys, /fictional character/);
  assert.match(sys, /NOT_ENOUGH/);
  assert.doesNotMatch(sys, /Nothing about their private life/);
});

check("reconstructed lines are labelled as such, not as their messages", () => {
  const sys = personaSystem({ ...hp, samples: "Blimey.", verbatim: false }, [], false, plain);
  assert.match(sys, /These are NOT things they said/);
  assert.doesNotMatch(sys, /THEIR ACTUAL MESSAGES/);
});

let pass = 0, fail = 0;
for (const [n, f] of results) {
  try { await f(); console.log(`  PASS  ${n}`); pass++; }
  catch (e) { console.log(`  FAIL  ${n}\n        ${e.message}`); fail++; }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
