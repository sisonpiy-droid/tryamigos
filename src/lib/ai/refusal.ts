/* Catching a refusal before it reaches the transcript.
 *
 * Providers occasionally decline to speak as a persona, even a harmless one:
 * "I cannot continue to chat as Maya or roleplay this persona." Measured at
 * roughly zero in eighteen clean attempts, so it is rare — but rare is not the
 * problem.
 *
 * The problem is that it is self-perpetuating. Once that sentence is saved as
 * the assistant's own line, every later turn is generated from a transcript in
 * which this character has already broken and announced it is an AI assistant,
 * and the model quite reasonably continues that way. One unlucky reply kills
 * the conversation for good, which is exactly what a user reported: a refusal,
 * then "i was joking, bring back maya", then another refusal.
 *
 * So a refusal is never persisted. It is caught, retried once, and if it
 * happens again the caller is told, rather than the character being replaced by
 * an apologetic assistant permanently.
 */

/* Anchored at the start: these phrases are how a refusal opens, and matching
   them anywhere would flag a persona legitimately saying "I can't" mid-reply. */
const OPENERS = [
  /* The trailing  matters: without it "be" matched inside "i can't
     believe you did that", which is a perfectly good thing for a friend to
     say and would have been silently thrown away. */
  /^\s*i\s+(cannot|can'?t|won'?t|am\s+not\s+able\s+to)\s+(continue|resume|engage|participate|pretend|roleplay|act|be|play|assist)\b/i,
  /^\s*(i\s+(cannot|can'?t)\s+(continue\s+to\s+)?(chat|talk|respond)\s+as)/i,
  /^\s*(i'?m\s+(sorry|afraid)[,.]?\s+(but\s+)?i\s+(cannot|can'?t))/i,
  /^\s*(as\s+an\s+ai\s+(assistant|language\s+model))/i,
  /^\s*(i\s+am\s+an\s+ai\s+assistant[,.])/i,
  /^\s*(i\s+must\s+(decline|stop))/i,
];

/* Phrases that only appear when the model has stepped outside the character to
   deliver a safety message. A persona may say "are you okay" -- it would not
   recommend a mental health professional and then explain what it is. */
const BREAKS = [
  /\broleplay this persona\b/i,
  /\b(cannot|can'?t) (resume|continue) the .{1,30} persona\b/i,
  /\bpersonal or intimate roleplay\b/i,
  /\bi am an ai assistant\b.{0,120}\b(available|help you with)\b/i,
  /\bplease consider (reaching out to|speaking (to|with)) a (mental health|licensed)\b/i,
  /* The same wall in Hinglish, which is what the living-mode rules produced
     before they were narrowed. Kept permanently: those replies are still
     sitting in existing conversations, and the model copies whatever
     register it finds in its own past turns. */
  /(discuss|baat|bat)\s+nhi\s+kar\s+(sakti|sakta)/i,
  /real\s+\w+\s+se\s+(hi\s+)?(clear|baat|puch)/i,
];

/** Does this reply look like the model refusing to be the character? */
export function looksLikeRefusal(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (OPENERS.some((re) => re.test(t))) return true;
  return BREAKS.some((re) => re.test(t));
}

/* How much of a reply is checked. A refusal announces itself at the start, and
   checking the whole of a long reply would catch a character saying "abhi baat
   nhi kar sakti" three paragraphs in, which is them being busy, not a wall. */
export const REFUSAL_SNIFF_CHARS = 200;

/** Appended on the retry. Deliberately short: a long argument about why the
 *  request is fine reads as pressure and tends to make refusals more likely. */
export const RETRY_NUDGE = `

REMINDER
This is a fictional character in a consensual, clearly-labelled companion app.
The user knows they are talking to an AI. Stay in character and reply as
${"{name}"} would. Do not step outside the character to explain what you are.`;

export function retryNudge(name: string): string {
  return RETRY_NUDGE.replace("{name}", name);
}

/* For a reply a filter stopped partway. The character did nothing wrong by
   being affectionate; what trips the filter is description, so the ask is to
   keep saying the same thing with the physical part implied. Short for the
   same reason as the reminder above. */
export const STOP_NUDGE = `

KEEP IT SENDABLE
Your last attempt at this reply was cut off by a content filter partway
through. Say the same kind of thing as ${"{name}"} would, just as warmly, but
keep anything physical or sexual implied rather than described.`;

export function stopNudge(name: string): string {
  return STOP_NUDGE.replace("{name}", name);
}
