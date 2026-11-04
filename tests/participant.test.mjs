/* Which speaker in an export is the one being built.
 *
 * The old rule was `participants.find(p => p.name !== draft.you)` over a list
 * sorted by message count. Export labels are profile push-names, address-book
 * entries or bare phone numbers, so they are almost never character-equal to
 * the first name someone types into a box — the test failed, the fallback took
 * participants[0], and in a two-person chat that is whoever sent more messages.
 *
 * Half the time that is the user. The result is a character called Aditi whose
 * measured statistics and verbatim samples are the user's own writing, told on
 * every future turn to "copy this texture exactly". It is invisible afterwards,
 * because the generated profile describes a real person and reads fine. And it
 * is permanent: `metrics` is in every system prompt and no screen can edit it,
 * so the only repair is deleting the character and losing what they remember.
 *
 * Verified against a generated 400-message export before the fix: participants
 * came back "Piyush Kapoor=266, Aditi=134" and the old rule returned Piyush.
 */
import assert from "node:assert";
import { guessParticipant } from "../src/components/ImportPersona.tsx";

const results = [];
const check = (n, f) => results.push([n, f]);

const p = (name, count) => ({ name, count });

check("the reported case: a push-name, and the user sent more", () => {
  const who = guessParticipant(
    [p("Piyush Kapoor", 266), p("Aditi", 134)],
    "Aditi",
    "Piyush"
  );
  assert.equal(who, "Aditi", "the chattiest speaker is not the answer");
});

check("a label that merely contains the name still matches", () => {
  assert.equal(
    guessParticipant([p("Sam Kapoor", 5012), p("Aditi ❤", 4830)], "Aditi", "Sam"),
    "Aditi ❤"
  );
});

check("matching wins over ruling out", () => {
  /* Both labels differ from the typed names, so elimination alone would have
     nothing to go on -- but one of them is clearly who was asked for. */
  assert.equal(
    guessParticipant([p("+91 98200 11111", 900), p("Aditi Sharma", 400)], "Aditi", "Piyush"),
    "Aditi Sharma"
  );
});

check("with no name match, the one that is not you is picked", () => {
  assert.equal(
    guessParticipant([p("Piyush Kapoor", 900), p("+91 98200 11111", 400)], "Aditi", "Piyush"),
    "+91 98200 11111"
  );
});

check("when nothing can be told apart it declines to guess", () => {
  /* The wizard turns this into a required choice. A wrong guess here is baked
     into every future prompt and cannot be edited, so asking beats assuming. */
  assert.equal(
    guessParticipant([p("+91 98200 11111", 900), p("+91 98200 22222", 400)], "Aditi", "Piyush"),
    null
  );
});

check("a group export with several strangers declines rather than picking the loudest", () => {
  assert.equal(
    guessParticipant([p("Rohit", 900), p("Neha", 800), p("Karan", 700)], "Aditi", "Piyush"),
    null
  );
});

check("a group export still finds the named person", () => {
  assert.equal(
    guessParticipant([p("Rohit", 900), p("Aditi", 80), p("Karan", 700)], "Aditi", "Piyush"),
    "Aditi",
    "being the quietest in a group must not disqualify someone"
  );
});

check("case and punctuation do not defeat it", () => {
  assert.equal(
    guessParticipant([p("PIYUSH K.", 500), p("aditi.", 200)], "Aditi", "Piyush"),
    "aditi."
  );
});

check("an empty participant list is not a crash", () => {
  assert.equal(guessParticipant([], "Aditi", "Piyush"), null);
});

check("the user's own name never wins on a match", () => {
  /* If the typed "them" and "you" are confusable, the match arm runs first and
     could pick the user. Ordering matters: them is searched for, you is only
     ever used to rule out. */
  const who = guessParticipant([p("Piyush", 900), p("Aditi", 100)], "Aditi", "Piyush");
  assert.equal(who, "Aditi");
});

let pass = 0, fail = 0;
for (const [n, f] of results) {
  try { await f(); console.log(`  PASS  ${n}`); pass++; }
  catch (e) { console.log(`  FAIL  ${n}\n        ${e.message}`); fail++; }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
