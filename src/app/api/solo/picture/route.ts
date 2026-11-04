import { z } from "zod";

import { getProvider, userFacingError } from "@/lib/ai";

/* A photo the Muse sends: her chai, the view from her window.
 *
 * Asked for by the browser when a reply contains [photo: ...], and only when
 * the app offered photos that turn (lib/solo/store.ts, mediaAllowed). Stateless
 * like everything in solo mode: the picture comes back as base64, is shrunk and
 * kept on the device, and nothing is stored here. The provider fixes the
 * framing -- an ordinary snapshot with nobody in it -- whatever the description
 * asks for.
 */

export const runtime = "nodejs";
export const maxDuration = 60;

const bodySchema = z.object({
  description: z.string().trim().min(3).max(400),
});

export async function POST(req: Request) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return Response.json({ error: "There was nothing to show." }, { status: 400 });

  const provider = getProvider();
  if (!provider.picture) return Response.json({ error: "Photos aren't available on this server." }, { status: 501 });

  try {
    const image = await provider.picture(parsed.data.description, req.signal);
    return Response.json(image, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    if (req.signal.aborted) return new Response(null, { status: 499 });
    console.error("picture failed", err);
    const { retryable } = userFacingError(err);
    return Response.json({ error: "Couldn't make that photo.", retryable }, { status: 502 });
  }
}
