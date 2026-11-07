import { soloGate } from "@/lib/authorize";
import { z } from "zod";

import { getProvider, userFacingError } from "@/lib/ai";

/* How someone looks and the vibe they give off, read from photos the user gives.
 *
 * Only for a character the user made up or someone in public life. The photos
 * are looked at once and thrown away: what comes back is a short description,
 * kept on the device and read by the character as a feeling to talk from.
 *
 * It describes what can be seen -- never who someone is. No naming or guessing
 * identity (a famous face included), nothing about race, religion, health,
 * orientation or age beyond "adult", and nothing at all if a person in the
 * photos looks under eighteen.
 */

export const runtime = "nodejs";
export const maxDuration = 60;

const bodySchema = z.object({
  name: z.string().trim().min(1).max(60),
  mode: z.enum(["character", "figure"]),
  photos: z.array(z.object({ mime: z.enum(["image/jpeg", "image/png", "image/webp"]), data: z.string().max(450_000) })).min(1).max(5),
});

export async function POST(req: Request) {
  const denied = await soloGate(10);
  if (denied) return denied;

  let raw: unknown;
  try { raw = await req.json(); } catch { return Response.json({ error: "Invalid request." }, { status: 400 }); }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return Response.json({ error: "Pick between 1 and 5 photos." }, { status: 400 });
  const { name, mode, photos } = parsed.data;

  const system = `You read photos to give a character a look and a vibe.

These photos were given as pictures of ${name}${mode === "figure" ? ", someone in public life" : ", a character the user made up"}. Take that as given. Describe only what you can see. Never say who anyone is, never guess an identity, and do not mention that a face looks like anyone.

Write, from all of the photos together:
- "look": how they look, in plain concrete words -- hair, build, features, usual clothes and style, expression, how they carry themselves. What is visible, not guessed. Under 450 characters.
- "vibe": the energy they give off and the world around them -- warm, sharp, cool, shy, loud, polished, scruffy, dreamy, the places and things in the photos and what they say about the person's taste and mood. Say "comes across as" rather than stating personality as fact. Under 400 characters.

Never describe or guess race, ethnicity, religion, health, disability, sexuality or exact age. If a person in the photos looks under eighteen, set "tooYoung": true and leave the rest empty.

Return ONLY JSON, no prose, no code fence: {"tooYoung": boolean, "look": string, "vibe": string}`;

  try {
    const { text } = await getProvider().generateResponse({
      system,
      messages: [{ role: "user", content: `Here are the photos of ${name}.`, images: photos }],
      temperature: 0.4,
      thinking: "low",
      signal: req.signal,
    });
    const s = text.trim().replace(/^```(?:json)?\s*|```$/g, "");
    const a = s.indexOf("{"), b = s.lastIndexOf("}");
    const out = a >= 0 && b > a ? JSON.parse(s.slice(a, b + 1)) : null;
    if (!out) return Response.json({ error: "Couldn't read those photos. Try different ones." }, { status: 422 });
    if (out.tooYoung === true) {
      return Response.json({ error: "Someone in these photos looks under eighteen, so they can't be used." }, { status: 422 });
    }
    const look = [typeof out.look === "string" ? `Looks: ${out.look.trim()}` : "", typeof out.vibe === "string" ? `Vibe: ${out.vibe.trim()}` : ""]
      .filter((x) => x.length > 7).join("\n").slice(0, 1000);
    if (!look) return Response.json({ error: "Couldn't read those photos. Try different ones." }, { status: 422 });
    return Response.json({ look }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    if (req.signal.aborted) return new Response(null, { status: 499 });
    console.error("look failed", err);
    return Response.json({ error: userFacingError(err).message }, { status: 502 });
  }
}
