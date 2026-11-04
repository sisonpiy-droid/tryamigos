/* Her own life, the moments a relationship unlocks, the quiz score, plans made
 * together, promises she owes, and what a member brings into a group.
 *
 * All of it is state the screen trusts: when her life is due to move on and
 * what a day of it does to the storylines, which moment is due and for whom,
 * who a quiz point goes to, when a plan starts and stops being "now", and what
 * the prompt is told about each.
 */
import assert from "node:assert";

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const life = await import("../src/lib/solo/life.ts");
const store = await import("../src/lib/solo/store.ts");
const persona = await import("../src/lib/presence/persona.ts");
const { prepareTurn } = await import("../src/lib/solo/turn.ts");

const results = [];
const check = (n, f) => results.push([n, f]);
const RHEA = "builtin-rhea";
const blank = () => ({ userName: "Piyush", muses: [], conversations: {}, memories: [], vibes: {}, circles: [], calls: [] });
const NOW = Date.parse("2026-10-02T12:00:00Z");
const hoursAgo = (h) => new Date(NOW - h * 3_600_000).toISOString();
const made = (mode, extra = {}) => ({ id: "x", name: "Aisha", description: "d", relationshipType: "friend", persona: { them: "Aisha", you: "Piyush", mode, arch: "friend", ...extra } });

/* ------------------------------------------------------------- her life */

check("only someone invented has a life of her own, and it moves on about once a day", () => {
  assert.equal(life.lifeDue(blank(), RHEA, NOW), true, "a starter is a made-up character");
  for (const mode of ["living", "memorial", "figure"]) {
    assert.equal(life.lifeDue({ ...blank(), muses: [made(mode)] }, "x", NOW), false, mode);
  }
  const s = { ...blank(), lives: { [RHEA]: { arcs: [], advancedAt: hoursAgo(5) } } };
  assert.equal(life.lifeDue(s, RHEA, NOW), false);
  assert.equal(life.lifeDue({ ...s, lives: { [RHEA]: { arcs: [], advancedAt: hoursAgo(21) } } }, RHEA, NOW), true);
});

check("a day of her life moves storylines on, starts new ones, marks what she told, and keeps at most three going", () => {
  let s = life.applyLife(blank(), RHEA, { arcs: [
    { title: "Flatmate war", beat: "Riya keeps the AC at 16." },
    { title: "Pottery class", beat: "Signed up for a Saturday class." },
  ], told: [] }, NOW);
  const [war, pottery] = s.lives[RHEA].arcs;
  assert.equal(s.lives[RHEA].arcs.length, 2);
  s = life.applyLife(s, RHEA, { arcs: [
    { id: war.id, title: war.title, beat: "Riya left a note on the fridge." },
    { id: pottery.id, title: pottery.title, beat: "Made a lopsided bowl.", done: true },
    { title: "Cousin's wedding", beat: "Mummy wants her to dance at the sangeet." },
    { title: "New job hunt", beat: "Two interviews lined up." },
  ], told: [war.beats[0].id] }, NOW + 86_400_000);
  const arcs = s.lives[RHEA].arcs;
  assert.equal(arcs.filter((a) => !a.done).length, 3, "three going");
  assert.ok(arcs.find((a) => a.title === "Pottery class")?.done, "a finished one is kept a while, done");
  const w = arcs.find((a) => a.title === "Flatmate war");
  assert.deepEqual(w.beats.map((b) => b.text), ["Riya keeps the AC at 16.", "Riya left a note on the fridge."]);
  assert.equal(w.beats[0].told, true);

  const turn = life.lifeForTurn(s, RHEA);
  assert.ok(turn.every((a) => a.untold), "the newest steps are news");
  assert.match(persona.lifeBlock(turn, "Piyush"), /WHAT IS GOING ON IN YOUR LIFE[\s\S]*fridge[\s\S]*have not told Piyush yet/);
  assert.equal(persona.lifeBlock([], "Piyush"), "");
});

/* -------------------------------------------------------------- promises */

check("what she said she would tell them is owed for three days, and pushed once it has been a while", () => {
  const mem = (id, h, type = "PROMISE") => ({ id, museId: RHEA, content: `owed ${id}`, type, importance: 3, confidence: 1, createdAt: hoursAgo(h) });
  const s = { ...blank(), memories: [mem("a", 1), mem("b", 80), mem("c", 3), { ...mem("d", 1, "PERMANENT"), content: "User works at a bank." }] };
  const owed = store.promisesForTurn(s, RHEA, NOW);
  assert.deepEqual(owed.map((p) => p.what), ["owed a", "owed c"]);
  assert.match(persona.promiseBlock(owed, "Piyush"), /Tell it now/);
  assert.match(persona.promiseBlock(owed.slice(0, 1), "Piyush"), /keep the suspense/);
  assert.ok(!store.memoriesForTurn(s, RHEA, "x", null, { now: NOW }).some((m) => m.startsWith("owed")), "not listed as facts about them");
});

check("a kept promise closes the owed one and is not stored itself", () => {
  const known = ["The Muse said it would tell User what happened with Riya."];
  let s = { ...blank(), memories: [{ id: "p", museId: RHEA, content: known[0], type: "PROMISE", importance: 3, confidence: 1, createdAt: hoursAgo(2) }] };
  s = store.addMemories(s, RHEA, [{ content: "Kept: told User about Riya.", type: "DONE", importance: 3, confidence: 1, replaces: [0] }], known);
  assert.deepEqual(s.memories, []);
});

/* --------------------------------------------------------------- moments */

const talked = (days, extra = {}) => {
  const log = [];
  for (let d = 0; d < days; d++) log.push({ id: `m${d}`, from: "user", content: "hi", at: new Date(NOW - (days - 1 - d) * 86_400_000).toISOString() });
  return { ...blank(), conversations: { [RHEA]: log }, ...extra };
};

check("a moment is due once it is reached, one a day, each once", () => {
  assert.equal(life.momentDue(talked(2), RHEA, NOW, "UTC"), null);
  assert.equal(life.momentDue(talked(3), RHEA, NOW, "UTC"), "days-3");
  const had = talked(8, { unlocked: { [RHEA]: [{ key: "days-3", at: hoursAgo(48) }] } });
  assert.equal(life.momentDue(had, RHEA, NOW, "UTC"), "days-7");
  const today = talked(8, { unlocked: { [RHEA]: [{ key: "days-3", at: hoursAgo(2) }] } });
  assert.equal(life.momentDue(today, RHEA, NOW, "UTC"), null, "not two in a day");
  const s = life.unlock(talked(3), RHEA, "days-3", NOW);
  assert.equal(life.unlock(s, RHEA, "days-3", NOW), s, "once only");
  assert.match(persona.momentBlock("days-7", "Piyush"), /A MOMENT[\s\S]*never told them[\s\S]*never mention days/);
});

check("a portrait of a real person never gets a moment that would make up their life", () => {
  const s = { ...talked(8), muses: [made("living")], conversations: { x: talked(8).conversations[RHEA] } };
  assert.equal(life.momentDue(s, "x", NOW, "UTC"), "streak-7", "days-3 and days-7 invent; the streak does not");
});

check("the story page shows what is unlocked and the next one to come", () => {
  const s = life.unlock(talked(4), RHEA, "days-3", NOW);
  const m = life.momentsOf(s, RHEA, NOW, "UTC");
  assert.deepEqual(m.unlocked.map((u) => u.label), ["Three days talking"]);
  assert.deepEqual(m.next, { label: "Your first call", toGo: "your first call" });
});

/* ------------------------------------------------------------------ quiz */

check("a quiz point is read from the tag, given to the right side, and counted", () => {
  assert.deepEqual(life.readPoint("[point: Piyush] haan sahi jawab 😤"), { point: "user", rest: "haan sahi jawab 😤" });
  assert.deepEqual(life.readPoint("galat! [point: me] mera fav color purple hai"), { point: "muse", rest: "galat! mera fav color purple hai" });
  assert.deepEqual(life.readPoint("no tag"), { point: null, rest: "no tag" });
  let s = life.addPoint(blank(), RHEA, "user", NOW);
  s = life.addPoint(s, RHEA, "muse", NOW);
  s = life.addPoint(s, RHEA, "muse", NOW);
  assert.deepEqual({ ...s.scores[RHEA], lastAt: null }, { user: 1, muse: 2, rounds: 3, lastAt: null });
  assert.match(persona.quizBlock(s.scores[RHEA], "Piyush", NOW), /Piyush 1, you 2, over 3 questions/);
  assert.match(persona.quizBlock(null, "Piyush", NOW), /never played/);
});

/* ---------------------------------------------------- plans made together */

check("a plan made together is due at its time, runs for three hours once started, then is over", () => {
  const plan = { id: "p1", museId: RHEA, content: "User and the Muse plan to watch a movie together at 21:00 on Saturday 4 October", type: "EVENT", importance: 3, confidence: 1, createdAt: hoursAgo(30), at: new Date(NOW + 5 * 60_000).toISOString() };
  const other = { ...plan, id: "p2", content: "User has an exam on Saturday", at: plan.at };
  let s = { ...blank(), memories: [plan, other] };
  assert.equal(life.planDue(s, RHEA, NOW - 30 * 60_000), null, "not yet");
  assert.equal(life.planDue(s, RHEA, NOW)?.id, "p1", "ten minutes before counts; an exam is not a plan together");
  s = life.markStarted(s, "p1", NOW);
  assert.equal(life.planDue(s, RHEA, NOW), null, "started once");
  assert.equal(life.togetherNow(s, RHEA, NOW + 60 * 60_000)?.id, "p1");
  assert.equal(life.togetherNow(s, RHEA, NOW + 4 * 3_600_000), null, "over after three hours");
  assert.match(persona.togetherBlock({ what: "watch a movie", since: 20 * 60_000 }, "Piyush"), /RIGHT NOW, TOGETHER[\s\S]*20 minutes ago/);
});

check("while a plan made together is on, the turn says so instead of 'time passed, outcome unknown'", async () => {
  const at = new Date(Date.now() - 30 * 60_000).toISOString();
  const plan = { id: "p1", museId: RHEA, content: "User and the Muse plan to watch a movie together tonight", type: "EVENT", importance: 3, confidence: 1, createdAt: at, at };
  const s = { ...blank(), memories: [plan], started: { p1: at }, conversations: { [RHEA]: [{ id: "u", from: "user", content: "shuru?", at: new Date().toISOString() }] } };
  const { body } = await prepareTurn(s, RHEA);
  assert.equal(body.together.what, plan.content);
  assert.ok(!body.plans.some((p) => p.what === plan.content), "not also in the plan list");
});

/* ----------------------------------------------------------------- groups */

check("in a group, each member brings the recent end of their own one-to-one chat, and only theirs", () => {
  const log = Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, from: i % 2 ? "muse" : "user", content: `line ${i}`, at: new Date(NOW - (30 - i) * 60_000).toISOString() }));
  const s = { ...blank(), conversations: { [RHEA]: log, other: [{ id: "o", from: "user", content: "secret", at: hoursAgo(1) }] } };
  const mine = store.recentOneToOne(s, RHEA, NOW);
  assert.equal(mine.length, 30, "everything that fits, up to thirty");
  assert.equal(mine.at(-1).content, "line 29");
  assert.ok(!mine.some((l) => l.content === "secret"));
  const block = persona.oneToOneBlock(mine, "Piyush", "UTC");
  assert.match(block, /YOU AND PIYUSH, ON YOUR OWN[\s\S]*Nobody else in this group[\s\S]*Piyush: line 28/);
  assert.equal(persona.oneToOneBlock([], "Piyush"), "");
});

/* --------------------------------------------- a conversation that was refused */

const { cutoffFrom } = await import("../src/lib/solo/turn.ts");

check("once a reply only went through on the end of the chat, later turns send only that end", async () => {
  const log = Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, from: i % 2 ? "muse" : "user", content: `line ${i}`, at: new Date(NOW + i * 1000).toISOString() }));
  let s = { ...blank(), conversations: { [RHEA]: log } };
  const prepared = await prepareTurn(s, RHEA);
  assert.equal(prepared.sent.length, 12);
  assert.deepEqual(cutoffFrom(prepared, { kept: 4, photos: true }), { from: "c8" });
  assert.equal(cutoffFrom(prepared, { kept: 12, photos: true }), null, "nothing left out, nothing to change");
  assert.ok(cutoffFrom(prepared, { kept: 12, photos: false }).photosAfter, "photos alone");
  s = { ...s, cutoffs: { [RHEA]: { from: "c8" } } };
  const next = await prepareTurn(s, RHEA);
  assert.deepEqual(next.body.messages.map((m) => m.content), ["line 8", "line 9", "line 10", "line 11"]);
  assert.equal(s.conversations[RHEA].length, 12, "the thread itself is untouched");
});

/* ------------------------------------------------------------- the nudge */

check("left on read after her question, she nudges once, a few minutes on -- not after a goodbye, not at night", () => {
  const t0 = Date.parse("2026-10-02T09:00:00Z"); // 14:30 in India
  const msg = (id, from, content, at, extra = {}) => ({ id, from, content, at: new Date(at).toISOString(), ...extra });
  const asked = [msg("u1", "user", "office me hu", t0), msg("m1", "muse", "accha", t0 + 5000), msg("m2", "muse", "lunch kiya?", t0 + 6000)];
  const at = life.nudgeAt(asked, "Asia/Kolkata");
  assert.ok(at >= t0 + 6000 + 3 * 60_000 && at < t0 + 6000 + 6 * 60_000, "three to six minutes after her last text");
  assert.equal(life.nudgeAt(asked.slice(0, 2), "Asia/Kolkata"), null, "no question, no nudge");
  assert.equal(life.nudgeAt([...asked, msg("m3", "muse", "hello??", t0 + 9e5, { nudge: true })], "Asia/Kolkata"), null, "once only");
  assert.equal(life.nudgeAt([...asked, msg("u2", "user", "haan", t0 + 9e5)], "Asia/Kolkata"), null, "they answered");
  assert.equal(life.nudgeAt([msg("u1", "user", "chal goodnight", t0), msg("m1", "muse", "so gaya?", t0 + 5000)], "Asia/Kolkata"), null, "they said they were going");
  const late = Date.parse("2026-10-02T20:00:00Z"); // 01:30 in India
  assert.equal(life.nudgeAt([msg("u1", "user", "hmm", late), msg("m1", "muse", "kya hua?", late + 5000)], "Asia/Kolkata"), null, "not in the night");
  assert.equal(life.nudgeAt([msg("m1", "muse", "kaisa hai?", t0, { proactive: { interactionId: "i" } })], "Asia/Kolkata"), null, "not after texting first");
});

/* ------------------------------------------------------- profile pictures */

check("only an invented adult is ever drawn with a face", () => {
  assert.equal(persona.portraitAllowed({ mode: "character", arch: "friend" }), true);
  assert.equal(persona.portraitAllowed({ mode: "character", arch: "partner", minor: true }), false);
  assert.equal(persona.portraitAllowed({ mode: "character", arch: "child" }), false);
  for (const mode of ["living", "memorial", "figure", "fictional", ""]) {
    assert.equal(persona.portraitAllowed({ mode, arch: "friend" }), false, mode);
  }
});

check("a picture taken away stays away; an edit can give a starter one", () => {
  let s = store.editMuse(blank(), RHEA, { avatar: { id: "avatar-1", made: true } });
  assert.deepEqual(store.findMuse(s, RHEA).avatar, { id: "avatar-1", made: true });
  s = store.editMuse(s, RHEA, { avatar: null });
  assert.equal(store.findMuse(s, RHEA).avatar, null, "null, not undefined: never drawn again on its own");
});

/* ------------------------------------------------- videos, and groups */

const { videoNote } = await import("../src/lib/solo/turn.ts");
const { filesOf, clipLength, VIDEO_ONLY } = await import("../src/lib/solo/attach.ts");

check("a video reads as one in the transcript, with its length, and says when its frames are attached", () => {
  const v = { id: "v", from: "user", content: VIDEO_ONLY, at: hoursAgo(0), video: { id: "vid-v", w: 720, h: 1280, seconds: 83, frames: ["f0", "f1"] } };
  assert.equal(clipLength(83), "1:23");
  assert.match(videoNote(v, true), /^\(sent a video, 1:23 -- the pictures with this are frames/);
  assert.equal(videoNote({ ...v, content: "dekh ye" }, false), "(sent a video, 1:23)\ndekh ye");
  assert.deepEqual(filesOf(v), ["vid-v", "f0", "f1"], "deleting it takes the frames too");
});

check("in a group, the one-to-one goes as the recent stretch word for word, and everything before it digested", () => {
  const log = Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, from: i % 2 ? "muse" : "user", content: `line ${i}`, at: new Date(NOW - (40 - i) * 60_000).toISOString() }));
  const s = { ...blank(), conversations: { [RHEA]: log } };
  assert.equal(store.recentOneToOne(s, RHEA, NOW).length, 30);
  const block = persona.oneToOneBlock(store.recentOneToOne(s, RHEA, NOW), "Piyush", "UTC", "- Piyush has a big interview on Friday.");
  assert.match(block, /over time, one to one:\n- Piyush has a big interview[\s\S]*Piyush: line 10/);
  assert.match(persona.oneToOneBlock([], "Piyush", "UTC", "- only the digest"), /only the digest/);
});

check("a burst written on separate lines arrives as separate texts, and nothing past six is dropped", () => {
  assert.deepEqual(persona.splitBurst("arre pagal\nscooter wala jhagda\nab teri baari"), ["arre pagal", "scooter wala jhagda", "ab teri baari"]);
  assert.deepEqual(persona.splitBurst("one\nstill one\n---\ntwo"), ["one\nstill one", "two"], "with ---, lines stay together");
  assert.deepEqual(persona.splitBurst("a\nb", false), ["a\nb"], "a letter is one piece");
  const eight = persona.splitBurst("1\n2\n3\n4\n5\n6\n7\n8");
  assert.equal(eight.length, 6);
  assert.equal(eight.at(-1), "6\n7\n8");
});

check("how close you are grows with talking, days and calls, and is not for someone who died or a public figure", () => {
  const msgs = (n, days) => Array.from({ length: n }, (_, i) => ({
    id: `m${i}`, from: i % 2 ? "muse" : "user", content: "hi", at: new Date(NOW - (i % days) * 864e5).toISOString(),
  }));
  assert.deepEqual(life.bondOf(blank(), RHEA, NOW, "UTC"), { level: 0, label: "Just met", progress: 0, next: { label: "Warming up", toGo: 40 } });
  const b = life.bondOf({ ...blank(), conversations: { [RHEA]: msgs(40, 3) } }, RHEA, NOW, "UTC");
  assert.equal(b.label, "Warming up", "20 of yours + 3 days = 56");
  assert.equal(b.next.toGo, 150 - 56);
  const top = life.bondOf({ ...blank(), conversations: { [RHEA]: msgs(2000, 30) } }, RHEA, NOW, "UTC");
  assert.equal(top.label, "Inseparable");
  assert.equal(top.next, null);
  assert.equal(top.progress, 1);
  for (const mode of ["memorial", "figure"]) {
    assert.equal(life.bondOf({ ...blank(), muses: [made(mode)] }, "x", NOW), null, mode);
  }
  assert.equal(life.bondOf({ ...blank(), muses: [made("living")] }, "x", NOW).label, "Comfortable", "someone living already knows you");
  const plain = { id: "p", name: "Old", description: "d", relationshipType: "friend" };
  assert.equal(life.bondOf({ ...blank(), muses: [plain] }, "p", NOW).label, "Just met", "no profile still counts");
  assert.equal(persona.bondBlock(null, "Piyush"), "");
  assert.match(persona.bondBlock(3, "Piyush"), /CLOSE[\s\S]*confide/);
});

check("what was said about someone in another chat reaches them, and nobody else", () => {
  const who = (id, name) => ({ id, name, description: "d", relationshipType: "friend", persona: { them: name, you: "Piyush", mode: "character", arch: "friend" } });
  const msg = (id, from, content, h) => ({ id, from, content, at: hoursAgo(h) });
  const s = { ...blank(), muses: [who("maya", "Maya"), who("kabir", "Kabir")],
    conversations: {
      [RHEA]: [msg("1", "user", "guess what, Maya proposed to Kabir!!", 2), msg("2", "muse", "NO WAY", 2)],
      kabir: [msg("3", "user", "kabir you there", 1)],
    },
    memories: [{ id: "x", museId: RHEA, content: "Maya proposed to Kabir at the beach", type: "EVENT", importance: 4, confidence: 1, createdAt: hoursAgo(1) }],
  };
  const kabir = store.heardForTurn(s, "kabir", NOW);
  assert.deepEqual(kabir, ['to Rhea: "guess what, Maya proposed to Kabir!!"', "Rhea remembers: Maya proposed to Kabir at the beach"]);
  assert.equal(store.heardForTurn(s, "maya", NOW).length, 2, "Maya too");
  assert.deepEqual(store.heardForTurn(s, RHEA, NOW), [], "not their own chat, and not 'kabir you there' (no Rhea in it)");
  assert.deepEqual(store.heardForTurn({ ...s, conversations: { [RHEA]: [msg("1", "user", "Mayank is here", 1)] }, memories: [] }, "maya", NOW), [], "whole names only");
  assert.match(persona.heardBlock(kabir, "Piyush"), /you were there for/);
  assert.equal(persona.heardBlock([], "Piyush"), "");
});

check("an old thing they told her comes back when the conversation picks up again", () => {
  const mem = (id, type, daysAgo) => ({ id, museId: RHEA, content: `memory ${id}`, type, importance: 3, confidence: 1, createdAt: new Date(NOW - daysAgo * 864e5).toISOString() });
  const s = { ...blank(), memories: [mem("old", "EVENT", 9), mem("new", "EVENT", 1), mem("pref", "PREFERENCE", 30)],
    conversations: { [RHEA]: [{ id: "a", from: "muse", content: "night!", at: hoursAgo(10) }, { id: "b", from: "user", content: "hey", at: hoursAgo(0) }] } };
  assert.deepEqual(store.callbackForTurn(s, RHEA, NOW), { what: "memory old", days: 9 }, "only old events and goals");
  const busy = { ...s, conversations: { [RHEA]: [{ id: "a", from: "muse", content: "haha", at: hoursAgo(1) }] } };
  assert.equal(store.callbackForTurn(busy, RHEA, NOW), null, "not in the middle of a conversation");
  assert.match(persona.callbackBlock({ what: "sister's job interview", days: 9 }, "Piyush"), /9 DAYS AGO[\s\S]*sister's job interview/);
});

check("a goodbye is recognised, and ordinary words are not", () => {
  for (const t of ["ok bye", "byeee", "good night!", "gn", "ttyl", "chal bye", "so ja raha hu", "gotta go", "see ya", "talk to you later"]) assert.ok(life.saidBye(t), t);
  for (const t of ["maybe", "gnocchi tonight?", "byte", "sonu ja raha hai market"]) assert.ok(!life.saidBye(t), t);
});

check("a secret is hinted from Comfortable, told once at Close, then shared", () => {
  const msgs = (n, days) => Array.from({ length: n }, (_, i) => ({ id: `s${i}`, from: i % 2 ? "muse" : "user", content: "hi", at: new Date(NOW - (i % days) * 864e5).toISOString() }));
  const withSecret = (n, days) => ({ ...blank(), conversations: { [RHEA]: msgs(n, days) }, lives: { [RHEA]: { arcs: [], advancedAt: hoursAgo(1), secret: "She almost moved to Berlin and never said why she stayed." } } });
  assert.equal(life.secretFor(withSecret(10, 1), RHEA, null, NOW), null, "Just met: not even a hint");
  assert.equal(life.secretFor(withSecret(300, 3), RHEA, null, NOW).stage, "hint", "Comfortable: hints");
  const close = withSecret(800, 10);
  assert.equal(life.momentDue(close, RHEA, NOW, "UTC") !== null, true);
  assert.equal(life.secretFor(close, RHEA, "secret", NOW).stage, "tell");
  const after = life.unlock(close, RHEA, "secret", NOW);
  assert.equal(life.secretFor(after, RHEA, null, NOW).stage, "told");
  assert.equal(life.secretFor({ ...blank(), conversations: { [RHEA]: msgs(800, 10) } }, RHEA, null, NOW), null, "no secret yet: nothing");
  const kept = life.applyLife(withSecret(1, 1), RHEA, { arcs: [], told: [], secret: "something else" }, NOW);
  assert.match(kept.lives[RHEA].secret, /Berlin/, "the first secret is kept");
  assert.equal(life.applyLife(blank(), RHEA, { arcs: [], told: [], secret: "  writes poems  " }, NOW).lives[RHEA].secret, "writes poems");
  assert.match(persona.secretBlock({ text: "x", stage: "hint" }, "Piyush"), /Never say what it is/);
});

check("a story pitch is three different premises from three genres, and not the same ones again", () => {
  const seen = new Set();
  for (let i = 0; i < 6; i++) {
    const p = persona.storyPitches();
    assert.equal(p.length, 3);
    assert.equal(new Set(p).size, 3);
    p.forEach((x) => seen.add(x));
  }
  assert.ok(seen.size >= 15, "six pitches drew from many premises: " + seen.size);
});

check("love stories are in a pitch only when asked for: one among three, or all three", () => {
  const loves = new Set(["stuck in a lift together, until one of you finally says the thing", "pretending to be a couple at a family function, and it starts to feel less like pretending", "sharing one umbrella in a downpour that turns into a very long walk", "a late-night drive where neither of you wants it to end", "your first date, with everything going slightly wrong and both of you loving it", "a first dance at a wedding you were both dragged to", "a rooftop night under the stars, finally admitting you have both been waiting", "a 2am confession over text that cannot be unsent", "a lazy rainy Sunday at home with nowhere to be", "a surprise weekend away planned by one of you for the other", "cooking dinner together in a tiny kitchen, getting in each other's way", "the first night in a new place you are moving into together", "going to your ex's wedding together, pretending, and then not pretending", "a long-distance couple finally meeting after months apart", "a jealousy that turns out to be the truth", "after a fight, one of you shows up at the other's door at midnight"]);
  for (let i = 0; i < 20; i++) {
    assert.equal(persona.storyPitches(3, false).filter((p) => loves.has(p)).length, 0, "never unasked");
    assert.equal(persona.storyPitches(3, true).filter((p) => loves.has(p)).length, 1, "one love story");
    const all = persona.storyPitches(3, "all");
    assert.equal(all.filter((p) => loves.has(p)).length, 3);
    assert.equal(new Set(all).size, 3);
  }
});

check("a look read from photos reaches the prompt, survives saving and editing, and is absent without one", () => {
  const draft = { them: "Aanya", you: "Piyush", relationship: "friend", arch: "friend", texture: "close", mode: "character", brief: "Warm and chaotic." };
  const withLook = persona.personaSystem({ ...draft, look: "Looks: long dark hair, oversized denim jacket. Vibe: comes across as warm and a little scruffy." }, [], false, { mood: "any", topic: "any", register: "texts" });
  assert.match(withLook, /HOW YOU LOOK, AND THE VIBE YOU GIVE OFF[\s\S]*denim jacket[\s\S]*do not mention photos/);
  assert.doesNotMatch(persona.personaSystem(draft, [], false, { mood: "any", topic: "any", register: "texts" }), /HOW YOU LOOK/);
  const m = { id: "a", name: "Aanya", description: "d", relationshipType: "friend", persona: { ...draft, look: "Looks: x" } };
  const back = store.parseState(JSON.stringify({ userName: "P", muses: [m], conversations: {}, memories: [] }));
  assert.equal(back.muses[0].persona.look, "Looks: x");
  const edited = store.editMuse({ ...blank(), muses: [m] }, "a", { brief: "New brief" });
  assert.equal(edited.muses[0].persona.look, "Looks: x", "editing them keeps the look");
});

check("clearing a chat keeps how close you are; clearing chat and memories forgets it", () => {
  const msgs = (n, days) => Array.from({ length: n }, (_, i) => ({ id: `k${i}`, from: i % 2 ? "muse" : "user", content: "hi", at: new Date(Date.now() - (i % days) * 864e5).toISOString() }));
  const s = { ...blank(), conversations: { [RHEA]: msgs(600, 20) } };
  const before = life.bondOf(s, RHEA, Date.now(), "UTC");
  assert.ok(before.level >= 3, "Close before: " + before.label);
  const cleared = store.deleteConversation(s, RHEA, false);
  assert.equal(cleared.conversations[RHEA], undefined);
  const after = life.bondOf(cleared, RHEA, Date.now(), "UTC");
  assert.equal(after.level, before.level, "the level survives a clear");
  const again = store.deleteConversation({ ...cleared, conversations: { [RHEA]: msgs(10, 2) } }, RHEA, false);
  assert.ok(again.bank[RHEA] > cleared.bank[RHEA], "a second clear adds to the bank");
  assert.equal(life.bondOf(store.deleteConversation(s, RHEA, true), RHEA, Date.now(), "UTC").level, 0, "clear chat and memories forgets it");
  assert.equal(store.parseState(JSON.stringify(cleared)).bank[RHEA], cleared.bank[RHEA], "and it is saved");
});

check("back after two days away she reacts, more the closer you are; not for a short gap, someone who died, or when she spoke last", async () => {
  const day = 864e5;
  const mk = (gapDays, n = 600) => {
    const old = Array.from({ length: n }, (_, i) => ({ id: `o${i}`, from: i % 2 ? "muse" : "user", content: "hi", at: new Date(Date.now() - (gapDays + 1 + (i % 25)) * day).toISOString() }));
    const last = { id: "back", from: "user", content: "hey", at: new Date().toISOString() };
    return { ...blank(), conversations: { [RHEA]: [...old, { id: "lastmuse", from: "muse", content: "later!", at: new Date(Date.now() - gapDays * day).toISOString() }, last] } };
  };
  const far = (await prepareTurn(mk(3), RHEA)).body;
  assert.equal(far.away.days, 3);
  assert.ok(far.away.level >= 3, "close: " + far.away.level);
  assert.equal((await prepareTurn(mk(1), RHEA)).body.away, null, "a day is not away");
  const memorial = { ...mk(5), muses: [{ id: "m", name: "Nani", description: "d", relationshipType: "grandma", persona: { them: "Nani", you: "P", mode: "memorial", arch: "grandparent" } }] };
  memorial.conversations = { m: memorial.conversations[RHEA] };
  assert.equal((await prepareTurn(memorial, "m")).body.away, null, "never for someone who died");
  const spoke = mk(4); spoke.conversations[RHEA].pop();
  assert.equal((await prepareTurn(spoke, RHEA)).body.away, null, "she spoke last: nothing to react to");
  assert.match(persona.awayBlock({ days: 3, level: 4 }, "Piyush"), /where WERE you/);
  assert.match(persona.awayBlock({ days: 3, level: 2 }, "Piyush"), /teasing sulk/);
  assert.match(persona.awayBlock({ days: 3, level: 0 }, "Piyush"), /long time/);
  assert.equal(persona.awayBlock(null, "P"), "");
});

check("a goodnight at night from someone close is a voice note; voice notes come more often the closer you are", () => {
  assert.ok(life.isNight(Date.parse("2026-10-02T18:30:00Z"), "Asia/Kolkata"), "midnight");
  assert.ok(!life.isNight(Date.parse("2026-10-02T09:00:00Z"), "Asia/Kolkata"), "2:30pm");
  const s = { ...blank(), conversations: { [RHEA]: [{ id: "u", from: "user", content: "gn", at: new Date(NOW).toISOString() }] } };
  assert.equal(store.mediaAllowed(s, RHEA, { now: NOW, roll: 0.99 }).voice, false);
  assert.equal(store.mediaAllowed(s, RHEA, { now: NOW, roll: 0.99, goodnight: true }).voice, true);
  assert.equal(store.mediaAllowed(s, RHEA, { now: NOW, roll: 0.5, level: 0 }).voice, false);
  assert.equal(store.mediaAllowed(s, RHEA, { now: NOW, roll: 0.5, level: 4 }).voice, true);
  const sent = (mins) => ({ ...s, conversations: { [RHEA]: [{ id: "v", from: "muse", content: "x", at: new Date(NOW - mins * 60_000).toISOString(), voiceNote: { id: "v", seconds: 3 } }, ...s.conversations[RHEA]] } });
  assert.equal(store.mediaAllowed(sent(90), RHEA, { now: NOW, roll: 0, level: 3 }).voice, true, "close: an hour is enough");
  assert.equal(store.mediaAllowed(sent(90), RHEA, { now: NOW, roll: 0, level: 1 }).voice, false, "not close: three hours");
  assert.match(persona.goodnightBlock(true, "Piyush"), /\[voice\]/);
  assert.equal(persona.goodnightBlock(false, "Piyush"), "");
});

check("a bad day: only for someone comfortable, not twice in four days, texted about once", () => {
  const msgs = (n) => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, from: i % 2 ? "muse" : "user", content: "hi", at: new Date(NOW - (i % 25) * 864e5).toISOString() }));
  const close = { ...blank(), conversations: { [RHEA]: msgs(600) } };
  assert.equal(life.roughWanted(close, RHEA, NOW, 0.1), true);
  assert.equal(life.roughWanted(close, RHEA, NOW, 0.9), false, "by chance");
  assert.equal(life.roughWanted(blank(), RHEA, NOW, 0.1), false, "not comfortable yet");
  const withBad = life.applyLife(close, RHEA, { arcs: [{ title: "Portfolio", beat: "The printer ate her final boards the night before.", rough: true }], told: [] }, NOW);
  assert.equal(life.roughWanted(withBad, RHEA, NOW + 864e5, 0.1), false, "not again for four days");
  assert.equal(life.roughWanted(withBad, RHEA, NOW + 5 * 864e5, 0.1), true);
  const due = life.roughDue(withBad, RHEA, NOW + 3_600_000);
  assert.match(due.text, /printer/);
  assert.equal(life.roughDue(life.markRoughTexted(withBad, RHEA, due.id), RHEA, NOW + 3_600_000), null, "once");
  assert.equal(life.roughDue(withBad, RHEA, NOW + 40 * 3_600_000), null, "no longer news after a day and a half");
  const plain = life.applyLife(close, RHEA, { arcs: [{ title: "x", beat: "A normal day.", rough: false }], told: [] }, NOW);
  assert.equal(life.roughDue(plain, RHEA, NOW), null, "an ordinary beat is not a bad day");
});

let pass = 0, fail = 0;
for (const [n, f] of results) {
  try { await f(); console.log(`  PASS  ${n}`); pass++; }
  catch (e) { console.log(`  FAIL  ${n}\n        ${e.message}`); fail++; }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
