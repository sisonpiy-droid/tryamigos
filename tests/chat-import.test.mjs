/* The chat parser is the backbone: if it misreads an export, every persona
   built from one is wrong in a way that is hard to notice. */
import assert from "node:assert";
import { parseExport, styleOf, sampleWindows } from "../src/lib/chat-import.ts";

const results = [];
const check = (n, f) => results.push([n, f]);

// A realistic export: bracketed and unbracketed lines, 12- and 24-hour,
// wrapped messages, media placeholders, system lines, emoji, bursts.
const SAMPLE = [
  "[12/03/2023, 9:14:02 AM] Dad: morning love",
  "[12/03/2023, 9:14:20 AM] Dad: you up yet",
  "[12/03/2023, 9:14:31 AM] Dad: 7 down is beating me again",
  "[12/03/2023, 9:20:11 AM] Nell: Morning! Barely.",
  "[12/03/2023, 9:21:00 AM] Dad: <Media omitted>",
  "[12/03/2023, 9:22:14 AM] Dad: put the kettle on and have a proper think",
  "[12/03/2023, 9:22:40 AM] Dad: thats what i always say",
  "13/03/2023, 18:02 - Nell: Did you get the crossword done?",
  "13/03/2023, 18:09 - Dad: nearly",
  "13/03/2023, 18:09 - Dad: that compiler doesnt know what hes doing",
  "13/03/2023, 18:10 - Dad: anyway hows work",
  "Messages and calls are end-to-end encrypted.",
  "14/03/2023, 08:30 - Nell: Long week. I'll ring Sunday.",
  "14/03/2023, 08:44 - Dad: sunday morning not evening",
  "14/03/2023, 08:44 - Dad: you know the rules",
  "14/03/2023, 08:45 - Dad: this line wraps",
  "onto a second line entirely",
  /* Enough of Dad to measure. styleOf refuses to report percentages below a
     usable sample, because a handful of messages produces things like "starts
     lowercase: 100% of the time" and the prompt presents those as counts to be
     matched exactly. The old fixture had eleven of him, which tested the
     statistics on a sample the code should decline to measure. */
  ...Array.from({ length: 22 }, (_, i) =>
    `15/03/2023, ${String(9 + (i % 12)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")} - Dad: ${
      [
        "sunday then",
        "aye",
        "your mother says hello",
        "i said what i said",
        "hows that car of yours",
        "dont be daft",
      ][i % 6]
    }`
  ),
  ...Array.from({ length: 14 }, (_, i) =>
    `15/03/2023, ${String(9 + (i % 12)).padStart(2, "0")}:${String(30 + (i % 29)).padStart(2, "0")} - Nell: ${
      [
        "Sounds good.",
        "I will call you.",
        "Tell her hello from me.",
        "The car is fine, honestly.",
      ][i % 4]
    }`
  ),
].join("\n");

check("parses both bracketed and dashed line formats", () => {
  const { messages, participants } = parseExport(SAMPLE);
  assert.ok(messages.length >= 14, `got ${messages.length}`);
  assert.deepEqual(participants.map(p => p.name).sort(), ["Dad", "Nell"]);
});

check("drops media placeholders and system lines", () => {
  const { messages } = parseExport(SAMPLE);
  assert.ok(!messages.some(m => /Media omitted/i.test(m.text)));
  assert.ok(!messages.some(m => /end-to-end encrypted/i.test(m.text)));
});

check("a wrapped message joins the line before it", () => {
  const { messages } = parseExport(SAMPLE);
  const wrapped = messages.find(m => m.text.startsWith("this line wraps"));
  assert.ok(wrapped, "wrapped message missing");
  assert.match(wrapped.text, /onto a second line entirely/);
  assert.equal(wrapped.who, "Dad");
});

check("counts messages per participant correctly", () => {
  const { participants } = parseExport(SAMPLE);
  const dad = participants.find(p => p.name === "Dad");
  const nell = participants.find(p => p.name === "Nell");
  assert.ok(dad.count > nell.count, "Dad sends more");
});

check("measures the habits that make a voice recognisable", () => {
  const { messages } = parseExport(SAMPLE);
  const style = styleOf(messages, "Dad");
  // He writes lowercase, rarely punctuates, and sends bursts. All three should
  // be visible in the report a model will be told to imitate.
  assert.match(style.text, /Starts a message lowercase: (8\d|9\d|100)%/);
  assert.match(style.text, /back-to-back messages/);
  assert.ok(style.n >= 9, `measured ${style.n}`);
});

check("distinctive words are relative to the other person", () => {
  // Built so "crossword" is Nell's word and "sunday" is Dad's.
  const extra = Array.from({ length: 6 }, (_, i) =>
    `15/03/2023, 10:0${i} - Dad: sunday sunday sunday`
  ).join("\n");
  const { messages } = parseExport(SAMPLE + "\n" + extra);
  const style = styleOf(messages, "Dad");
  assert.match(style.text, /Words they use far more than the other person:.*sunday/i);
});

check("samples span the history rather than the tail", () => {
  const many = Array.from({ length: 400 }, (_, i) =>
    `16/03/2023, 10:${String(i % 60).padStart(2, "0")} - Dad: message number ${i}`
  ).join("\n");
  const { messages } = parseExport(many);
  const s = sampleWindows(messages, "Dad", 4000);
  assert.ok(s.length > 0, "a dense chat must still yield a sample");
  assert.ok(s.includes("message number 0") || s.includes("message number 1"), "should include the start");
  assert.ok(s.length <= 4100, `budget respected, got ${s.length}`);
});

check("an unrelated file yields no participants rather than throwing", () => {
  const { participants } = parseExport("just some notes\nnothing like a chat here");
  assert.equal(participants.length, 0);
});

/* Exports that are not in English, and lines this parser has not seen.
 *
 * The placeholder list was English only, so a phone set to Hindi or Spanish
 * counted every photo and voice note as a real message. Those land in the
 * measured statistics -- median length, "starts lowercase", the distinctive
 * words -- which the prompt hands over as "counts, not impressions. Match
 * them." A chat with a lot of photos in it was being measured mostly on the
 * word for "media omitted".
 */

check("attachment placeholders are dropped in any language", () => {
  const lines = [
    "[01/03/2026, 09:00:00] Aditi: yo",
    "[01/03/2026, 09:01:00] Aditi: <Media omitted>",
    "[01/03/2026, 09:02:00] Aditi: <मीडिया छोड़ा गया>",
    "[01/03/2026, 09:03:00] Aditi: <Multimedia omitido>",
    "[01/03/2026, 09:04:00] Aditi: <Mídia oculta>",
    "[01/03/2026, 09:05:00] Aditi: khana khaya",
  ].join("\n");
  const { messages } = parseExport(lines);
  assert.deepEqual(messages.map((m) => m.text), ["yo", "khana khaya"],
    "a placeholder in any locale is an attachment, not something said");
});

check("angle brackets are not treated as a placeholder when they are speech", () => {
  const { messages } = parseExport([
    "[01/03/2026, 09:00:00] Aditi: <3",
    "[01/03/2026, 09:01:00] Aditi: <3 that was lovely",
  ].join("\n"));
  assert.equal(messages.length, 2, "an unclosed bracket is not a placeholder");
});

check("a message line that cannot be parsed is skipped, not glued on", () => {
  /* Appending it corrupted the message above AND attributed its words to the
     wrong person -- the worst of both. */
  const { messages, unreadable } = parseExport([
    "[01/03/2026, 09:00:00] Aditi: first",
    "[2026.03.01 at 09.01] Aditi - second",
    "[01/03/2026, 09:02:00] Aditi: third",
  ].join("\n"));
  assert.equal(unreadable, 1, "the unparsed line should be counted");
  assert.equal(messages.find((m) => m.text.startsWith("first"))?.text, "first",
    "the message above it must be untouched");
  assert.ok(!messages.some((m) => m.text.includes("second")),
    "an unreadable line must not end up inside someone else's message");
});

check("a wrapped line is still joined to the message above it", () => {
  const { messages, unreadable } = parseExport([
    "[01/03/2026, 09:00:00] Aditi: this carries on",
    "onto the next line",
  ].join("\n"));
  assert.equal(unreadable, 0);
  assert.ok(messages[0].text.includes("onto the next line"));
});

check("a wrapped line ending in 'left' survives", () => {
  /* The system-line test was /left$/ against every line, which deleted any
     wrapped line ending in that word. No length or word-count bound separates
     "Piyush Kapoor left" from "there was nothing left" -- only the timestamp
     does, so the test is applied to timestamped lines alone. */
  for (const tail of ["take the second exit and then go left", "there was nothing left"]) {
    const { messages } = parseExport([
      "[01/03/2026, 09:00:00] Aditi: ok so",
      tail,
    ].join("\n"));
    assert.ok(messages[0].text.includes(tail), `lost: ${tail}`);
  }
});

check("someone leaving the group is still dropped", () => {
  const { messages, unreadable } = parseExport([
    "[01/03/2026, 09:00:00] Aditi: yo",
    "[01/03/2026, 09:01:00] Piyush Kapoor left",
  ].join("\n"));
  assert.equal(messages.length, 1);
  assert.equal(unreadable, 0, "a leave notice is understood, not unreadable");
});

check("too few messages produces no statistics rather than confident ones", () => {
  const { messages } = parseExport([
    "[01/03/2026, 09:00:00] Aditi: yo",
    "[01/03/2026, 09:01:00] Aditi: bye",
    "[01/03/2026, 09:02:00] Piyush: hello there",
  ].join("\n"));
  const style = styleOf(messages, "Aditi");
  assert.ok(!/100%/.test(style.text), "two messages cannot support a percentage");
  assert.match(style.text, /too few/i);
  assert.equal(style.n, 2, "the count itself is still reported honestly");
});

let pass = 0, fail = 0;
for (const [n, f] of results) {
  try { await f(); console.log(`  PASS  ${n}`); pass++; }
  catch (e) { console.log(`  FAIL  ${n}\n        ${e.message}`); fail++; }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
