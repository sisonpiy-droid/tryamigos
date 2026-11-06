import { soloGate } from "@/lib/authorize";
import { z } from "zod";

import { getProvider } from "@/lib/ai";

/* What a character and the user have talked about over time, in a few lines.
 *
 * For groups: the recent end of someone's one-to-one chat goes into a group as
 * it was said, but everything before it used to arrive only as a handful of
 * distilled facts. This is the rest of it -- the running story of the two of
 * them -- folded into the previous digest as the chat grows, and kept on the
 * device. Stateless here.
 */

export const runtime = "nodejs";
export const maxDuration = 60;

const bodySchema = z.object({
  name: z.string().trim().min(1).max(60),
  you: z.string().trim().max(80).default("them"),
  /** The digest so far, to fold the new stretch into. */
  previous: z.string().max(2000).default(""),
  messages: z
    .array(z.object({ from: z.enum(["user", "muse"]), content: z.string().max(600), at: z.string().max(40).optional() }))
    .min(1)
    .max(150),
});

export async function POST(req: Request) {
  const denied = await soloGate();
  if (denied) return denied;

  let raw: unknown;
  try { raw = await req.json(); } catch { return Response.json({ error: "Invalid request." }, { status: 400 }); }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return Response.json({ error: "Invalid request." }, { status: 400 });
  const { name, you, previous, messages } = parsed.data;

  const transcript = messages
    .map((m) => `${m.at ? `[${m.at.slice(0, 10)}] ` : ""}${m.from === "user" ? you : name}: ${m.content}`)
    .join("\n");
  const system = `You keep ${name}'s memory of their one-to-one conversations with ${you}, so that ${name} can walk into a group chat still knowing what the two of them have been through.

${previous ? `What ${name} already had down:\n${previous}\n\nFold the conversation below into it.` : "Write it from the conversation below."}

Write at most ten short lines, each starting with "- ", from ${name}'s side: what ${you} has been dealing with, what they told ${name}, plans the two of them made, running jokes, how things are between them, anything ${you} asked ${name} to keep quiet. Newest and most important first; drop what has stopped mattering. Plain facts from the conversation only -- nothing invented. Intimate or sexual parts in general terms only. No preamble.`;

  try {
    const { text } = await getProvider().generateResponse({
      system,
      messages: [{ role: "user", content: transcript }],
      temperature: 0.2,
      thinking: "low",
    });
    const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("- ")).slice(0, 10);
    return Response.json({ digest: lines.join("\n").slice(0, 2000) });
  } catch (err) {
    console.error("digest failed", err);
    return Response.json({ digest: null });
  }
}
