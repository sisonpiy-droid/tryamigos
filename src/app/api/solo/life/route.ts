import { soloGate } from "@/lib/authorize";
import { z } from "zod";

import { getProvider } from "@/lib/ai";
import { wallClock } from "@/lib/presence/time";

/* The next day of a character's own life.
 *
 * Asked by the browser about once a day per character (lib/solo/life.ts).
 * Given who they are and the storylines they have going, it moves each one on
 * by a step, ends one now and then, and starts a new one when there are fewer
 * than two -- and says which of the latest steps the character has already told
 * the user, from what they said since. Stateless: nothing is kept here.
 *
 * Only for characters someone made up. A portrait of a real person is never
 * sent here, and the route refuses one if it is.
 */

export const runtime = "nodejs";
export const maxDuration = 60;

const bodySchema = z.object({
  persona: z.object({
    them: z.string().max(60),
    you: z.string().max(60),
    relationship: z.string().max(120).default(""),
    mode: z.string().max(30),
    brief: z.string().max(6000).optional(),
    extra: z.string().max(4000).optional(),
    interests: z.string().optional().transform((s) => s?.slice(0, 400)),
    minor: z.boolean().optional(),
  }).passthrough(),
  userName: z.string().max(80).nullish(),
  timezone: z.string().max(64).nullish(),
  /** Days since the last step; 0 for the first. */
  days: z.number().int().min(0).max(14),
  arcs: z.array(z.object({
    id: z.string().max(80),
    title: z.string().max(80),
    beats: z.array(z.object({ id: z.string().max(80), text: z.string().max(300) })).max(3),
  })).max(3),
  /** What they have said to the user since the last step, to tell what has been told. */
  said: z.array(z.string().max(400)).max(30).default([]),
  /** They have no secret yet: invent one. */
  needSecret: z.boolean().default(false),
  /** Make one of the new steps a bad day for them. */
  rough: z.boolean().default(false),
});

export async function POST(req: Request) {
  const denied = await soloGate();
  if (denied) return denied;

  let raw: unknown;
  try { raw = await req.json(); } catch { return Response.json({ error: "Invalid request." }, { status: 400 }); }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return Response.json({ error: "Invalid request." }, { status: 400 });
  const { persona: p, userName, timezone, days, arcs, said, needSecret, rough } = parsed.data;
  if (p.mode !== "character") return Response.json({ arcs: [], told: [] });
  const you = userName?.trim() || p.you || "them";

  const going = arcs.length
    ? arcs.map((a) => `- id ${a.id}: ${a.title}\n${a.beats.map((b) => `    [${b.id}] ${b.text}`).join("\n")}`).join("\n")
    : "(none yet)";

  const system = `You keep the life of a fictional character going between their conversations, the way a novelist keeps track of a side character.

THE CHARACTER
${p.them}, who is ${you}'s ${p.relationship || "friend"}.
${(p.brief ?? "").trim()}
${(p.extra ?? "").trim()}
${p.interests ? `Interests: ${p.interests}` : ""}

It is now ${wallClock(Date.now(), timezone ?? undefined)} where they are. ${days ? `${days} day${days === 1 ? "" : "s"} have passed since these storylines last moved.` : "These are their first storylines."}

THEIR STORYLINES SO FAR
${going}

THE CONVERSATION WITH ${you.toUpperCase()} SINCE
${said.length ? said.map((s) => `- ${s}`).join("\n") : "(nothing)"}

If ${you} gave advice about one of these storylines ("just confront her", "apply anyway"), the character took it: that storyline's next step is what happened when they did -- good, bad or funny, but a real result.

Move their life on:
- Each storyline above gets one new step: what happened next, one or two plain sentences written as a note about them ("Riya still isn't talking to her; she left a passive-aggressive note on the fridge."). If a storyline has run its course, give it a last step and mark it done.
- If fewer than two storylines are left going, start one new one (three at most).
- Storylines are the stuff of an ordinary life for exactly this person: work or college, a flatmate or sibling, a friend's drama, a hobby, a small goal, money, a crush, a plan, something funny or annoying. Specific, with names and small details, a mix of mundane and juicy -- things a friend would actually want to hear about.
- Nothing grim: no deaths, serious illness, accidents, abuse, crime or disasters.
- They are the centre of it. ${you} is never in these storylines and nothing happens to ${you}.
- Keep everything consistent with who they are and what has happened so far.${p.minor ? "\n- They are under eighteen: storylines fit someone that age, and none are romantic." : ""}

Also say which of the steps listed above (by their [id]) the character has now told ${you}, judging only from her own lines since.

${needSecret ? `
Also invent one secret they keep: something personal they have never told ${you}, the kind a friend tells you only once they really trust you -- a dream they gave up, a hidden talent, why they really left somewhere, something they are secretly proud or ashamed of${p.minor ? "" : ", a crush they never admitted"}. Specific and in keeping with who they are. Nothing grim (no abuse, crime, illness or death) and nothing about ${you}. One sentence, written as a note about them.
` : ""}${rough ? `
This time, one storyline's new step is a bad day for them: something went wrong today -- an embarrassing moment, a disappointment, a stressful deadline, a falling-out with a friend, a plan that collapsed -- the kind of day they would want to vent about to someone they trust. Nothing grim (no death, illness, accident, abuse or crime) and nothing about ${you}. Set that arc's "rough" to true.
` : ""}
Return ONLY JSON, no prose, no code fence:
{"arcs": [{"id": string|null (null for a new storyline), "title": string (a few words), "beat": string, "done": boolean${rough ? ', "rough": boolean' : ""}}], "told": [string]${needSecret ? ', "secret": string' : ""}}`;

  try {
    const { text } = await getProvider().generateResponse({
      system,
      messages: [{ role: "user", content: "(Move their life on.)" }],
      temperature: 0.9,
      thinking: "low",
    });
    const s = text.trim().replace(/^```(?:json)?\s*|```$/g, "");
    const a = s.indexOf("{"), b = s.lastIndexOf("}");
    const out = a >= 0 && b > a ? JSON.parse(s.slice(a, b + 1)) : null;
    const known = new Set(arcs.map((x) => x.id));
    const beatIds = new Set(arcs.flatMap((x) => x.beats.map((y) => y.id)));
    const steps = (Array.isArray(out?.arcs) ? out.arcs : [])
      .filter((x: unknown): x is Record<string, unknown> => !!x && typeof x === "object")
      .map((x: Record<string, unknown>) => ({
        id: typeof x.id === "string" && known.has(x.id) ? x.id : undefined,
        title: String(x.title ?? "").slice(0, 80),
        beat: typeof x.beat === "string" ? x.beat.slice(0, 300) : null,
        done: x.done === true,
        rough: rough && x.rough === true,
      }))
      .slice(0, 4);
    const told = (Array.isArray(out?.told) ? out.told : []).map(String).filter((x: string) => beatIds.has(x));
    const secret = needSecret && typeof out?.secret === "string" ? out.secret.trim().slice(0, 300) : null;
    return Response.json({ arcs: steps, told, secret }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    console.error("life step failed", err);
    return Response.json({ arcs: [], told: [] });
  }
}
