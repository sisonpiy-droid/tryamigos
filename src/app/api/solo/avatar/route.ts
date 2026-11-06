import { soloGate } from "@/lib/authorize";
import { z } from "zod";

import { getProvider, userFacingError } from "@/lib/ai";
import { portraitAllowed } from "@/lib/presence/persona";

/* A character's profile picture.
 *
 * Which kind is decided here, from who they are, not by the caller:
 *   - someone made up here, an adult: a portrait, as their own WhatsApp photo;
 *   - anyone else -- a portrait of a real person (built from their messages, in
 *     public life, or someone who died), a character from a story, anyone
 *     under eighteen: the kind of profile picture many people use instead of
 *     their face. A flower, a view, a pet, a thing they love. Nobody's face is
 *     ever made up for a real person, a story's character, or a child.
 *
 * Stateless: the picture comes back as base64 and is kept on the device.
 */

export const runtime = "nodejs";
export const maxDuration = 60;

const bodySchema = z.object({
  name: z.string().trim().min(1).max(60),
  mode: z.string().max(30),
  arch: z.string().max(30).default("other"),
  minor: z.boolean().optional(),
  /** Who they are, in a few lines: relationship, brief, traits. */
  about: z.string().max(1200).default(""),
});

export async function POST(req: Request) {
  const denied = await soloGate();
  if (denied) return denied;

  let raw: unknown;
  try { raw = await req.json(); } catch { return Response.json({ error: "Invalid request." }, { status: 400 }); }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return Response.json({ error: "Invalid request." }, { status: 400 });
  const { name, about } = parsed.data;

  const provider = getProvider();
  const face = portraitAllowed(parsed.data);
  if (face ? !provider.portrait : !provider.picture) {
    return Response.json({ error: "Pictures aren't available on this server." }, { status: 501 });
  }

  try {
    const image = face
      ? await provider.portrait!(`${name}. ${about}`.slice(0, 1300), req.signal)
      : await provider.picture!(
          `the profile picture ${name} would choose for themselves -- not a photo of them or of anyone, but the kind of thing many people use instead: a flower, a sunset, a view from somewhere they love, their pet, a cup of chai, an object that says something about them. Pick one that suits who they are: ${about}`.slice(0, 1300),
          req.signal
        );
    return Response.json({ ...image, kind: face ? "portrait" : "picture" }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    if (req.signal.aborted) return new Response(null, { status: 499 });
    console.error("avatar failed", err);
    const { retryable } = userFacingError(err);
    return Response.json({ error: "Couldn't make a picture.", retryable }, { status: 502 });
  }
}
