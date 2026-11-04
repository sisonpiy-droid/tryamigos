/* Signing in: two devices and a server, and what ends up on each.
 *
 * The server only stores the newest copy and refuses a write based on an old
 * one; the devices merge. What matters is that nothing is lost, that a
 * deletion on one device is not undone by the other, and that two devices with
 * nothing new to say stop writing.
 */
import assert from "node:assert";

const { syncOnce, wire } = await import("../src/lib/solo/cloud.ts");
const { parseState } = await import("../src/lib/solo/store.ts");

const results = [];
const check = (n, f) => results.push([n, f]);

const msg = (id, from, content) => ({ id, from, content, at: new Date(Date.UTC(2026, 9, 1, 12, Number(id.replace(/\D/g, "")))).toISOString() });
const mk = (conversations, memories = []) => ({ ...parseState(null), userName: "Piyush", conversations, memories });

function server() {
  const s = { rev: 0, data: null, signedIn: true, writes: 0 };
  s.io = (device) => ({
    head: async () => (s.signedIn ? { status: "ok", rev: s.rev, email: "p@x.com" } : { status: "signed-out" }),
    pull: async () => ({ rev: s.rev, data: s.data }),
    push: async (data, baseRev) => {
      if (baseRev !== s.rev) return { ok: false, reason: "conflict" };
      s.data = data; s.rev++; s.writes++;
      return { ok: true, rev: s.rev };
    },
    loadBase: async () => device.base ?? null,
    saveBase: async (json, rev) => { device.base = { json, rev }; },
  });
  return s;
}

check("a first device pushes; a second, empty one gets everything", async () => {
  const srv = server();
  const phone = {}, laptop = {};
  const a = await syncOnce(mk({ maya: [msg("m1", "user", "hi"), msg("m2", "muse", "hello")] }), srv.io(phone));
  assert.equal(a.status, "ok");
  assert.equal(srv.rev, 1);
  const b = await syncOnce(mk({}), srv.io(laptop));
  assert.equal(b.status, "ok");
  assert.deepEqual(b.merged.conversations.maya.map((m) => m.id), ["m1", "m2"]);
  assert.equal(srv.writes, 1, "the second device only read");
});

check("both devices add messages while apart: both keep both", async () => {
  const srv = server();
  const phone = {}, laptop = {};
  let p = (await syncOnce(mk({ maya: [msg("m1", "user", "hi")] }), srv.io(phone))).merged;
  let l = (await syncOnce(mk({}), srv.io(laptop))).merged;
  p = { ...p, conversations: { maya: [...p.conversations.maya, msg("m2", "user", "from phone")] } };
  l = { ...l, conversations: { maya: [...l.conversations.maya, msg("m3", "user", "from laptop")] } };
  p = (await syncOnce(p, srv.io(phone))).merged;
  l = (await syncOnce(l, srv.io(laptop))).merged;
  p = (await syncOnce(p, srv.io(phone))).merged;
  assert.deepEqual(l.conversations.maya.map((m) => m.id).sort(), ["m1", "m2", "m3"]);
  assert.deepEqual(p.conversations.maya.map((m) => m.id).sort(), ["m1", "m2", "m3"]);
});

check("a chat cleared on one device is cleared on the other, not brought back", async () => {
  const srv = server();
  const phone = {}, laptop = {};
  let p = (await syncOnce(mk({ maya: [msg("m1", "user", "hi"), msg("m2", "muse", "yo")] }), srv.io(phone))).merged;
  let l = (await syncOnce(mk({}), srv.io(laptop))).merged;
  p = { ...p, conversations: {} };
  p = (await syncOnce(p, srv.io(phone))).merged;
  l = (await syncOnce(l, srv.io(laptop))).merged;
  assert.equal(l.conversations.maya, undefined);
});

check("two idle devices stop writing, however often they sync", async () => {
  const srv = server();
  const phone = {}, laptop = {};
  let p = (await syncOnce(mk({ maya: [msg("m1", "user", "hi")] }), srv.io(phone))).merged;
  let l = (await syncOnce(mk({}), srv.io(laptop))).merged;
  const writes = srv.writes;
  for (let i = 0; i < 4; i++) {
    p = (await syncOnce(p, srv.io(phone))).merged;
    l = (await syncOnce(l, srv.io(laptop))).merged;
  }
  assert.equal(srv.writes, writes, "no rewrites while nothing changed");
});

check("a stale write is retried against what the server now holds", async () => {
  const srv = server();
  const phone = {}, laptop = {};
  await syncOnce(mk({ maya: [msg("m1", "user", "hi")] }), srv.io(phone));
  /* the laptop reads, then the phone writes, then the laptop's write is refused once */
  const io = srv.io(laptop);
  let refused = 0;
  const racing = { ...io, push: async (d, r) => {
    if (!refused++) await syncOnce(mk({ maya: [msg("m1", "user", "hi"), msg("m2", "user", "phone got in first")] }), srv.io(phone));
    return io.push(d, r);
  } };
  const out = await syncOnce(mk({ maya: [msg("m1", "user", "hi"), msg("m3", "user", "laptop")] }), racing);
  assert.equal(out.status, "ok");
  assert.deepEqual(parseState(srv.data).conversations.maya.map((m) => m.id).sort(), ["m1", "m2", "m3"]);
});

check("signed out, or offline, nothing is touched; embeddings never leave the device", async () => {
  const srv = server(); srv.signedIn = false;
  assert.equal((await syncOnce(mk({}), srv.io({}))).status, "signed-out");
  assert.equal(srv.writes, 0);
  const withVec = mk({}, [{ id: "x", museId: "maya", content: "likes chai", type: "PREFERENCE", importance: 3, confidence: 1, createdAt: "2026-10-01T00:00:00Z", embedding: [0.1, 0.2] }]);
  assert.ok(!wire(withVec).includes("embedding"));
  assert.ok(!wire(withVec).includes('"rev"'));
});

let pass = 0, fail = 0;
for (const [n, f] of results) {
  try { await f(); console.log(`  PASS  ${n}`); pass++; }
  catch (e) { console.log(`  FAIL  ${n}\n        ${e.message}`); fail++; }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
