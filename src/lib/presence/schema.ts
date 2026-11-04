import { z } from "zod";

/* The shape of a character, as every route that talks as one accepts it.
 *
 * Chat, group chat and proactive texts each kept their own copy of this list,
 * and a field added to one (a photo-derived look, say) was silently stripped by
 * the others -- so the same character behaved differently depending on which
 * door the message came through. One list, used by all three. A route only
 * chooses its own default for `mode`.
 *
 * Keep this in step with PersonaDraft (presence/persona.ts); a test fails if a
 * field of one is missing from the other. */
export const personaFields = {
  them: z.string().max(60),
  you: z.string().max(60),
  relationship: z.string().max(120).default(""),
  callsYou: z.string().max(60).optional(),
  arch: z.string().max(30).default("other"),
  texture: z.string().max(30).default("close"),
  samples: z.string().max(14000).optional(),
  extra: z.string().max(4000).optional(),
  metrics: z.string().max(4000).optional(),
  brief: z.string().max(6000).optional(),
  /* Whether samples are attested, or lines written in their register. */
  verbatim: z.boolean().optional(),
  interests: z.string().optional().transform((s) => s?.slice(0, 400)),
  minor: z.boolean().optional(),
  traits: z.array(z.string().max(30)).max(8).optional(),
  /** How they look and the vibe, read from photos the user gave. */
  look: z.string().max(1200).optional(),
  /** "male" | "female" | "nonbinary": theirs, and the user's. */
  gender: z.string().max(20).optional(),
  youGender: z.string().max(20).optional(),
};

export const personaSchema = (mode: string) => z.object({ ...personaFields, mode: z.string().max(30).default(mode) });

/* Their standing state: separate from this conversation's mood, it persists. */
export const feelingsSchema = z.object({
  mood: z.string().max(20).default("any"),
  warmth: z.string().max(20).default("normal"),
  note: z.string().max(600).default(""),
});
