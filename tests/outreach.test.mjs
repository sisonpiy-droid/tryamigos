/* Proactive outreach: when a Muse may text first, and what the app does with it.
 *
 * Every rule the scheduler applies is tested here directly: timing in the
 * user's own timezone, quiet hours, the daily limit, the gap between texts,
 * expiry, duplicates, permissions, a missing timezone. Then the app's half:
 * which memories are offered, a sent text landing in the thread, and pending
 * outreach called off when the user raises the subject first.
 */
import assert from "node:assert";

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const { planTime, isQuiet, nextAllowed, localParts, validZone, stableJitter } = await import("../src/lib/proactive/timing.ts");
const { decide } = await import("../src/lib/proactive/decide.ts");
const { inventedNumbers } = await import("../src/lib/proactive/compose.ts");
const { candidates, review, withOutreach } = await import("../src/lib/proactive/client.ts");

const results = [];
const check = (n, f) => results.push([n, f]);
const TZ = "Asia/Kolkata";
const ist = (s) => Date.parse(`${s}+05:30`);
const at = (ts) => { const p = localParts(ts, TZ); return `${p.day} ${String(p.h).padStart(2, "0")}:${String(p.min).padStart(2, "0")}`; };

const device = (over = {}) => ({
  timezone: TZ, proactiveEnabled: true, initiationFrequency: "SOMETIMES",
  quietHoursStart: 22 * 60, quietHoursEnd: 8 * 60, maxDailyProactive: 1, allowedMuseIds: ["builtin-tanvi"], ...over,
});
const trigger = (over = {}) => ({
  id: "t1", type: "UPCOMING_EVENT", museId: "builtin-tanvi", status: "PENDING",
  scheduledFor: new Date(ist("2026-10-01T19:10:00")), expiresAt: new Date(ist("2026-10-02T09:30:00")),
  eventAt: new Date(ist("2026-10-02T10:00:00")), ...over,
});
const none = { sent: [], alreadySent: false };

/* ------------------------------------------------------------------ timing */

check("an interview at 10am Friday is mentioned around 7pm Thursday, their time", () => {
  const p = planTime({ type: "UPCOMING_EVENT", id: "mem-a", now: ist("2026-09-29T12:00:00"), tz: TZ, eventAt: ist("2026-10-02T10:00:00") });
  assert.match(at(p.scheduledFor), /^2026-10-01 19:[0-2]\d$/);
  assert.equal(p.expiresAt, ist("2026-10-02T09:30:00"));
});

check("times are never round, and the same trigger always gets the same time", () => {
  const a = planTime({ type: "UPCOMING_EVENT", id: "mem-b", now: 0, tz: TZ, eventAt: ist("2026-10-02T10:00:00") });
  const b = planTime({ type: "UPCOMING_EVENT", id: "mem-b", now: 0, tz: TZ, eventAt: ist("2026-10-02T10:00:00") });
  assert.equal(a.scheduledFor, b.scheduledFor);
  assert.ok(stableJitter("mem-b", 25) >= 0);
});

check("something this afternoon is mentioned a couple of hours before", () => {
  const p = planTime({ type: "UPCOMING_EVENT", id: "m", now: ist("2026-10-01T09:00:00"), tz: TZ, eventAt: ist("2026-10-01T16:00:00") });
  assert.match(at(p.scheduledFor), /^2026-10-01 13:(3\d|4\d|5\d)$/);
});

check("an event too close, or already past, gets nothing", () => {
  assert.equal(planTime({ type: "UPCOMING_EVENT", id: "m", now: ist("2026-10-01T15:00:00"), tz: TZ, eventAt: ist("2026-10-01T16:00:00") }), null);
  assert.equal(planTime({ type: "UPCOMING_EVENT", id: "m", now: ist("2026-10-02T15:00:00"), tz: TZ, eventAt: ist("2026-10-01T16:00:00") }), null);
});

check("a reminder goes when they asked; a date alone means mid-morning", () => {
  const exact = planTime({ type: "REMINDER", id: "m", now: ist("2026-10-01T09:00:00"), tz: TZ, remindAt: ist("2026-10-02T18:00:00") });
  assert.equal(exact.scheduledFor, ist("2026-10-02T18:00:00"));
  const day = planTime({ type: "REMINDER", id: "m", now: ist("2026-10-01T09:00:00"), tz: TZ, remindAt: ist("2026-10-02T00:00:00"), remindDateOnly: true });
  assert.match(at(day.scheduledFor), /^2026-10-02 09:[3-4]\d$/);
});

check("a follow-up is a few hours after, at a sociable hour", () => {
  const p = planTime({ type: "FOLLOW_UP", id: "m", now: ist("2026-10-02T08:00:00"), tz: TZ, eventAt: ist("2026-10-02T10:00:00") });
  assert.match(at(p.scheduledFor), /^2026-10-02 1[3-4]:\d\d$/);
  const late = planTime({ type: "FOLLOW_UP", id: "m", now: ist("2026-10-02T08:00:00"), tz: TZ, eventAt: ist("2026-10-02T20:00:00") });
  assert.match(at(late.scheduledFor), /^2026-10-03 18:\d\d$/, "an 11pm follow-up waits for the next evening");
});

check("a goal check-in is a couple of days later, early evening", () => {
  const p = planTime({ type: "GOAL_CHECK_IN", id: "m", now: ist("2026-10-01T09:00:00"), tz: TZ, createdAt: ist("2026-10-01T09:00:00") });
  assert.match(at(p.scheduledFor), /^2026-10-03 1[89]:\d\d$/);
});

check("quiet hours wrap past midnight, and 2am defers to just after they end", () => {
  assert.ok(isQuiet(ist("2026-10-02T02:00:00"), TZ, 1320, 480));
  assert.ok(isQuiet(ist("2026-10-01T23:30:00"), TZ, 1320, 480));
  assert.ok(!isQuiet(ist("2026-10-01T19:00:00"), TZ, 1320, 480));
  assert.match(at(nextAllowed(ist("2026-10-02T02:00:00"), TZ, 1320, 480, "x")), /^2026-10-02 08:[1-4]\d$/);
  assert.match(at(nextAllowed(ist("2026-10-01T23:00:00"), TZ, 1320, 480, "x")), /^2026-10-02 08:[1-4]\d$/, "before midnight, the end is tomorrow");
});

check("the same instant is a different local time in another zone", () => {
  const t = ist("2026-10-01T19:00:00");
  assert.equal(localParts(t, "Asia/Kolkata").h, 19);
  assert.equal(localParts(t, "America/New_York").h, 9);
  assert.ok(!validZone("Not/AZone") && !validZone(undefined) && validZone("Europe/London"));
});

/* ---------------------------------------------------------------- decision */

const now = ist("2026-10-01T19:12:00");

check("positive: a due upcoming event, everything allowed, is sent", () => {
  assert.deepEqual(decide(trigger(), device(), none, now), { action: "send" });
});

check("positive: explicit reminder, follow-up and goal check-in are each sent when due", () => {
  assert.equal(decide(trigger({ type: "REMINDER", eventAt: null }), device(), none, now).action, "send");
  assert.equal(decide(trigger({ type: "FOLLOW_UP", eventAt: null }), device(), none, now).action, "send");
  const goal = ["g1", "g2", "g3", "g4", "g5", "g6"].map((id) => decide(trigger({ id, type: "GOAL_CHECK_IN", eventAt: null }), device({ initiationFrequency: "OFTEN" }), none, now).action);
  assert.ok(goal.every((a) => a === "send"), "at Often every goal check-in goes");
});

check("'sometimes' sends some goal check-ins and not others, and keeps to its choice", () => {
  const ids = Array.from({ length: 40 }, (_, i) => `goal-${i}`);
  const sent = ids.filter((id) => decide(trigger({ id, type: "GOAL_CHECK_IN", eventAt: null }), device(), none, now).action === "send");
  assert.ok(sent.length > 5 && sent.length < 35, `sometimes, not always: ${sent.length}/40`);
  const again = ids.filter((id) => decide(trigger({ id, type: "GOAL_CHECK_IN", eventAt: null }), device(), none, now).action === "send");
  assert.deepEqual(again, sent);
});

check("negative: outreach off, or this Muse not allowed, holds it", () => {
  assert.equal(decide(trigger(), device({ proactiveEnabled: false }), none, now).action, "hold");
  assert.equal(decide(trigger(), device({ allowedMuseIds: [] }), none, now).action, "hold");
});

check("negative: quiet hours defer to the next allowed time", () => {
  const v = decide(trigger({ type: "REMINDER", scheduledFor: new Date(ist("2026-10-01T23:30:00")), expiresAt: new Date(ist("2026-10-02T12:00:00")) }), device(), none, ist("2026-10-01T23:30:00"));
  assert.equal(v.action, "defer");
  assert.match(at(v.until), /^2026-10-02 08:/);
});

check("negative: quiet hours past the event's moment expire it instead", () => {
  const v = decide(trigger({ expiresAt: new Date(ist("2026-10-02T07:00:00")), eventAt: new Date(ist("2026-10-02T07:30:00")) }), device(), none, ist("2026-10-01T23:30:00"));
  assert.equal(v.action, "expire");
});

check("negative: the daily limit defers to tomorrow", () => {
  const v = decide(trigger({ type: "REMINDER", expiresAt: new Date(ist("2026-10-04T00:00:00")) }), device(), { sent: [new Date(ist("2026-10-01T11:00:00"))], alreadySent: false }, now);
  assert.equal(v.action, "defer");
  assert.match(at(v.until), /^2026-10-02 /);
});

check("negative: too soon after the last text; a reminder is exempt from the gap", () => {
  const yesterday = { sent: [new Date(ist("2026-09-30T20:00:00"))], alreadySent: false };
  assert.equal(decide(trigger({ type: "FOLLOW_UP", expiresAt: new Date(ist("2026-10-05T00:00:00")) }), device(), yesterday, now).action, "defer");
  assert.equal(decide(trigger({ type: "REMINDER" }), device(), yesterday, now).action, "send");
  assert.equal(decide(trigger(), device(), yesterday, now).action, "send", "an event tomorrow may follow a text from yesterday");
});

check("negative: expired, event already happened, invalid date", () => {
  assert.equal(decide(trigger(), device(), none, ist("2026-10-02T09:45:00")).action, "expire");
  assert.equal(decide(trigger({ expiresAt: new Date(ist("2026-10-03T00:00:00")) }), device(), none, ist("2026-10-02T10:30:00")).action, "expire");
  assert.equal(decide(trigger({ scheduledFor: "not a date" }), device(), none, now).action, "expire");
});

check("negative: a duplicate never goes twice", () => {
  assert.equal(decide(trigger(), device(), { sent: [], alreadySent: true }, now).action, "skip");
  assert.equal(decide(trigger({ status: "SENT" }), device(), none, now).action, "skip");
});

check("negative: no timezone means wait, never guess at 3am", () => {
  assert.equal(decide(trigger(), device({ timezone: null }), none, now).action, "hold");
  assert.equal(decide(trigger(), device({ timezone: "Mars/Olympus" }), none, now).action, "hold");
});

check("negative: 'rarely' never uses follow-ups or goal check-ins; 'never' uses nothing", () => {
  assert.equal(decide(trigger({ type: "FOLLOW_UP" }), device({ initiationFrequency: "RARELY" }), none, now).action, "skip");
  assert.equal(decide(trigger(), device({ initiationFrequency: "NEVER" }), none, now).action, "skip");
});

check("grounding: numbers the note does not contain are caught", () => {
  assert.deepEqual(inventedNumbers("Interview at 3pm tomorrow, good luck", "User has an interview at Google on Friday 2 October."), ["3"]);
  assert.deepEqual(inventedNumbers("Friday the 2nd! Ready?", "User has an interview on Friday 2 October."), []);
});

/* --------------------------------------------------------------- the app */

const base = () => ({ userName: "Piyush", muses: [], conversations: {}, memories: [], vibes: {}, circles: [], outreach: {} });
const T = "builtin-tanvi";

check("only near dated memories and recent goals are offered, each once", () => {
  const n = Date.now();
  const s = {
    ...base(),
    memories: [
      { id: "a", museId: T, content: "User has an interview on Friday.", type: "EVENT", importance: 3, confidence: 0.9, createdAt: new Date(n).toISOString(), at: new Date(n + 2 * 864e5).toISOString() },
      { id: "b", museId: T, content: "User likes chai.", type: "PREFERENCE", importance: 3, confidence: 0.9, createdAt: new Date(n).toISOString() },
      { id: "c", museId: T, content: "User is finishing a pitch deck this week.", type: "GOAL", importance: 3, confidence: 0.9, createdAt: new Date(n).toISOString() },
      { id: "d", museId: T, content: "User went to Goa in 2019.", type: "EVENT", importance: 2, confidence: 0.9, createdAt: new Date(n).toISOString(), at: "2019-05-01T00:00:00.000Z" },
    ],
  };
  assert.deepEqual(candidates(s, T).map((m) => m.id), ["a", "c"]);
  assert.deepEqual(candidates({ ...s, outreach: { evaluated: { a: true } } }, T).map((m) => m.id), ["c"]);
});

check("a sent text lands in the existing thread, once, as that Muse's messages", () => {
  const s = { ...base(), conversations: { [T]: [{ id: "u1", from: "user", content: "hi", at: "2026-10-01T10:00:00.000Z" }] } };
  const item = { id: "int1", triggerId: "t1", museId: T, museName: "Tanvi", message: "kal interview hai na 😭\n---\npractice karein?", sentAt: "2026-10-01T13:42:00.000Z" };
  const once = withOutreach(s, item);
  const twice = withOutreach(once, item);
  const thread = twice.conversations[T];
  assert.equal(thread.length, 3);
  assert.deepEqual(thread.slice(1).map((m) => m.content), ["kal interview hai na 😭", "practice karein?"]);
  assert.ok(thread.slice(1).every((m) => m.from === "muse" && m.proactive.interactionId === "int1"));
});

check("raising the subject first calls the text off; a reply is recorded once", () => {
  const trig = { id: "t1", museId: T, sourceMemoryId: "a", type: "UPCOMING_EVENT", reason: "interview on Friday", scheduledFor: "2026-10-01T13:40:00.000Z", keywords: ["interview"], createdAt: "2026-09-29T10:00:00.000Z", status: "PENDING" };
  const mem = { id: "a", museId: T, content: "User has an interview.", type: "EVENT", importance: 3, confidence: 1, createdAt: "2026-09-29T10:00:00.000Z" };
  const s = { ...base(), memories: [mem], outreach: { triggers: [trig] }, conversations: { [T]: [{ id: "u", from: "user", content: "didi my Interview prep is going ok", at: "2026-09-30T10:00:00.000Z" }] } };
  const r = review(s);
  assert.deepEqual(r.cancelDiscussed, ["t1"]);
  assert.equal(r.state.outreach.triggers[0].status, "CANCELLED");
  assert.equal(review(r.state).state, r.state, "nothing more to do the second time");

  const gone = review({ ...s, memories: [], conversations: {} });
  assert.deepEqual(gone.cancelGone, ["t1"], "the memory was replaced by how it went");

  const p = { ...base(), conversations: { [T]: [
    { id: "p", from: "muse", content: "practice karein?", at: "2026-10-01T13:42:00.000Z", proactive: { interactionId: "int1" } },
    { id: "u", from: "user", content: "yes", at: "2026-10-01T13:50:00.000Z" },
  ] } };
  const rr = review(p);
  assert.deepEqual(rr.responded, ["int1"]);
  assert.deepEqual(review(rr.state).responded, []);
});

let pass = 0, fail = 0;
for (const [n, f] of results) {
  try { await f(); console.log(`  PASS  ${n}`); pass++; }
  catch (e) { console.log(`  FAIL  ${n}\n        ${e.message}`); fail++; }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
