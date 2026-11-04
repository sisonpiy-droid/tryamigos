/* Voice calls: what is spoken, how a reply is split for speaking, call records,
 * and that a call asks the model exactly what a text turn asks.
 */
import assert from "node:assert";

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const { VOICES, DEFAULT_VOICE, forSpeech, isVoice, takeSpeakable, voiceById } = await import("../src/lib/voice/voices.ts");
const { callsOf, editMuse, endCall, findMuse, newMessage, startCall } = await import("../src/lib/solo/store.ts");
const { prepareTurn } = await import("../src/lib/solo/turn.ts");
const { PICKABLE_REGISTERS, REGISTERS, personaSystem } = await import("../src/lib/presence/persona.ts");
const { listenLanguage } = await import("../src/lib/voice/listener.ts");

const results = [];
const check = (n, f) => results.push([n, f]);
const blank = () => ({ userName: "Sam", muses: [], conversations: {}, memories: [], vibes: {}, circles: [], calls: [] });
const RHEA = "builtin-rhea";

/* -------------------------------------------------------------- speaking */

check("what is spoken drops the things that only work on a screen", () => {
  assert.equal(forSpeech("haha 💀 okay\n---\nbata na"), "haha okay\nbata na");
  assert.equal(forSpeech("[Thursday 1 October, 12:15]\nheyy"), "heyy");
  assert.equal(forSpeech("*laughs* stop it"), "stop it");
  assert.equal(forSpeech("**really** good"), "really good");
});

check("the first sentence goes as soon as it exists, however short", () => {
  const { pieces, rest } = takeSpeakable("Haan! Bata kya hua", true);
  assert.deepEqual(pieces, ["Haan!"]);
  assert.equal(rest, "Bata kya hua");
});

check("an unfinished sentence waits for its end", () => {
  assert.deepEqual(takeSpeakable("I was thinking about", true).pieces, []);
  assert.deepEqual(takeSpeakable("It costs 3.", true).pieces, [], "a full stop with nothing after might be 3.5");
});

check("after the first, pieces are kept to a sensible size", () => {
  const { pieces } = takeSpeakable("Ok. Yes. No. Fine then, I suppose that works for everybody here today. And", false);
  assert.equal(pieces.length, 1, "tiny sentences are joined rather than spoken one round trip each");
  assert.match(pieces[0], /^Ok\. Yes\. No\. Fine then/);
});

check("a long run-on breaks at a comma rather than waiting forever", () => {
  const long = "so basically what happened was, ".repeat(10);
  assert.ok(takeSpeakable(long, false).pieces.length >= 1);
});

check("voices: every id is a real one, and unknown ids fall back", () => {
  assert.ok(VOICES.length >= 12);
  assert.ok(isVoice("Kore") && !isVoice("Nonexistent") && !isVoice(""));
  assert.equal(voiceById("Nope").id, DEFAULT_VOICE);
  assert.equal(new Set(VOICES.map((v) => v.id)).size, VOICES.length);
});

check("recognition listens in en-IN for Hinglish speakers", () => {
  assert.equal(listenLanguage(["Hinglish", "Hindi", "English"]), "en-IN");
});

/* ----------------------------------------------------------- the register */

check("a call has its own register, and it is not offered in the vibe panel", () => {
  assert.ok(REGISTERS.live);
  assert.ok(!("live" in PICKABLE_REGISTERS));
  assert.ok("texts" in PICKABLE_REGISTERS);
  const p = { them: "Rhea", you: "Sam", relationship: "a friend", arch: "friend", texture: "close", mode: "character", brief: "x" };
  const sys = personaSystem(p, [], false, { mood: "any", topic: "any", register: "live" });
  assert.match(sys, /real voice call/);
  assert.match(sys, /spoken aloud/);
});

check("a call asks the model what a text turn asks, apart from the register", async () => {
  let s = blank();
  s = { ...s, conversations: { [RHEA]: [newMessage("user", "I have an interview on Friday")] } };
  s = { ...s, memories: [{ id: "m1", museId: RHEA, content: "User works from home.", type: "PERMANENT", importance: 4, confidence: 0.9, createdAt: new Date().toISOString() }] };
  const text = await prepareTurn(s, RHEA);
  const call = await prepareTurn(s, RHEA, { register: "live" });
  assert.equal(call.body.register, "live");
  assert.notEqual(text.body.register, "live");
  /* `can` (voice notes, photos) is texting only, so a call has none. */
  assert.equal(call.body.can, null);
  assert.deepEqual({ ...call.body, register: null, can: null }, { ...text.body, register: null, can: null }, "same persona, memories, plans, history, feelings");
  assert.ok(call.body.memories.includes("User works from home."));
});

/* ----------------------------------------------------------- call records */

check("a call is recorded with its messages, duration and status", () => {
  const t0 = new Date("2026-10-01T10:00:00Z");
  let s = startCall(blank(), RHEA, "call-1", t0);
  assert.equal(callsOf(s, RHEA)[0].status, "CANCELLED", "until something is said");
  const u = { ...newMessage("user", "hi"), via: "voice", callId: "call-1" };
  const m = { ...newMessage("muse", "heyy"), via: "voice", callId: "call-1" };
  s = { ...s, conversations: { [RHEA]: [newMessage("user", "typed earlier"), u, m] } };
  s = endCall(s, "call-1", "COMPLETED", new Date("2026-10-01T10:04:32Z"));
  const c = callsOf(s, RHEA)[0];
  assert.equal(c.status, "COMPLETED");
  assert.equal(c.durationSeconds, 272);
  assert.equal(c.firstMessageId, u.id);
  assert.equal(c.lastMessageId, m.id);
});

check("a call where nothing was said is cancelled, and a failure is a failure", () => {
  let s = startCall(blank(), RHEA, "c", new Date());
  assert.equal(endCall(s, "c", "COMPLETED").calls[0].status, "CANCELLED");
  s = startCall(blank(), RHEA, "c", new Date());
  assert.equal(endCall(s, "c", "FAILED").calls[0].status, "FAILED");
});

check("a voice is saved on the Muse, for starters too", () => {
  const s = editMuse(blank(), RHEA, { voiceId: "Leda" });
  assert.equal(findMuse(s, RHEA).voiceId, "Leda");
});

let pass = 0, fail = 0;
for (const [n, f] of results) {
  try { await f(); console.log(`  PASS  ${n}`); pass++; }
  catch (e) { console.log(`  FAIL  ${n}\n        ${e.message}`); fail++; }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
