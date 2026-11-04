/* The look of a thread and of the chat list: where the day dividers go, which
 * bubbles are one burst, the time under the last of each, and how the list is
 * ordered, searched, pinned and archived. */
import assert from "node:assert";

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const layout = await import("../src/lib/solo/layout.ts");
const list = await import("../src/lib/solo/chatlist.ts");
const store = await import("../src/lib/solo/store.ts");
const { mergeStates } = await import("../src/lib/solo/sync.ts");

const results = [];
const check = (n, f) => results.push([n, f]);

const TZ = "Asia/Kolkata";
/* Thursday 8 October 2026, 15:00 in India */
const NOW = Date.parse("2026-10-08T09:30:00Z");
const m = (id, from, iso, extra = {}) => ({ id, from, content: id, at: iso, ...extra });

/* ----------------------------------------------------------------- layout */

check("a day divider reads Today, Yesterday, a weekday within the week, then a date", () => {
  const label = (iso) => layout.dayLabel(iso, NOW, TZ, "en-GB");
  assert.equal(label("2026-10-08T05:00:00Z"), "Today");
  assert.equal(label("2026-10-07T20:00:00Z"), "Today", "01:30 on the 8th in India, still the 7th in UTC");
  assert.equal(label("2026-10-07T05:00:00Z"), "Yesterday");
  assert.equal(label("2026-10-05T05:00:00Z"), "Monday");
  assert.equal(label("2026-09-12T05:00:00Z"), "12 September");
  assert.equal(label("2025-06-03T05:00:00Z"), "3 June 2025", "the year once it is not this one");
  assert.match(layout.clockTime("2026-10-08T09:30:00Z", TZ, "en-GB"), /^15:00$/);
  assert.match(layout.clockTime("2026-10-08T09:30:00Z", TZ, "en-US"), /^3:00\s?PM$/i);
});

check("bubbles from one sender a few minutes apart are one burst; the last of it carries the time", () => {
  const log = [
    m("a", "user", "2026-10-08T05:00:00Z"),
    m("b", "user", "2026-10-08T05:01:00Z"),
    m("c", "muse", "2026-10-08T05:01:30Z", { speakerId: "maya" }),
    m("d", "muse", "2026-10-08T05:02:00Z", { speakerId: "maya" }),
    m("e", "muse", "2026-10-08T05:02:30Z", { speakerId: "rhea" }),
    m("f", "muse", "2026-10-08T05:40:00Z", { speakerId: "rhea" }),
  ];
  const r = log.map((_, i) => layout.runOf(log, i, TZ));
  assert.deepEqual(r.map((x) => x.first), [true, false, true, false, true, true]);
  assert.deepEqual(r.map((x) => x.last), [false, true, false, true, true, true]);
  assert.deepEqual(r.map((x) => x.newDay), [true, false, false, false, false, false], "only the first of the thread starts a day");
});

check("a new day starts a new burst, even from the same sender a minute later", () => {
  /* 23:59 and 00:01 in India */
  const log = [m("a", "muse", "2026-10-07T18:29:00Z", { speakerId: "x" }), m("b", "muse", "2026-10-07T18:31:00Z", { speakerId: "x" })];
  assert.deepEqual([layout.runOf(log, 0, TZ).last, layout.runOf(log, 1, TZ).newDay, layout.runOf(log, 1, TZ).first], [true, true, true]);
});

/* -------------------------------------------------------------- chat list */

const row = (id, name, preview, minsAgo, unread = 0) => ({ id, name, preview, at: NOW - minsAgo * 60_000, unread });
const rows = [
  row("maya", "Maya", "okay but the chai", 5, 2),
  row("dev", "Dev", "ek line me jawab de", 60),
  row("rhea", "Rhea", "biryani ready", 600),
  row("tara", "Tara", "dry as a bone", 3000),
];

check("pinned chats come first, then the rest by most recent", () => {
  assert.deepEqual(list.arrange(rows, {}).main.map((r) => r.id), ["maya", "dev", "rhea", "tara"]);
  assert.deepEqual(list.arrange(rows, { pinned: ["tara", "dev"] }).main.map((r) => r.id), ["dev", "tara", "maya", "rhea"]);
});

check("search looks at names and the last line, ignoring case", () => {
  assert.deepEqual(list.arrange(rows, { query: "MAYA" }).main.map((r) => r.id), ["maya"]);
  assert.deepEqual(list.arrange(rows, { query: "biryani" }).main.map((r) => r.id), ["rhea"]);
  assert.deepEqual(list.arrange(rows, { query: "  " }).main.length, 4, "blank is no filter");
  assert.deepEqual(list.arrange(rows, { query: "zzz" }), { main: [], archived: [] });
});

check("archived chats are put away, and come back when something new arrives", () => {
  const a = list.arrange(rows, { archived: ["rhea", "maya"] });
  assert.deepEqual(a.main.map((r) => r.id), ["maya", "dev", "tara"], "maya has unread, so she stays in the list");
  assert.deepEqual(a.archived.map((r) => r.id), ["rhea"]);
  assert.deepEqual(list.arrange(rows, { archived: ["rhea"], query: "biryani" }).archived.map((r) => r.id), ["rhea"], "search reaches the archive");
});

check("pinning and archiving toggle; archiving unpins", () => {
  const s0 = { userName: "P", muses: [], conversations: {}, memories: [] };
  const pinned = list.togglePin(s0, "maya");
  assert.deepEqual(pinned.pinned, ["maya"]);
  assert.deepEqual(list.togglePin(pinned, "maya").pinned, []);
  const away = list.toggleArchive(pinned, "maya");
  assert.deepEqual(away.archived, ["maya"]);
  assert.deepEqual(away.pinned, [], "cannot be pinned and put away");
  assert.deepEqual(list.toggleArchive(away, "maya").archived, []);
});

check("two devices pin and archive different chats and both are kept; an unpin on one holds", () => {
  assert.deepEqual(list.mergeSet(["a"], ["a", "b"], ["a", "c"]).sort(), ["a", "b", "c"]);
  assert.deepEqual(list.mergeSet(["a", "b"], ["a", "b"], ["b"]), ["b"], "removed on one side stays removed");
  assert.deepEqual(list.mergeSet([], undefined, undefined), []);
  const base = { userName: "P", muses: [], conversations: {}, memories: [], pinned: ["a"], archived: [] };
  const phone = { ...base, pinned: ["a", "b"] };
  const laptop = { ...base, pinned: [], archived: ["c"] };
  const merged = mergeStates(base, phone, laptop);
  assert.deepEqual(merged.pinned, ["b"]);
  assert.deepEqual(merged.archived, ["c"]);
  const back = store.parseState(JSON.stringify(merged));
  assert.deepEqual([back.pinned, back.archived], [["b"], ["c"]], "and it is saved");
  const r = store.parseBackup(JSON.stringify({ userName: "P", muses: [], conversations: {}, memories: [], pinned: ["x", 3], archived: ["y"] }));
  assert.deepEqual([r.state.pinned, r.state.archived], [["x"], ["y"]], "a restore keeps them, and only real ids");
});

let pass = 0, fail = 0;
for (const [n, f] of results) {
  try { await f(); console.log(`  PASS  ${n}`); pass++; }
  catch (e) { console.log(`  FAIL  ${n}\n        ${e.message}`); fail++; }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
