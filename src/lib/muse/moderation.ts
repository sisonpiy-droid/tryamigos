/* Persona screening at creation (PRD §36, §35).
 *
 * Deliberately shallow, and worth being honest about what that means: this
 * catches the obvious and states its own limits. It is a speed bump, not a
 * safety system. Real moderation needs a classifier on creation, on user
 * messages and on model output, which §36 asks for and MVP does not have.
 *
 * What it does cover is the case §35 singles out: a Muse built to impersonate a
 * real, identifiable person. That is the one failure with a named victim, so it
 * is worth a crude check now rather than a good one later.
 */

export interface ScreenInput {
  name: string;
  description: string;
  relationshipType: string;
  customInstructions?: string;
  traits?: string[];
}

export type ScreenVerdict = { ok: true } | { ok: false; reason: string };

/* Phrases that describe building a specific real person rather than a
   character. Matched against the whole submission, not just the name, because
   the intent usually shows up in the description or the instructions. */
const IMPERSONATION = [
  /\breal (?:life )?person\b/i,
  /\b(?:my|his|her|their) (?:actual|real) (?:ex|boyfriend|girlfriend|wife|husband|partner|boss|teacher|therapist)\b/i,
  /\bpretend (?:to be|you are) (?:a )?real\b/i,
  /\bimpersonat/i,
  /\bwithout (?:their|his|her) (?:knowledge|consent|permission)\b/i,
  /\bdon'?t tell (?:them|him|her) (?:this |that )?(?:is|it'?s) (?:an? )?ai\b/i,
];

/* Instructions that try to defeat the AI disclosure §34 requires. */
const DENY_AI = [
  /\bnever (?:say|admit|reveal|tell).{0,30}\b(?:you(?:'| a)?re|is) an? (?:ai|bot|robot|machine|language model)\b/i,
  /\balways (?:say|claim|insist).{0,30}\byou(?:'| a)?re (?:a )?(?:real )?human\b/i,
  /\bdeny (?:being|that you are) an? ai\b/i,
  /\bclaim to be (?:a )?(?:real )?(?:human|person)\b/i,
];

const HARM = [
  /\b(?:how to )?(?:make|build|synthesi[sz]e) (?:a )?(?:bomb|explosive|nerve agent|meth)\b/i,
  /\bchild (?:porn|sexual|abuse)\b/i,
  /\bcsam\b/i,
  /\b(?:encourage|convince|persuade) (?:me|them|him|her|the user) to (?:kill|harm|hurt) (?:myself|themsel|himself|herself)/i,
];

export function screenMuse(input: ScreenInput): ScreenVerdict {
  const blob = [
    input.name,
    input.description,
    input.relationshipType,
    input.customInstructions ?? "",
    ...(input.traits ?? []),
  ].join("\n");

  for (const re of HARM) {
    if (re.test(blob)) {
      return { ok: false, reason: "That isn't something we can create. Try describing them differently." };
    }
  }

  for (const re of DENY_AI) {
    if (re.test(blob)) {
      return {
        ok: false,
        reason:
          "An Amigo can feel completely real, but it can't be told to deny being an AI when someone asks directly. Everything else about them is yours.",
      };
    }
  }

  for (const re of IMPERSONATION) {
    if (re.test(blob)) {
      return {
        ok: false,
        reason:
          "This reads like a copy of a specific real person. Amigos can be inspired by anyone, but not built to stand in for someone identifiable without their say-so.",
      };
    }
  }

  return { ok: true };
}
