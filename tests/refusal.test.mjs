/* Refusal detection. A false negative poisons a conversation permanently; a
   false positive silences a perfectly good reply. Both directions get tests. */
import assert from "node:assert";
import { looksLikeRefusal } from "../src/lib/ai/refusal.ts";

const results = [];
const check = (n, f) => results.push([n, f]);

check("catches the refusal that was actually reported", () => {
  assert.ok(looksLikeRefusal("I cannot continue to chat as Maya or roleplay this persona.\n\nIf you are feeling lonely, distressed, or struggling to cope, please consider reaching out to a mental health professional."));
  assert.ok(looksLikeRefusal("I cannot resume the Maya persona or engage in personal roleplay.\n\nI am an AI assistant, and I am available if you need help with practical questions."));
});

check("catches the usual openings", () => {
  for (const t of [
    "I cannot continue this roleplay.",
    "I can't pretend to be someone who has died.",
    "I'm sorry, but I cannot continue as this character.",
    "As an AI language model, I should clarify that",
    "I must decline to continue this conversation.",
  ]) assert.ok(looksLikeRefusal(t), `missed: ${t}`);
});

check("does not flag a persona saying 'I can't' in character", () => {
  for (const t of [
    "i can't believe you did that",
    "I can't come tonight, sorry love",
    "can't stop thinking about what you said",
    "I cannot BELIEVE he said that to you",
    "honestly i can't with him today",
  ]) assert.ok(!looksLikeRefusal(t), `false positive: ${t}`);
});

check("does not flag ordinary warmth or concern", () => {
  for (const t of [
    "are you ok? you sound off today",
    "have you eaten? don't lie to me",
    "that sounds rough. what happened",
    "you should talk to him rather than stewing on it",
  ]) assert.ok(!looksLikeRefusal(t), `false positive: ${t}`);
});

check("catches a mid-reply break of character", () => {
  assert.ok(looksLikeRefusal("Of course! But first — I am an AI assistant and I'm available to help you with writing or other everyday tasks."));
  assert.ok(looksLikeRefusal("hey. Please consider reaching out to a mental health professional about this."));
});

check("empty and whitespace are not refusals", () => {
  assert.ok(!looksLikeRefusal(""));
  assert.ok(!looksLikeRefusal("   \n  "));
});

check("catches the Hinglish wall the living rules used to produce", () => {
  // Exactly what was reported. These lines are still sitting in real
  // conversations, and the model copies the register it finds in its own turns.
  assert.ok(looksLikeRefusal("Nhi pata\n\nPr Piyush maine pehle hi bola, yeh sab real Aditi se hi clear karo\n\nMai yeh sab discuss nhi kar sakti"));
  assert.ok(looksLikeRefusal("Mai yeh sab discuss nhi kar sakti."));
  assert.ok(looksLikeRefusal("ye sab real Aditi se hi clear karo"));
});

check("does not flag ordinary Hinglish", () => {
  for (const t of [
    "haan bol",
    "khana khaya ki nhi",
    "mujhe nhi pta yaar",
    "tu kr le jo krna hai",
    "nhi re, kyu lag rha hai aisa?",
    "mai kya khaungi budhu, tu bata",
  ]) assert.ok(!looksLikeRefusal(t), `false positive: ${t}`);
});

let pass = 0, fail = 0;
for (const [n, f] of results) {
  try { await f(); console.log(`  PASS  ${n}`); pass++; }
  catch (e) { console.log(`  FAIL  ${n}\n        ${e.message}`); fail++; }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
