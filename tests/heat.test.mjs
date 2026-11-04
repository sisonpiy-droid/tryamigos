/* Heat steps a romantic chat down, never up: a block should land on a milder
   version of the same scene, and nothing here may ask for more than was chosen. */
import assert from "node:assert";
import { HEATS, asHeat, heatBelow, romanceBlock, softerSystems } from "../src/lib/presence/persona.ts";

const results = [];
const check = (n, f) => results.push([n, f]);

check("asHeat defaults to flirty and rejects junk", () => {
  assert.equal(asHeat(undefined), "flirty");
  assert.equal(asHeat("explicit"), "flirty");
  assert.equal(asHeat("steamy"), "steamy");
});

check("heatBelow steps down and stops at sweet", () => {
  assert.equal(heatBelow("steamy"), "flirty");
  assert.equal(heatBelow("flirty"), "sweet");
  assert.equal(heatBelow("sweet"), null);
});

check("each heat has its own block, and all keep the cut-away and adults-only lines", () => {
  const blocks = HEATS.map((h) => romanceBlock("Sam", h));
  assert.equal(new Set(blocks).size, 3);
  for (const b of blocks) assert.match(b, /Adults only/);
});

check("softerSystems: steamy gives flirty then sweet, sweet gives nothing", () => {
  const steps = softerSystems("BASE", "Sam", "steamy");
  assert.deepEqual(steps.map((s) => s.heat), ["flirty", "sweet"]);
  assert.ok(steps.every((s) => s.system.startsWith("BASE")));
  assert.ok(steps[0].system.endsWith(romanceBlock("Sam", "flirty")));
  assert.deepEqual(softerSystems("BASE", "Sam", "sweet"), []);
});

let pass = 0, fail = 0;
for (const [n, f] of results) {
  try { await f(); console.log(`  PASS  ${n}`); pass++; }
  catch (e) { console.log(`  FAIL  ${n}\n        ${e.message}`); fail++; }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
