import { soloGate } from "@/lib/authorize";
import { z } from "zod";

import { getProvider } from "@/lib/ai";
import { DEFAULT_VOICE, VOICES, isVoice } from "@/lib/voice/voices";

/* Choosing a voice for a Muse the first time they are called.
 *
 * Done from their whole profile rather than from their name, because a name is
 * not evidence of anything. The profile usually is: a relationship ("older
 * sister", "uncle"), how they are described, and -- for anyone who writes in
 * Hindi or Hinglish -- the gendered verb endings in their sample lines ("main
 * aa rahi hoon"). Where none of that says, the choice is made on personality,
 * and the user can change it in Edit with one tap either way.
 *
 * Once chosen it is saved on the Muse, so this runs once per character. */

export const runtime = "nodejs";
export const maxDuration = 30;

const bodySchema = z.object({
  name: z.string().max(60),
  relationship: z.string().max(120).default(""),
  description: z.string().max(400).default(""),
  brief: z.string().max(6000).default(""),
  samples: z.string().max(4000).default(""),
  gender: z.string().max(20).optional(),
});

export async function POST(req: Request) {
  const denied = await soloGate(3);
  if (denied) return denied;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return Response.json({ voiceId: DEFAULT_VOICE });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return Response.json({ voiceId: DEFAULT_VOICE });
  const p = parsed.data;

  const catalogue = VOICES.map((v) => `${v.id}: ${v.label} -- ${v.note} (${v.range} voice)`).join("\n");
  try {
    const { text } = await getProvider().generateResponse({
      system: `You choose the speaking voice for a character in a companion app, from this list:
${catalogue}

Decide from evidence in the profile: the relationship, how they are described,
pronouns, and in Hindi or Hinglish the gendered verb forms in their own lines
("rahi hoon", "gayi thi" against "raha hoon", "gaya tha"). Do not decide from
the name alone. Then match the voice to their age and personality. If nothing
in the profile says whether a higher or lower voice fits, choose on personality.

Reply with the voice id only.`,
      messages: [{
        role: "user",
        content: [
          `Name: ${p.name}`,
          p.gender && `Gender (said by the user, so trust it over anything inferred): ${p.gender}`,
          p.relationship && `Relationship to the user: ${p.relationship}`,
          p.description && `Described as: ${p.description}`,
          p.brief && `Profile:\n${p.brief.slice(0, 3000)}`,
          p.samples && `Their own lines:\n${p.samples.slice(0, 1500)}`,
        ].filter(Boolean).join("\n\n"),
      }],
      temperature: 0.2,
    });
    const id = (text || "").trim().replace(/[^A-Za-z]/g, "");
    const match = VOICES.find((v) => v.id.toLowerCase() === id.toLowerCase())?.id;
    return Response.json({ voiceId: isVoice(match) ? match : DEFAULT_VOICE });
  } catch (err) {
    console.error("voice pick failed", err);
    return Response.json({ voiceId: DEFAULT_VOICE });
  }
}
