/* Group banter, the scrapbook, and the real world.
 *
 * Banter: characters in a group speak to each other unprompted, a little and
 * only when it is welcome. Scrapbook: what you keep survives clearing the chat
 * and merges across devices. World: the festival coming up and the weather where
 * the user is, in the user's own day and place.
 */
import assert from "node:assert";

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const banter = await import("../src/lib/solo/banter.ts");
const scrap = await import("../src/lib/solo/scrapbook.ts");
const store = await import("../src/lib/solo/store.ts");
const { mergeStates } = await import("../src/lib/solo/sync.ts");
const world = await import("../src/lib/solo/world.ts");
const persona = await import("../src/lib/presence/persona.ts");

const results = [];
const check = (n, f) => results.push([n, f]);

const NOW = Date.parse("2026-11-05T12:00:00Z");
const blank = () => ({ userName: "Piyush", muses: [], conversations: {}, memories: [], vibes: {}, circles: [], calls: [] });
const msg = (id, from, ago, extra = {}) => ({ id, from, content: `line ${id}`, at: new Date(NOW - ago * 1000).toISOString(), ...extra });

/* ------------------------------------------------------------------ banter */

const QUIET = { now: NOW, members: 3, sinceUser: 0, recent: [], typing: false, busy: false, visible: true };
const room = [msg("1", "user", 300), msg("2", "muse", 120, { speakerId: "maya" }), msg("3", "muse", 100, { speakerId: "rhea" })];

check("banter is wanted only when the group is quiet, open, and nobody is waiting on a reply", () => {
  assert.equal(banter.banterWanted(room, QUIET), true);
  assert.equal(banter.banterWanted([...room, msg("4", "user", 90)], QUIET), false, "the user spoke last: that gets a reply, not banter");
  assert.equal(banter.banterWanted([msg("2", "muse", 120, { speakerId: "maya" })], QUIET), false, "nothing to riff on yet");
  assert.equal(banter.banterWanted([...room.slice(0, 2), msg("3", "muse", 10, { speakerId: "rhea" })], QUIET), false, "not before it has been quiet");
  for (const [k, v] of [["typing", true], ["busy", true], ["visible", false], ["members", 1]]) {
    assert.equal(banter.banterWanted(room, { ...QUIET, [k]: v }), false, k);
  }
});

check("banter is a little, not a stream: two lines a quiet stretch, eight an hour", () => {
  assert.equal(banter.banterWanted(room, { ...QUIET, sinceUser: 1 }), true);
  assert.equal(banter.banterWanted(room, { ...QUIET, sinceUser: banter.MAX_PER_STRETCH }), false);
  const hour = Array.from({ length: banter.MAX_PER_HOUR }, (_, i) => NOW - (i + 1) * 60_000);
  assert.equal(banter.banterWanted(room, { ...QUIET, recent: hour }), false, "eight in the last hour");
  assert.equal(banter.banterWanted(room, { ...QUIET, recent: hour.map((t) => t - 3_600_000) }), true, "the old ones no longer count");
  const unseen = [...room, msg("9", "muse", -30, { speakerId: "maya", showAt: new Date(NOW + 30_000).toISOString() })];
  assert.equal(banter.banterWanted(unseen, QUIET), true, "a line still being typed is not shown, so does not count");
});

check("the one who speaks up is not who spoke last, and is one of the two quietest", () => {
  const people = [{ id: "maya" }, { id: "rhea" }, { id: "dev" }];
  const log = [msg("1", "muse", 300, { speakerId: "dev" }), msg("2", "muse", 200, { speakerId: "maya" }), msg("3", "muse", 100, { speakerId: "rhea" })];
  for (const r of [0, 0.3, 0.6, 0.99]) {
    const who = banter.pickBanterer(people, log, r).id;
    assert.notEqual(who, "rhea", "not the last speaker");
    assert.ok(["dev", "maya"].includes(who));
  }
  assert.equal(banter.pickBanterer(people, log, 0).id, "dev", "the quietest first");
  assert.equal(banter.pickBanterer([{ id: "rhea" }], log), null, "no one else to talk to");
  const d = [0, 0.5, 1].map((r) => banter.banterDelay(r));
  assert.deepEqual(d, [40_000, 65_000, 90_000]);
  const note = banter.banterNote("Piyush", ["Maya", "Dev"]);
  assert.match(note, /Maya, Dev/);
  assert.match(note, /do not address Piyush/);
});

/* --------------------------------------------------------------- scrapbook */

const MAYA = "builtin-maya";

check("keeping is a copy: it survives clearing the chat, and clearing chat and memories forgets it", async () => {
  const m = msg("m1", "muse", 60, { content: "okay but the chai spill is still the funniest thing ever" });
  const k = await scrap.copyForKeeping(m, NOW);
  assert.equal(k.id, "kept-m1");
  assert.equal(k.text, m.content);
  let s = scrap.addKept({ ...blank(), conversations: { [MAYA]: [m] } }, MAYA, k);
  assert.equal(scrap.isKept(s, MAYA, "m1"), true);
  assert.equal(scrap.addKept(s, MAYA, k), s, "keeping twice changes nothing");
  const cleared = store.deleteConversation(s, MAYA, false);
  assert.equal(cleared.conversations[MAYA], undefined);
  assert.deepEqual(scrap.keptOf(cleared, MAYA).map((x) => x.text), [m.content], "still there");
  assert.equal(scrap.keptOf(store.deleteConversation(s, MAYA, true), MAYA).length, 0, "forgotten with the memories");
  assert.equal(scrap.keptOf(scrap.removeKept(s, MAYA, "kept-m1"), MAYA).length, 0);
  const song = await scrap.copyForKeeping(msg("m2", "muse", 30, { content: "(sent a song: Tum Hi Ho)", song: { title: "Tum Hi Ho", artist: "Arijit Singh" } }), NOW);
  assert.deepEqual(song.song, { title: "Tum Hi Ho", artist: "Arijit Singh" });
});

check("the scrapbook gathers inside jokes, her photos and songs; a blurred photo she has not shown is left out", () => {
  const joke = (id, content, days) => ({ id, museId: MAYA, content, type: "SHARED", importance: 3, confidence: 1, createdAt: new Date(NOW - days * 864e5).toISOString() });
  const s = {
    ...blank(),
    memories: [joke("a", "Running joke: the chai spill", 9), joke("b", "Nickname: chotu", 2), { ...joke("c", "Piyush likes chai", 1), type: "PREFERENCE" }],
    conversations: { [MAYA]: [
      msg("p1", "muse", 500, { image: { id: "i1", w: 1, h: 1 } }),
      msg("p2", "muse", 400, { image: { id: "i2", w: 1, h: 1 }, veiled: true }),
      msg("p3", "user", 300, { image: { id: "i3", w: 1, h: 1 } }),
      msg("s1", "muse", 200, { song: { title: "Tum Hi Ho", artist: "Arijit Singh" } }),
    ] },
  };
  const back = scrap.lookBack(s, MAYA);
  assert.deepEqual(back.jokes.map((j) => j.id), ["b", "a"], "jokes only, newest first");
  assert.deepEqual(back.photos.map((m) => m.id), ["p1"], "hers, and not still blurred");
  assert.deepEqual(back.songs.map((m) => m.id), ["s1"]);
});

check("two devices keep different things and both are kept; removing on one removes it on the other", () => {
  const k = (id) => ({ id: `kept-${id}`, from: "muse", text: id, at: new Date(NOW).toISOString(), keptAt: new Date(NOW).toISOString() });
  const base = scrap.addKept(scrap.addKept(blank(), MAYA, k("a")), MAYA, k("b"));
  const phone = scrap.addKept(base, MAYA, k("c"));
  const laptop = scrap.removeKept(base, MAYA, "kept-a");
  const merged = mergeStates(base, phone, laptop);
  assert.deepEqual(scrap.keptOf(merged, MAYA).map((x) => x.id).sort(), ["kept-b", "kept-c"]);
  assert.deepEqual(store.parseState(JSON.stringify(merged)).scrapbook[MAYA].map((x) => x.id).sort(), ["kept-b", "kept-c"], "and it is saved");
});

check("restoring a backup brings back everything, not just chats: closeness, scrapbook, forgotten memories, place", () => {
  const backup = {
    userName: "Piyush", muses: [], conversations: { [MAYA]: [{ id: "x", from: "user", content: "hi", at: new Date(NOW).toISOString() }] }, memories: [],
    bank: { [MAYA]: 777 }, scrapbook: { [MAYA]: [{ id: "kept-1", from: "muse", text: "hi", at: new Date(NOW).toISOString(), keptAt: new Date(NOW).toISOString() }] },
    forgotten: { [MAYA]: ["user works as an engineer"] }, lives: { [MAYA]: { arcs: [], advancedAt: new Date(NOW).toISOString(), secret: "writes poems" } },
    unlocked: { [MAYA]: [{ key: "days-3", at: new Date(NOW).toISOString() }] }, place: { name: "Pune", lat: 18.5, lon: 73.8 },
  };
  const r = store.parseBackup(JSON.stringify(backup));
  assert.ok(r.ok);
  assert.equal(r.state.bank[MAYA], 777);
  assert.equal(r.state.scrapbook[MAYA].length, 1);
  assert.deepEqual(r.state.forgotten[MAYA], ["user works as an engineer"], "a deleted memory cannot come back after a restore");
  assert.equal(r.state.lives[MAYA].secret, "writes poems");
  assert.equal(r.state.unlocked[MAYA].length, 1);
  assert.equal(r.state.place.name, "Pune");
});

/* ------------------------------------------------------------------- world */

check("the festival coming up is found in the user's own day and place, and spoken of honestly", () => {
  const at = (iso) => Date.parse(iso);
  assert.deepEqual(world.festivalsNear(at("2026-11-05T06:00:00Z"), "Asia/Kolkata"), ["Dhanteras is around tomorrow", "Diwali is around 3 days away"]);
  assert.deepEqual(world.festivalsNear(at("2026-11-08T06:00:00Z"), "Asia/Kolkata"), ["Diwali is today or very nearly", "Bhai Dooj is around 3 days away"]);
  /* 01:30 on the 8th in India, still the 7th in London */
  assert.match(world.festivalsNear(at("2026-11-07T20:00:00Z"), "Asia/Kolkata")[0], /Diwali is today/);
  assert.deepEqual(world.festivalsNear(at("2026-11-07T20:00:00Z"), "Europe/London"), [], "Indian festivals are not announced to everyone");
  assert.deepEqual(world.festivalsNear(at("2026-12-20T10:00:00Z"), "America/New_York"), ["Christmas Eve is 4 days away", "Christmas is 5 days away"].slice(0, 2));
  assert.deepEqual(world.festivalsNear(at("2026-11-20T10:00:00Z"), "Asia/Kolkata"), [], "nothing for weeks");
  assert.match(world.festivalsNear(at("2026-11-09T06:00:00Z"), "Asia/Kolkata")[0], /Diwali was yesterday, more or less/);
  assert.match(world.festivalsNear(at("2026-12-26T10:00:00Z"), "America/New_York")[0], /Christmas was yesterday$/, "an exact date is not hedged");
});

check("the weather in words, cached for half an hour, and a failure means no weather rather than a stuck turn", async () => {
  assert.equal(world.describeWeather(0), "clear");
  assert.equal(world.describeWeather(63), "raining");
  assert.equal(world.describeWeather(65), "raining hard");
  assert.equal(world.describeWeather(95), "thunderstorms");
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return { ok: true, json: async () => ({ current: { temperature_2m: 28.6, weather_code: 63 } }) }; };
  const pune = { name: "Pune", lat: 18.52, lon: 73.86 };
  assert.equal(await world.weatherNow(pune, NOW), "29°C, raining");
  assert.equal(await world.weatherNow(pune, NOW + 10 * 60_000), "29°C, raining");
  assert.equal(calls, 1, "the second ask was cached");
  await world.weatherNow(pune, NOW + 31 * 60_000);
  assert.equal(calls, 2, "refreshed after half an hour");
  globalThis.fetch = async () => { throw new Error("offline"); };
  assert.equal(await world.weatherNow({ name: "Goa", lat: 15.3, lon: 74.1 }, NOW), null);
  globalThis.fetch = real;
  /* no place given: only the festival, and the network is never touched */
  globalThis.fetch = async () => { throw new Error("should not be called"); };
  assert.deepEqual(await world.worldFor(undefined, Date.parse("2026-11-05T06:00:00Z"), "Asia/Kolkata"), { festivals: ["Dhanteras is around tomorrow", "Diwali is around 3 days away"] });
  assert.equal(await world.worldFor(undefined, Date.parse("2026-11-20T06:00:00Z"), "Asia/Kolkata"), null);
  globalThis.fetch = real;
});

check("the real world reaches the prompt as something to notice when it fits, never to recite", () => {
  const block = persona.worldBlock({ place: "Pune, Maharashtra", weather: "29°C, raining", festivals: ["Diwali is around 3 days away"] }, "Piyush");
  assert.match(block, /THE REAL WORLD, RIGHT NOW/);
  assert.match(block, /Where Piyush is \(Pune, Maharashtra\), right now: 29°C, raining\./);
  assert.match(block, /Diwali is around 3 days away\./);
  assert.match(block, /only when it fits/);
  assert.match(block, /Never claim to be in the same place as Piyush/);
  assert.match(block, /a weather report is not/);
  assert.equal(persona.worldBlock(null, "P"), "");
  assert.equal(persona.worldBlock({ festivals: [] }, "P"), "");
  assert.doesNotMatch(persona.worldBlock({ festivals: ["Holi is 2 days away"] }, "Piyush"), /Where Piyush is/);
});

let pass = 0, fail = 0;
for (const [n, f] of results) {
  try { await f(); console.log(`  PASS  ${n}`); pass++; }
  catch (e) { console.log(`  FAIL  ${n}\n        ${e.message}`); fail++; }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
