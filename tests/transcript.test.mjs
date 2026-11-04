/* Reading an interview instead of a chat export.
 *
 * For a public figure there is no export, and the whole build rests on what
 * replaces it. Model-written sample lines are an impression, and an impression
 * drifts to the centroid — charming, self-deprecating, indistinguishable from
 * the next famous person. A real interview cannot drift, because it is real.
 *
 * styleOf and sampleWindows take ChatMessage[] and do not care where it came
 * from, so a transcript parsed into that shape is measured exactly like an
 * export. That is the whole reason this parser exists: it keeps `metrics` a
 * measurement rather than letting it become a guess.
 */
import assert from "node:assert";
import { parseTranscript, styleOf, sampleWindows } from "../src/lib/chat-import.ts";

const results = [];
const check = (n, f) => results.push([n, f]);

check("a labelled Q and A splits into speakers", () => {
  const { messages, participants } = parseTranscript(
    [
      "Interviewer: What did failure teach you?",
      "SRK: That nobody is coming to rescue you. You get up, or you don't.",
      "Interviewer: And success?",
      "SRK: Success is a worse teacher. It tells you you were right all along.",
    ].join("\n"),
    "Shah Rukh Khan"
  );
  assert.equal(messages.length, 4);
  assert.deepEqual(participants.map((p) => p.name).sort(), ["Interviewer", "SRK"]);
});

check("the one who actually talks is ranked first, not the one who asks most", () => {
  /* An interviewer asks many short questions; the subject says far more. Ranked
     by message count the interviewer wins almost every transcript, and the
     build would measure the wrong person — the same unrecoverable mistake the
     chat-export participant picker was rewritten to avoid. */
  const text = [];
  for (let i = 0; i < 12; i++) text.push(`Interviewer: And then what?`);
  text.push("SRK: " + "I think the thing about all of this is that you keep going. ".repeat(12));
  const { participants } = parseTranscript(text.join("\n"), "Shah Rukh Khan");
  assert.equal(participants[0].name, "SRK", "ranked by how much was said, not how often");
});

check("a speaker on their own line carries the lines beneath it", () => {
  const { messages } = parseTranscript(
    ["SHAH RUKH KHAN", "I was never the obvious choice.", "That turned out to be the point.", "", "INTERVIEWER", "Say more."].join("\n"),
    "Shah Rukh Khan"
  );
  assert.equal(messages.filter((m) => m.who === "SHAH RUKH KHAN").length, 2);
  assert.equal(messages.filter((m) => m.who === "INTERVIEWER").length, 1);
});

check("auto-captions with no labels at all are one person talking", () => {
  /* Pasting YouTube captions of someone being interviewed is the likeliest
     thing a fan will actually do, and there are no speaker labels in them. */
  const { messages, participants } = parseTranscript(
    ["so the thing about failure is", "you learn nothing from success", "nothing at all"].join("\n"),
    "Shah Rukh Khan"
  );
  assert.equal(participants.length, 1);
  assert.equal(participants[0].name, "Shah Rukh Khan");
  assert.ok(messages[0].text.includes("failure"));
});

check("subtitle timecodes and cue numbers are not treated as speech", () => {
  const { messages } = parseTranscript(
    ["1", "00:00:04,120 --> 00:00:07,400", "I was never the obvious choice.", "2", "00:00:07,400 --> 00:00:09,000", "That turned out to be the point."].join("\n"),
    "Shah Rukh Khan"
  );
  const all = messages.map((m) => m.text).join(" ");
  assert.ok(!/00:00/.test(all), "timecodes must not end up measured as how they talk");
  assert.ok(all.includes("obvious choice") && all.includes("the point"));
});

check("a real line of speech is not mistaken for a speaker label", () => {
  /* BARE_LABEL_RE is deliberately strict. "Absolutely." on its own line is a
     sentence, not a name, and swallowing it would both lose the line and
     invent a participant. */
  const { participants } = parseTranscript(
    ["SRK: Did I think it would work?", "SRK: Absolutely not.", "Absolutely."].join("\n"),
    "Shah Rukh Khan"
  );
  assert.deepEqual(participants.map((p) => p.name), ["SRK"], `invented: ${participants.map((p) => p.name)}`);
});

check("media placeholders are dropped here too", () => {
  const { messages } = parseTranscript(
    ["SRK: real line", "SRK: <Media omitted>"].join("\n"),
    "Shah Rukh Khan"
  );
  assert.equal(messages.length, 1);
});

check("a transcript measures like an export, minus what it cannot know", () => {
  /* The point of the whole parser. The same styleOf that reads a WhatsApp
     export reads this, so `metrics` stays measured. */
  const lines = [];
  for (let i = 0; i < 40; i++) {
    lines.push("Interviewer: And then?");
    lines.push(`SRK: i think the honest answer is that you never quite know, you just keep going and hope it lands ${i}`);
  }
  const { messages } = parseTranscript(lines.join("\n"), "Shah Rukh Khan");
  const style = styleOf(messages, "SRK");
  assert.ok(style.n >= 40, `measured ${style.n}`);
  assert.match(style.text, /Messages measured: \d+/);
  assert.match(style.text, /Typical message length/);
});

check("excerpts can be sampled from a transcript for the samples block", () => {
  const lines = [];
  for (let i = 0; i < 60; i++) lines.push(`SRK: line number ${i} about the work`);
  const { messages } = parseTranscript(lines.join("\n"), "Shah Rukh Khan");
  const out = sampleWindows(messages, "SRK");
  assert.ok(out.length > 0, "there must be verbatim material to copy");
  assert.ok(out.includes("SRK:"));
});

check("an empty paste yields nothing rather than throwing", () => {
  const { messages, participants } = parseTranscript("   \n\n  ", "Shah Rukh Khan");
  assert.equal(messages.length, 0);
  assert.equal(participants.length, 0);
});

let pass = 0, fail = 0;
for (const [n, f] of results) {
  try { await f(); console.log(`  PASS  ${n}`); pass++; }
  catch (e) { console.log(`  FAIL  ${n}\n        ${e.message}`); fail++; }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
