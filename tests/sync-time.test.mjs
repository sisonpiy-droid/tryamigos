/* Persistence across copies of the app, real time, and memory across threads.
 *
 * The first reproduces the reported loss directly: two copies of the app on
 * one browser's storage, one of them stale, and the stale one saving last.
 */
import assert from "node:assert";

const disk = new Map();
const events = [];
globalThis.localStorage = {
  getItem: (k) => (disk.has(k) ? disk.get(k) : null),
  setItem: (k, v) => { disk.set(k, String(v)); events.push(k); },
  removeItem: (k) => disk.delete(k),
};

const { KEY, addMemories, memoriesForTurn, newMessage, plansForTurn } = await import("../src/lib/solo/store.ts");
const { Persister, combineRaw, mergeList, mergeStates } = await import("../src/lib/solo/sync.ts");
const { localBackend } = await import("../src/lib/solo/backend.ts");
const { nowBlock, previousMoment, resolveWhen, stampPauses, timeBlock } = await import("../src/lib/presence/time.ts");
const { circleBlock, personaSystem } = await import("../src/lib/presence/persona.ts");
const { parseMemories } = await import("../src/lib/ai/gemini.ts");

const results = [];
const check = (n, f) => results.push([n, f]);
const blank = () => ({ userName: "Sam", muses: [], conversations: {}, memories: [], vibes: {}, circles: [] });
const msg = (id, from = "user", at = "2026-10-01T17:30:00.000Z") => ({ id, from, content: id, at });
const RHEA = "made-rhea";

/* ------------------------------------------------------------ persistence */

const local = () => Promise.resolve(localBackend);
const tab = async () => { const p = new Persister(); const s = await p.open(local); return [p, s]; };

check("a stale second copy saving last no longer erases the newer conversation", async () => {
  disk.clear();
  const start = blank();
  start.conversations[RHEA] = [msg("m0")];
  localStorage.setItem(KEY, JSON.stringify(start));

  let [phone, a] = await tab();      // the copy in use
  let [stale, b] = await tab();      // a tab left open in the background

  for (let i = 1; i <= 30; i++) {
    a = { ...a, conversations: { ...a.conversations, [RHEA]: [...a.conversations[RHEA], msg(`m${i}`)] } };
    a = (await phone.save(a)).state;
  }
  /* The stale copy changes something unrelated and saves its whole state. */
  b = { ...b, vibes: { [RHEA]: { mood: "teasing", topic: "any", register: "texts" } } };
  await stale.save(b);

  const [, reopened] = await tab();
  assert.equal(reopened.conversations[RHEA].length, 31, "all 31 messages survive");
  assert.equal(reopened.conversations[RHEA].at(-1).id, "m30");
  assert.equal(reopened.vibes[RHEA].mood, "teasing", "and the stale copy's own change is kept");
});

check("a tab with nothing unsaved adopts what another wrote, without writing back", async () => {
  disk.clear();
  localStorage.setItem(KEY, JSON.stringify(blank()));
  let [one, s1] = await tab(); const [two, s2] = await tab();
  s1 = { ...s1, conversations: { [RHEA]: [msg("x")] } };
  await one.save(s1);
  const writes = events.length;
  const next = await two.refresh(s2);
  assert.equal(next.conversations[RHEA].length, 1);
  assert.equal(next, two.persisted, "marked as already on disk, so the save effect skips it");
  assert.equal(events.length, writes, "no write: two tabs never ping-pong");
});

check("unsaved changes are merged with another tab's on refresh", async () => {
  disk.clear();
  localStorage.setItem(KEY, JSON.stringify(blank()));
  let [one, s1] = await tab(); let [two, s2] = await tab();
  s1 = { ...s1, conversations: { [RHEA]: [msg("from-one")] } };
  await one.save(s1);
  s2 = { ...s2, userName: "Sammy" };
  const merged = await two.refresh(s2);
  assert.equal(merged.conversations[RHEA][0].id, "from-one");
  assert.equal(merged.userName, "Sammy");
});

check("the revision is stored first, so it can be read without parsing", async () => {
  disk.clear();
  const [p] = await tab();
  await p.save(blank());
  assert.match(disk.get(KEY), /^{"rev":1,/);
});

/* An in-memory backend with IndexedDB's semantics: a write is conditional
   on the revision, atomically. */
function memoryBackend() {
  const store = { raw: null, rev: 0 };
  return {
    name: "idb", store,
    async read() { return { raw: store.raw, rev: store.rev }; },
    async revision() { return store.raw === null ? null : store.rev; },
    async write(raw, rev, expected) { if (store.rev !== expected) return "conflict"; store.raw = raw; store.rev = rev; return "ok"; },
  };
}

check("on the new storage, two tabs racing both keep their changes", async () => {
  const be = memoryBackend();
  const one = new Persister(); const two = new Persister();
  let s1 = await one.open(() => Promise.resolve(be));
  let s2 = await two.open(() => Promise.resolve(be));
  s1 = { ...s1, conversations: { [RHEA]: [msg("one")] } };
  s2 = { ...s2, conversations: { [RHEA]: [msg("two")] } };
  await one.save(s1);
  const r = await two.save(s2);
  assert.ok(r.result.ok, "the second write merged and went through");
  const [, back] = [null, (await new Persister().open(() => Promise.resolve(be)))];
  assert.deepEqual(back.conversations[RHEA].map((m) => m.id).sort(), ["one", "two"]);
});

check("saves are queued: a burst of changes lands in order, the newest last", async () => {
  const be = memoryBackend();
  const p = new Persister();
  let s = await p.open(() => Promise.resolve(be));
  const writes = [];
  for (let i = 0; i < 5; i++) { s = { ...s, userName: `v${i}` }; writes.push(p.save(s)); }
  await Promise.all(writes);
  const back = await new Persister().open(() => Promise.resolve(be));
  assert.equal(back.userName, "v4");
  assert.equal(be.store.rev, 5);
});

check("unreadable storage is never written over", async () => {
  const be = memoryBackend();
  be.store.raw = "{not json"; be.store.rev = 3;
  const p = new Persister();
  const s = await p.open(() => Promise.resolve(be));
  assert.ok(s.corrupt);
  const r = await p.save({ ...s, userName: "x" });
  assert.equal(r.result.ok, false);
  assert.equal(be.store.raw, "{not json");
});

check("two stored copies combine: an empty leftover never wipes the real data", () => {
  const real = blank(); real.conversations[RHEA] = [msg("a"), msg("b")]; real.memories = [{ id: "m1", museId: RHEA, content: "x", type: "PREFERENCE", importance: 3, confidence: 1, createdAt: "2026-10-01T00:00:00.000Z" }];
  const empty = { userName: null, muses: [], conversations: {}, memories: [], rev: 99 };
  const out = JSON.parse(combineRaw(JSON.stringify(empty), JSON.stringify({ ...real, rev: 7 }), 100));
  assert.equal(out.conversations[RHEA].length, 2);
  assert.equal(out.memories.length, 1);
  assert.equal(out.userName, "Sam");
  assert.equal(out.rev, 100);
  const extra = { ...blank(), conversations: { [RHEA]: [msg("c")] } };
  const both = JSON.parse(combineRaw(JSON.stringify(extra), JSON.stringify(real), 8));
  assert.deepEqual(both.conversations[RHEA].map((m) => m.id).sort(), ["a", "b", "c"], "a newer stray copy adds its messages");
});

check("merge: both sides append, deletions stand, an edit beats a delete", () => {
  const base = [msg("a"), msg("b"), msg("c")];
  const both = mergeList(base, [...base, msg("t1")], [...base, msg("o1")]).map((m) => m.id);
  assert.deepEqual(both.sort(), ["a", "b", "c", "o1", "t1"]);
  assert.deepEqual(mergeList(base, [msg("a"), msg("b")], base).map((m) => m.id), ["a", "b"]);
  const edited = { ...msg("c"), content: "changed" };
  assert.equal(mergeList(base, [msg("a"), msg("b")], [msg("a"), msg("b"), edited]).at(-1).content, "changed");
});

check("merge: a reply from the other tab lands next to what it answered", () => {
  const base = [msg("u1")];
  const theirs = [msg("u1"), msg("r1", "muse")];
  const ours = [msg("u1"), msg("u2")];
  assert.deepEqual(mergeList(base, theirs, ours).map((m) => m.id), ["u1", "r1", "u2"]);
});

check("merge: tombstones from either side are kept", () => {
  const base = { ...blank(), forgotten: { [RHEA]: ["a"] } };
  const m = mergeStates(base, { ...base, forgotten: { [RHEA]: ["a", "b"] } }, { ...base, forgotten: { [RHEA]: ["a", "c"] } });
  assert.deepEqual(m.forgotten[RHEA].sort(), ["a", "b", "c"]);
});

/* -------------------------------------------------------------------- time */

const TZ = "Asia/Kolkata";
const wed11pm = "2026-09-30T17:30:00.000Z";   // Wed 30 Sep 23:00 IST
const thu1215 = "2026-10-01T06:45:00.000Z";   // Thu 1 Oct 12:15 IST
const thu11am = "2026-10-01T05:30:00.000Z";   // Thu 1 Oct 11:00 IST

check("a pause is stamped on their message, in their timezone", () => {
  const out = stampPauses([
    { role: "user", content: "see you tomorrow at 11 then", at: wed11pm },
    { role: "assistant", content: "deal", at: "2026-09-30T17:31:00.000Z" },
    { role: "user", content: "hey", at: thu1215 },
  ], TZ, Date.parse(thu1215));
  assert.match(out[0].content, /^\[Wednesday 30 September, 23:00\]/, "first line anchors the window");
  assert.equal(out[1].content, "deal", "their own lines are never stamped");
  assert.match(out[2].content, /^\[Thursday 1 October, 12:15 · 13 hours after the message before\]\nhey$/);
});

check("no stamp inside an unbroken conversation", () => {
  const out = stampPauses([
    { role: "user", content: "a", at: thu1215 },
    { role: "assistant", content: "b", at: thu1215 },
    { role: "user", content: "c", at: "2026-10-01T06:50:00.000Z" },
  ], TZ, Date.parse("2026-10-01T06:50:00.000Z"));
  assert.equal(out[2].content, "c");
});

check("a plan whose time has passed is passed, and not assumed to have happened", () => {
  const block = timeBlock({
    you: "Sam", timeZone: TZ, now: Date.parse(thu1215), previousAt: "2026-09-30T17:31:00.000Z",
    plans: [{ what: "User plans to meet Rhea at 11:00 on Thursday 1 October.", at: thu11am }],
  });
  assert.match(block, /It is Thursday 1 October, 12:15 where Sam is \(afternoon\)/);
  assert.match(block, /last moved 13 hours ago, yesterday Wednesday 30 September, 23:01/);
  assert.match(block, /Thursday 1 October, 11:00 \(today\): an hour and 15 minutes ago\. The time has passed; whether it actually happened is not known/);
});

check("before it, the same plan is still ahead", () => {
  const block = timeBlock({
    you: "Sam", timeZone: TZ, now: Date.parse("2026-10-01T02:30:00.000Z"),
    plans: [{ what: "Meet Rhea.", at: thu11am }],
  });
  assert.match(block, /Meet Rhea\. -- Thursday 1 October, 11:00 \(today\): in 3 hours\./);
});

check("'11am tomorrow' without an offset is a wall-clock time in their zone", () => {
  assert.equal(resolveWhen("2026-10-01T11:00", TZ), thu11am);
  assert.equal(resolveWhen("2026-10-01T11:00:00+05:30", TZ), thu11am);
  assert.equal(resolveWhen("tomorrow", TZ), null);
});

check("the pause is measured from before their latest burst", () => {
  assert.equal(previousMoment([
    { role: "user", content: "a", at: "1" }, { role: "assistant", content: "b", at: "2" },
    { role: "user", content: "c", at: "3" }, { role: "user", content: "d", at: "4" },
  ]), "2");
});

check("the prompt carries the clock when given one", () => {
  const p = { them: "Rhea", you: "Sam", relationship: "a friend", arch: "friend", texture: "close", mode: "character", brief: "x" };
  const sys = personaSystem(p, [], false, { mood: "any", topic: "any", register: "texts" }, TZ, undefined, {
    now: Date.parse(thu1215), previousAt: wed11pm, plans: [{ what: "Meet Rhea.", at: thu11am }],
  });
  assert.match(sys, /WHAT TIME IT IS/);
  assert.match(sys, /PLANS AND DATES/);
  assert.match(sys, /Never write them yourself/);
});

check("extraction keeps the moment it was given", () => {
  const [m] = parseMemories('[{"content":"User plans to meet Rhea at 11:00 on Thursday 1 October.","type":"EVENT","importance":3,"confidence":0.9,"replaces":[],"when":"2026-10-01T11:00:00+05:30"}]');
  assert.equal(m.when, "2026-10-01T11:00:00+05:30");
});

/* ------------------------------------------------------------------ memory */

const now = Date.parse(thu1215);
const withMemories = () => {
  let s = blank();
  s = addMemories(s, RHEA, [{ content: "User works from home on Thursdays.", type: "PERMANENT", importance: 4, confidence: 0.9 }]);
  s = addMemories(s, RHEA, [{ content: "User plans to meet Rhea at 11:00 on Thursday 1 October.", type: "EVENT", importance: 3, confidence: 0.9, when: thu11am }]);
  s = addMemories(s, RHEA, [{ content: "User is organising the group trip to Goa.", type: "GOAL", importance: 3, confidence: 0.9 }], [], { circleId: "circle-1" });
  return s;
};

check("a memory records where it was learned and when it is for", () => {
  const s = withMemories();
  assert.equal(s.memories.find((m) => m.content.includes("meet Rhea")).at, thu11am);
  assert.equal(s.memories.find((m) => m.content.includes("Goa")).circleId, "circle-1");
  assert.equal(s.memories.find((m) => m.content.includes("home")).circleId, undefined);
});

check("one to one: everything is known, nothing is marked private, plans go with their time", () => {
  const s = withMemories();
  const mem = memoriesForTurn(s, RHEA, "hey", null, { now });
  assert.ok(mem.includes("User works from home on Thursdays."));
  assert.ok(mem.includes("User is organising the group trip to Goa."), "what was said in a group is remembered one to one");
  assert.ok(!mem.some((m) => m.includes("meet Rhea")), "a near plan goes through plansForTurn instead");
  assert.ok(!mem.some((m) => m.startsWith("(private)")));
  assert.deepEqual(plansForTurn(s, RHEA, { now }).map((p) => p.at), [thu11am]);
});

check("in a group: one-to-one memories come marked private, this room's do not", () => {
  const s = withMemories();
  const mem = memoriesForTurn(s, RHEA, "hey", null, { room: "circle-1", now });
  assert.ok(mem.includes("(private) User works from home on Thursdays."));
  assert.ok(mem.includes("User is organising the group trip to Goa."));
  assert.match(plansForTurn(s, RHEA, { room: "circle-1", now })[0].what, /^\(private\) /);
  const other = memoriesForTurn(s, RHEA, "hey", null, { room: "circle-2", now });
  assert.ok(other.includes("(private) User is organising the group trip to Goa."), "another group's talk is private too");
});

check("a plan long past is just a fact again", () => {
  const s = withMemories();
  const later = now + 30 * 24 * 3600_000;
  assert.equal(plansForTurn(s, RHEA, { now: later }).length, 0);
  assert.ok(memoriesForTurn(s, RHEA, "meet", null, { now: later }).some((m) => m.includes("meet Rhea")));
});

check("the room is told what (private) means: remembered, but confidences kept", () => {
  const block = circleBlock({ you: "Sam", me: "Rhea", others: [{ name: "Dev", relationship: "friend" }], circleName: "Goa" });
  assert.match(block, /You remember everything you and Sam have talked about on your own -- lines\s+marked \(private\)/);
  assert.match(block, /never act as if you are meeting them\s+fresh/);
  assert.match(block, /you do not spill it\s+unless Sam brings it up here/);
});

check("new messages carry a timestamp", () => {
  assert.ok(Number.isFinite(Date.parse(newMessage("user", "hi").at)));
});

check("the hour is said last, in their timezone, with what that hour looks like", () => {
  const at = Date.parse("2026-10-06T18:30:00Z"); // midnight in Kolkata, evening in London
  const ist = nowBlock("Piyush", "Asia/Kolkata", at);
  assert.match(ist, /WEDNESDAY.*00:00 -- THE MIDDLE OF THE NIGHT/);
  assert.match(ist, /can't sleep/);
  assert.match(ist, /Late-night talk/, "after 11pm she is softer");
  assert.doesNotMatch(nowBlock("Piyush", "Europe/London", at), /Late-night talk/, "not at 19:30");
  assert.match(nowBlock("Piyush", "Europe/London", at), /19:30 -- EVENING/);
  assert.match(nowBlock("Piyush", "Europe/London", Date.parse("2026-10-06T07:00:00Z")), /MORNING/);
  assert.match(nowBlock("Piyush", "Asia/Kolkata", Date.parse("2026-10-06T17:00:00Z")), /22:30 -- LATE AT NIGHT/);
});

let pass = 0, fail = 0;
for (const [n, f] of results) {
  try { await f(); console.log(`  PASS  ${n}`); pass++; }
  catch (e) { console.log(`  FAIL  ${n}\n        ${e.message}`); fail++; }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
