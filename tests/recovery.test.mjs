/* Recovery codes: how a forgotten password is reset without email. */
import assert from "node:assert";

const { makeRecoveryCode, normaliseCode, hashRecoveryCode, checkRecoveryCode, CODE_LENGTH } = await import("../src/lib/recovery.ts");

const results = [];
const check = (n, f) => results.push([n, f]);

check("a code is twelve characters in groups of four, from an alphabet with no look-alikes, and never repeats", () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const c = makeRecoveryCode();
    assert.match(c, /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
    assert.equal(c.replace(/-/g, "").length, CODE_LENGTH);
    seen.add(c);
  }
  assert.equal(seen.size, 200);
});

check("what someone types is forgiven: case, spaces and dashes; nothing else", () => {
  assert.equal(normaliseCode("k7f2-9qxm-4tbd"), "K7F29QXM4TBD");
  assert.equal(normaliseCode(" K7F2 9QXM 4TBD "), "K7F29QXM4TBD");
  assert.equal(normaliseCode("K7F29QXM4TB"), null, "too short");
  assert.equal(normaliseCode("K7F29QXM4TBDX"), null, "too long");
  assert.equal(normaliseCode("K7F2-9QXM-4TB0"), null, "0 is not in the alphabet");
  assert.equal(normaliseCode(""), null);
});

check("the right code opens it however it is typed; a wrong one, an old hash or no hash does not", async () => {
  const code = makeRecoveryCode();
  const hash = await hashRecoveryCode(code);
  assert.notEqual(hash, code, "only a hash is kept");
  assert.equal(await checkRecoveryCode(code, hash), true);
  assert.equal(await checkRecoveryCode(code.toLowerCase().replace(/-/g, " "), hash), true);
  assert.equal(await checkRecoveryCode(makeRecoveryCode(), hash), false);
  assert.equal(await checkRecoveryCode("nonsense", hash), false);
  assert.equal(await checkRecoveryCode(code, null), false, "an account with no code cannot be reset");
});

let pass = 0, fail = 0;
for (const [n, f] of results) {
  try { await f(); console.log(`  PASS  ${n}`); pass++; }
  catch (e) { console.log(`  FAIL  ${n}\n        ${e.message}`); fail++; }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
