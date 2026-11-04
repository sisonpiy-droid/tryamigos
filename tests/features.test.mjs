/* Texting rhythm, reactions, and the story of a relationship.
 *
 * Each of these is a small piece of logic the screen trusts completely: when a
 * text in a burst appears, whether a reply was really just a reaction, what the
 * model is told about reactions, and the numbers on the story page.
 */
import assert from "node:assert";

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const { lastShowAt, newMessage, paced, react, readReaction, typingMs } = await import("../src/lib/solo/store.ts");
const { prepareTurn, withAppMessage } = await import("../src/lib/solo/turn.ts");
const { storyLine, storyOf } = await import("../src/lib/solo/story.ts");

const results = [];
const check = (n, f) => results.push([n, f]);
const RHEA = "builtin-rhea";
const blank = () => ({ userName: "Piyush", muses: [], conversations: {}, memories: [], vibes: {}, circles: [], calls: [] });

/* ------------------------------------------------------------------ rhythm */

check("a burst is paced: the first text now, each next after a typing pause", () => {
  const parts = ["haan", "bol na kya hua aaj office me", "aur khana khaya?"].map((c) => newMessage("muse", c));
  const out = paced(parts, 1_000_000);
  const at = out.map((m) => Date.parse(m.showAt));
  assert.equal(at[0], 1_000_000);
  assert.ok(at[1] - at[0] >= 700 && at[1] - at[0] <= 2700);
  assert.ok(at[2] > at[1]);
  assert.equal(lastShowAt(out), at[2]);
});

check("a longer text takes longer to type, within bounds, and the same text always the same", () => {
  const short = { id: "a", content: "ok" };
  const long = { id: "a", content: "x".repeat(200) };
  assert.ok(typingMs(long) > typingMs(short));
  assert.ok(typingMs(long) <= 2700 && typingMs(short) >= 700);
  assert.equal(typingMs(long), typingMs(long));
});

/* --------------------------------------------------------------- reactions */

check("a reply opening with [react: …] is a reaction, and may be the whole reply", () => {
  assert.deepEqual(readReaction("[react: 😂] haha true"), { emoji: "😂", rest: "haha true" });
  assert.deepEqual(readReaction("[react:❤️]"), { emoji: "❤️", rest: "" });
  assert.deepEqual(readReaction("[react: 🙄]\n\ndin ke 10 baje?"), { emoji: "🙄", rest: "din ke 10 baje?" });
  assert.deepEqual(readReaction("no tag here [react: 😂]"), { emoji: null, rest: "no tag here [react: 😂]" });
});

check("reacting sets one emoji per side; the same one again takes it off", () => {
  let s = { ...blank(), conversations: { [RHEA]: [{ id: "m1", from: "muse", content: "hi", at: "2026-10-01T10:00:00Z" }] } };
  s = react(s, RHEA, "m1", "user", "❤️");
  assert.equal(s.conversations[RHEA][0].reactions.user, "❤️");
  s = react(s, RHEA, "m1", "muse", "😂");
  assert.deepEqual(s.conversations[RHEA][0].reactions, { user: "❤️", muse: "😂" });
  s = react(s, RHEA, "m1", "user", "❤️");
  assert.deepEqual(s.conversations[RHEA][0].reactions, { muse: "😂" });
});

check("the model hears about reactions in the right place, in parentheses", async () => {
  const s = { ...blank(), conversations: { [RHEA]: [
    { id: "u1", from: "user", content: "goodnight", at: "2026-10-01T10:00:00Z", reactions: { muse: "😴" } },
    { id: "m1", from: "muse", content: "so ja ab", at: "2026-10-01T10:00:05Z", reactions: { user: "❤️" } },
    { id: "u2", from: "user", content: "haha ok", at: "2026-10-01T10:01:00Z" },
  ] } };
  const { body } = await prepareTurn(s, RHEA);
  const [first, , third] = body.messages;
  assert.match(first.content, /^\(you reacted 😴 to this\)\ngoodnight$/);
  assert.match(third.content, /^\(reacted ❤️ to your "so ja ab"\)\nhaha ok$/);
  assert.ok(!body.messages.some((m) => /^\[/.test(m.content)), "never brackets: those are timestamps");
});

check("an app message in a full window gives up the oldest, staying within the route's 60", async () => {
  const thread = Array.from({ length: 80 }, (_, i) => ({ id: `x${i}`, from: i % 2 ? "muse" : "user", content: `m${i}`, at: new Date(1e12 + i * 1000).toISOString() }));
  const prepared = await prepareTurn({ ...blank(), conversations: { [RHEA]: thread } }, RHEA);
  assert.equal(prepared.body.messages.length, 60);
  withAppMessage(prepared, "(the call just connected)");
  assert.equal(prepared.body.messages.length, 60);
  assert.equal(prepared.body.messages.at(-1).content, "(the call just connected)");
});

/* ------------------------------------------------------------------ media */

const { readMedia, mediaAllowed, sharedForTurn, memoriesForTurn, isMediaCaption, sentPhoto, sentSong, splitMediaLines } = await import("../src/lib/solo/store.ts");
const { wornPhrases, wornBlock, sendBlock, sharedBlock } = await import("../src/lib/presence/persona.ts");
const { wav } = await import("../src/lib/solo/media.ts");

check("media tags are read at the start of a message, with anything after kept as a caption", () => {
  assert.deepEqual(readMedia("[voice] arre sun na, aaj kya hua"), { kind: "voice", text: "arre sun na, aaj kya hua" });
  assert.deepEqual(readMedia("[photo: maggi in a steel bowl on my bed]"), { kind: "photo", description: "maggi in a steel bowl on my bed", caption: "" });
  assert.deepEqual(readMedia("[photo: my desk] dekh kitna kaam hai"), { kind: "photo", description: "my desk", caption: "dekh kitna kaam hai" });
  assert.deepEqual(readMedia("[song: Kun Faya Kun - A.R. Rahman]"), { kind: "song", title: "Kun Faya Kun", artist: "A.R. Rahman", caption: "" });
  assert.deepEqual(readMedia("[song: Stand by Me by Ben E. King]"), { kind: "song", title: "Stand by Me", artist: "Ben E. King", caption: "" });
  assert.deepEqual(readMedia("bas aise hi [photo: x y z]"), { kind: "text", text: "bas aise hi [photo: x y z]" });
  assert.deepEqual(readMedia("[voice]"), { kind: "text", text: "[voice]" });
});

check("what she sent reads as words for the model, and the thread hides those words", () => {
  assert.equal(sentPhoto("my chai"), "(sent a photo: my chai)");
  assert.equal(sentSong({ title: "Kesariya", artist: "Arijit Singh" }), "(sent a song: Kesariya by Arijit Singh)");
  assert.ok(isMediaCaption(sentPhoto("x")) && isMediaCaption(sentSong({ title: "a", artist: "" })));
  assert.ok(!isMediaCaption("i sent a photo yesterday"));
});

check("each kind of media rests for a while after it was sent, and photos never for a public figure or someone who died", () => {
  const now = Date.parse("2026-10-02T12:00:00Z");
  const muse = (mode) => ({ id: "m", name: "X", description: "d", relationshipType: "friend", persona: { mode } });
  const at = (h) => new Date(now - h * 3_600_000).toISOString();
  const s = (mode, log) => ({ ...blank(), muses: [muse(mode)], conversations: { m: log } });
  const on = { now, roll: 0 };
  assert.deepEqual(mediaAllowed(s("living", []), "m", on), { photo: true, voice: true, song: true });
  const recent = [
    { id: "a", from: "muse", content: "(sent a photo: x)", at: at(1.5), image: { id: "i", w: 1, h: 1 } },
    { id: "b", from: "muse", content: "hi", at: at(1), voiceNote: { id: "v", seconds: 3 } },
    { id: "c", from: "muse", content: "(sent a song: s)", at: at(20), song: { title: "s", artist: "" } },
  ];
  assert.deepEqual(mediaAllowed(s("living", recent), "m", on), { photo: false, voice: false, song: false });
  assert.deepEqual(mediaAllowed(s("living", recent), "m", { ...on, now: now + 9 * 3_600_000 }), { photo: true, voice: true, song: true });
  assert.equal(mediaAllowed(s("figure", []), "m", on).photo, false);
  assert.equal(mediaAllowed(s("memorial", []), "m", on).photo, false);
  assert.deepEqual(mediaAllowed(s("living", []), "m", { ...on, canStore: false }), { photo: false, voice: false, song: true });
});

check("unasked, media is on offer only some turns; asked for, it is always on offer", () => {
  const now = Date.parse("2026-10-02T12:00:00Z");
  const s = (log) => ({ ...blank(), muses: [{ id: "m", name: "X", description: "d", relationshipType: "friend", persona: { mode: "living" } }], conversations: { m: log } });
  const said = (content) => ({ id: "u", from: "user", content, at: new Date(now).toISOString() });
  assert.deepEqual(mediaAllowed(s([said("kya kar rahi")]), "m", { now, roll: 0.9 }), { photo: false, voice: false, song: false });
  assert.deepEqual(mediaAllowed(s([said("lunch ka photo bhej na")]), "m", { now, roll: 0.9 }), { photo: true, voice: false, song: false });
  assert.equal(mediaAllowed(s([said("ek voice note bhej")]), "m", { now, roll: 0.9 }).voice, true);
  assert.equal(mediaAllowed(s([said("koi gaana suggest kar")]), "m", { now, roll: 0.9 }).song, true);
  const justSent = [{ id: "a", from: "muse", content: "(sent a photo: x)", at: new Date(now - 5 * 60_000).toISOString(), image: { id: "i", w: 1, h: 1 } }, said("ek aur photo")];
  assert.equal(mediaAllowed(s(justSent), "m", { now, roll: 0 }).photo, true, "asked again right after one: still sent");
  assert.equal(mediaAllowed(s([said("show me your room")]), "m", { now, roll: 0.9 }).photo, true);
  assert.equal(mediaAllowed(s([said("image bhej")]), "m", { now, roll: 0.9 }).photo, true);
  /* The roll comes from the message, so asking again is not a re-roll. */
  const log = [said("hmm")];
  assert.deepEqual(mediaAllowed(s(log), "m", { now }), mediaAllowed(s(log), "m", { now }));
});

check("a tag on its own line inside a text becomes its own message", () => {
  assert.deepEqual(
    splitMediaLines(["arre haan\n[photo: my chai]\nye dekh", "[voice] sun na"]),
    ["arre haan", "[photo: my chai]", "ye dekh", "[voice] sun na"],
  );
  assert.deepEqual(splitMediaLines(["line one\nline two"]), ["line one\nline two"]);
});

check("the prompt offers only what is allowed this turn, and games always", () => {
  const all = sendBlock({ photo: true, voice: true, song: true }, "Piyush");
  assert.match(all, /\[voice\]/);
  assert.match(all, /\[photo:/);
  assert.match(all, /\[song:/);
  const some = sendBlock({ photo: false, voice: true, song: false }, "Piyush");
  assert.ok(!/\[photo:/.test(some) && !/\[song:/.test(some) && /\[voice\]/.test(some));
  const none = sendBlock({ photo: false, voice: false, song: false }, "Piyush");
  assert.ok(!/THINGS YOU CAN SEND/.test(none) && /GAMES/.test(none));
  assert.equal(sendBlock(null, "Piyush"), "");
});

check("a voice note is a playable WAV of the PCM it was made from", async () => {
  const pcm = new Uint8Array(48000 * 2);
  const blob = wav(pcm, 24000);
  assert.equal(blob.type, "audio/wav");
  assert.equal(blob.size, 44 + pcm.length);
  const head = new DataView(await blob.slice(0, 44).arrayBuffer());
  assert.equal(String.fromCharCode(head.getUint8(0), head.getUint8(1), head.getUint8(2), head.getUint8(3)), "RIFF");
  assert.equal(head.getUint32(24, true), 24000);
  assert.equal(head.getUint32(40, true), pcm.length);
});

/* ------------------------------------------------------- between you two */

const mem = (id, content, type, day = 1) => ({ id, museId: RHEA, content, type, importance: 3, confidence: 1, createdAt: new Date(Date.UTC(2026, 8, day)).toISOString() });

check("inside jokes go to the prompt on their own, not ranked against the subject with the facts", () => {
  const s = { ...blank(), memories: [
    mem("f1", "User works at a bank.", "PERMANENT"),
    mem("j1", "Running joke: the Muse calls User 'chotu'.", "SHARED"),
  ] };
  assert.deepEqual(memoriesForTurn(s, RHEA, "anything"), ["User works at a bank."]);
  assert.deepEqual(sharedForTurn(s, RHEA), ["Running joke: the Muse calls User 'chotu'."]);
});

check("with many inside jokes: the newest always, and older ones that change from day to day", () => {
  const s = { ...blank(), memories: Array.from({ length: 12 }, (_, i) => mem(`j${i}`, `joke ${i}`, "SHARED", i + 1)) };
  const today = sharedForTurn(s, RHEA, Date.parse("2026-10-02T12:00:00Z"));
  const later = sharedForTurn(s, RHEA, Date.parse("2026-10-03T12:00:00Z"));
  assert.equal(today.length, 5);
  assert.deepEqual(today.slice(0, 3), ["joke 11", "joke 10", "joke 9"]);
  assert.notDeepEqual(today.slice(3), later.slice(3));
  assert.equal(sharedBlock([], "Piyush"), "");
  assert.match(sharedBlock(today, "Piyush"), /JUST BETWEEN YOU TWO[\s\S]*joke 11/);
});

/* ----------------------------------------------------------------- tics */

check("an opener or phrase used over and over across days is caught; ordinary variety is not", () => {
  const looped = Array.from({ length: 30 }, (_, i) =>
    i % 3 === 0 ? `haan bol kya hua ${i}` : i % 3 === 1 ? `pagal hai kya tu yaar ${i}` : `office me aaj ${["meeting", "lunch", "boss", "deadline", "chai"][i % 5]} 😂`);
  const w = wornPhrases(looped);
  assert.ok(w.openers.includes("haan bol"), JSON.stringify(w));
  assert.ok([...w.openers, ...w.phrases].some((p) => p.includes("pagal hai")), JSON.stringify(w));
  assert.ok(!w.phrases.some((p) => p.includes("bol kya")), "a phrase an opener already covers is not listed twice");
  assert.ok(w.emoji.some((e) => e.startsWith("😂")), JSON.stringify(w));
  assert.match(wornBlock(w), /YOUR TICS LATELY[\s\S]*"haan bol"/);

  const varied = ["kal movie dekhi", "chai bana rahi hu", "office se nikli abhi", "mummy ka phone aaya tha", "bahut neend aa rahi",
    "tu kab free hai", "maine wo book khatam ki", "baarish ho rahi yaha", "kal gym gayi thi finally", "aaj khana bahar se",
    "boss ne phir meeting rakhi", "weekend pe kya plan", "naya cafe khula hai", "phone ki battery mar gayi"];
  const none = wornPhrases(varied);
  assert.deepEqual([none.openers, none.phrases, none.emoji], [[], [], []]);
  assert.equal(wornBlock(none), "");
  assert.equal(wornPhrases(looped.slice(0, 5)).openers.length, 0, "too few texts to call anything a habit");
});

check("the turn carries inside jokes, tics and what can be sent; a voice note is marked as one", async () => {
  const thread = [
    { id: "u1", from: "user", content: "hi", at: "2026-10-01T10:00:00Z" },
    { id: "m1", from: "muse", content: "arre sun", at: "2026-10-01T10:00:05Z", voiceNote: { id: "vn-m1", seconds: 4 } },
    { id: "u2", from: "user", content: "haha", at: "2026-10-01T10:01:00Z" },
  ];
  const s = { ...blank(), conversations: { [RHEA]: thread }, memories: [mem("j", "Running joke: chotu.", "SHARED")] };
  const { body } = await prepareTurn(s, RHEA, { canStore: true });
  assert.deepEqual(body.shared, ["Running joke: chotu."]);
  assert.equal(body.worn.of, 0, "a voice note is not counted as a text");
  assert.equal(body.messages[1].content, "(voice note) arre sun");
  assert.ok(body.can && typeof body.can.photo === "boolean");
  const live = await prepareTurn(s, RHEA, { register: "live" });
  assert.equal(live.body.can, null, "never on a call");
});

/* ------------------------------------------------------------------- story */

const day = (d, h = 12) => new Date(Date.UTC(2026, 9, d, h)).toISOString();
const storyState = () => ({
  ...blank(),
  conversations: { [RHEA]: [
    { id: "a", from: "user", content: "hi", at: day(1) },
    { id: "b", from: "muse", content: "hey", at: day(1) },
    { id: "c", from: "user", content: "look", at: day(3), image: { id: "img", w: 1, h: 1 } },
    { id: "d", from: "muse", content: "texted first", at: day(4), proactive: { interactionId: "i" } },
    { id: "e", from: "user", content: "yo", at: day(5), reactions: { muse: "😂" } },
    { id: "f", from: "muse", content: "later", at: day(5), showAt: day(9) },
  ] },
  calls: [{ id: "c1", museId: RHEA, startedAt: day(4, 15), durationSeconds: 300, status: "COMPLETED" }],
  memories: [
    { id: "m1", museId: RHEA, content: "User has an exam on Friday.", type: "EVENT", importance: 3, confidence: 1, createdAt: day(2), at: day(9) },
    { id: "m2", museId: RHEA, content: "User likes chai.", type: "PREFERENCE", importance: 3, confidence: 1, createdAt: day(2) },
  ],
});

check("the story counts days, streaks, calls and firsts from what is kept", () => {
  const s = storyOf(storyState(), RHEA, Date.parse(day(5, 20)), "UTC");
  assert.equal(s.since, day(1));
  assert.equal(s.daysTalked, 4, "days 1, 3, 4, 5");
  assert.equal(s.streak, 3, "3, 4 and 5 in a row, ending today");
  assert.equal(s.messages, 5, "a text not shown yet is not counted");
  assert.equal(s.calls, 1);
  assert.equal(s.callMinutes, 5);
  assert.deepEqual(s.milestones.map((m) => m.label), [
    "First message", "First photo you sent", "First time they texted you first", "First call", "First time they reacted to you",
  ]);
  assert.deepEqual(s.moments.map((m) => m.id), ["m1"], "events only");
});

check("a streak survives until the day after, then ends", () => {
  assert.equal(storyOf(storyState(), RHEA, Date.parse(day(6, 9)), "UTC").streak, 3);
  assert.equal(storyOf(storyState(), RHEA, Date.parse(day(7, 9)), "UTC").streak, 0);
});

check("the model's one line of history is background, and absent when there is none", () => {
  const line = storyLine(storyOf(storyState(), RHEA, Date.parse(day(5, 20)), "UTC"), Date.parse(day(5, 20)));
  assert.match(line, /talking here for a few days, on 4 of the last 14 days, 3 days in a row now, 1 call/);
  assert.equal(storyLine(storyOf(blank(), RHEA, Date.now(), "UTC"), Date.now()), null);
});

check("Romantic is offered only for invented adults who are not family", async () => {
  const { moodsFor, romanceAllowed } = await import("../src/lib/presence/persona.ts");
  assert.ok(romanceAllowed({ mode: "character", arch: "partner" }));
  assert.ok(romanceAllowed({ mode: "fictional", arch: "other", minor: false }));
  assert.ok(!romanceAllowed({ mode: "fictional", arch: "other" }), "unclear age counts as a minor");
  assert.ok(!romanceAllowed({ mode: "character", arch: "partner", minor: true }));
  assert.ok(!romanceAllowed({ mode: "character", arch: "sibling" }));
  assert.ok(!romanceAllowed({ mode: "memorial", arch: "partner" }), "never real people");
  assert.ok(!romanceAllowed({ mode: "figure", arch: "other" }));
  assert.ok("flirty" in moodsFor({ mode: "character", arch: "friend" }));
  assert.ok(!("flirty" in moodsFor({ mode: "character", arch: "parent" })));
  assert.ok(!("flirty" in moodsFor(null)));
});

check("forget about a word deletes the memories that mention it, whole words only", async () => {
  const { mentions } = await import("../src/lib/solo/store.ts");
  assert.ok(mentions("Piyush went to Goa in May", "goa"));
  assert.ok(mentions("goa trip was fun", "Goa"));
  assert.ok(!mentions("Piyush's goal is to run", "goa"), "not inside another word");
  assert.ok(mentions("Wants to visit North Goa again", "north goa"));
  assert.ok(!mentions("anything", "  "));
  assert.ok(mentions("costs $5 (cheap)", "$5 (cheap)"), "regex characters are literal");
});

let pass = 0, fail = 0;
for (const [n, f] of results) {
  try { await f(); console.log(`  PASS  ${n}`); pass++; }
  catch (e) { console.log(`  FAIL  ${n}\n        ${e.message}`); fail++; }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
