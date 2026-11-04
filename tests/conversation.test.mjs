/* Not going round the same subject.
 *
 * The complaint was that chatting felt boring and repetitive. Measured against
 * the real route over a twelve-turn conversation, a character whose material
 * said "always asks if he has eaten" asked about food in a third of its
 * messages, rewording it every time — zero repeated lines, one question asked
 * six ways. Telling a model not to repeat itself does not fix that, because it
 * cannot see its own pattern: every turn reads fine on its own and the loop is
 * only visible across ten of them.
 *
 * So the loop is computed and handed over as a fact. The first version of this
 * required a word in three separate turns and NEVER FIRED ONCE in a real
 * conversation — Hindi inflects the same subject differently each time (khana,
 * khaya, khao), so nothing reached three. It was dead code that looked like a
 * feature, and the improvement I measured at the time came entirely from a
 * prompt edit sitting next to it. These tests exist because that is exactly the
 * kind of thing that ships silently doing nothing.
 */
import assert from "node:assert";
import { coveredBlock, coveredGround } from "../src/lib/presence/persona.ts";

const results = [];
const check = (n, f) => results.push([n, f]);

/** A conversation where the character says these things, one per turn. */
const said = (...lines) =>
  lines.flatMap((content) => [
    { role: "user", content: "hmm" },
    { role: "assistant", content },
  ]);

check("it fires on a subject raised in two separate messages", () => {
  const covered = coveredGround(
    said("yo betu", "khana khaya tumne?", "khana khaya ki nahi pehle batao", "so gaye the kya")
  );
  assert.ok(covered.includes("khana"), `nothing caught: ${JSON.stringify(covered)}`);
});

check("the real transcript that produced the complaint is caught", () => {
  /* Taken from an actual measured run, not invented. */
  const covered = coveredGround(
    said(
      "yo betu",
      "khana khaya tumne?",
      "itni der tak so rahe the kya, fir bolte ho pet bahar aa raha hai",
      "khana khaya ki nahi thik se pehle woh batao",
      "aaj phir gym skip kiya na tumne sach batao",
      "kuch accha khao pehle, fir thoda rest karlo na please"
    )
  );
  assert.ok(covered.length > 0, "the loop that was reported must be detectable");
  assert.ok(covered.includes("khana") || covered.includes("khaya"), JSON.stringify(covered));
});

check("it stays quiet for the first few turns", () => {
  /* Following up on something you just said is conversation, not a loop.
     Suppressing it early would cause the problem it exists to prevent. */
  assert.deepEqual(coveredGround(said("did you email him", "did you email him though")), []);
});

check("it only counts the character's own lines", () => {
  /* What the USER keeps raising is their business — something they have come
     back to three times is usually what they actually want to talk about, and
     telling the character to drop it would be exactly wrong. */
  const history = [
    { role: "user", content: "the wedding is stressing me out" },
    { role: "assistant", content: "ok" },
    { role: "user", content: "the wedding again, sorry" },
    { role: "assistant", content: "mm" },
    { role: "user", content: "wedding wedding wedding" },
    { role: "assistant", content: "right" },
  ];
  assert.deepEqual(coveredGround(history), [], "the user's subject is not the character's loop");
});

check("ordinary connective words are not subjects", () => {
  const covered = coveredGround(
    said(
      "yeah but that is just how it is",
      "yeah but really that is just how it is",
      "yeah that is just it",
      "but really though"
    )
  );
  assert.deepEqual(covered, [], `filler treated as a subject: ${JSON.stringify(covered)}`);
});

check("a varied conversation is left alone", () => {
  assert.deepEqual(
    coveredGround(
      said(
        "the landlord finally replied",
        "anyway i burnt the rice again",
        "did you watch that film",
        "my knee hurts from yesterday"
      )
    ),
    []
  );
});

check("nothing covered produces no block at all", () => {
  assert.equal(coveredBlock([], "Sam"), "", "an empty section is worse than none");
});

check("the block names the subjects and says what to do instead", () => {
  const block = coveredBlock(["khana", "gym"], "Piyush");
  // Hard-wrapped for the prompt, so match on the words rather than the layout.
  const flat = block.replace(/\s+/g, " ");
  assert.match(flat, /khana, gym/);
  assert.match(flat, /unless Piyush brings one back/);
  assert.ok(block.length < 600, "a nudge, not an essay competing with the persona");
});

check("it is bounded, so a long conversation cannot flood the prompt", () => {
  const many = Array.from({ length: 40 }, (_, i) => `subject${i} subject${i} recurring${i}`);
  const covered = coveredGround(said(...many, ...many));
  assert.ok(covered.length <= 6, `${covered.length} subjects would crowd out the character`);
});

let pass = 0, fail = 0;
for (const [n, f] of results) {
  try { await f(); console.log(`  PASS  ${n}`); pass++; }
  catch (e) { console.log(`  FAIL  ${n}\n        ${e.message}`); fail++; }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
