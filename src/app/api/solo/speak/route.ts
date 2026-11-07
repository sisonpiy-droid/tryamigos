import { soloGate } from "@/lib/authorize";
import { z } from "zod";

import { getProvider, userFacingError } from "@/lib/ai";
import { DEFAULT_VOICE, forSpeech, isVoice } from "@/lib/voice/voices";

/* One piece of a spoken reply, streamed back as raw PCM.
 *
 * Server-side because the key is (§50). A call asks for each sentence as soon
 * as the model has written it, so the user hears the first one while the rest
 * of the reply is still being generated -- this route is called several times
 * per turn, with short text each time.
 *
 * The body is little-endian 16-bit mono PCM at the rate in x-sample-rate, sent
 * as it arrives from the provider. The browser plays it through Web Audio, which
 * is what lets it start mid-stream and stop instantly when the user interrupts.
 * Nothing is stored: the transcript is the record, not the audio.
 */

export const runtime = "nodejs";
export const maxDuration = 60;

const bodySchema = z.object({
  text: z.string().trim().min(1).max(1500),
  voice: z.string().max(40).optional(),
});

export async function POST(req: Request) {
  const denied = await soloGate(3);
  if (denied) return denied;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return Response.json({ error: "There was nothing to say." }, { status: 400 });

  const text = forSpeech(parsed.data.text);
  if (!text) return new Response(null, { status: 204 });
  /* An unknown voice falls back rather than failing: a Muse saved with a voice
     a later build no longer offers should still speak. */
  const voice = isVoice(parsed.data.voice) ? parsed.data.voice : DEFAULT_VOICE;

  const provider = getProvider();
  if (!provider.speak) {
    return Response.json({ error: "Calls aren't available on this server." }, { status: 501 });
  }

  try {
    const { rate, audio } = await provider.speak(text, voice, req.signal);
    return new Response(audio, {
      headers: {
        "content-type": "application/octet-stream",
        "x-sample-rate": String(rate),
        "cache-control": "no-store",
        "x-accel-buffering": "no",
      },
    });
  } catch (err) {
    if (req.signal.aborted) return new Response(null, { status: 499 });
    console.error("speech failed", err);
    const { retryable } = userFacingError(err);
    return Response.json({ error: "I couldn't play that response.", retryable }, { status: 502 });
  }
}
