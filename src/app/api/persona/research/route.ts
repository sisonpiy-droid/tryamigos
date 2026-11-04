import { z } from "zod";

import { getProvider, userFacingError } from "@/lib/ai";
import { NOT_ENOUGH } from "@/lib/presence/persona";
import { readResearch } from "@/lib/presence/research";

/* Looking someone in public life up before they are built.
 *
 * The build used to work from whatever the model remembered, with the user
 * expected to paste an interview to make it sharp. Typing "Shah Rukh Khan"
 * should be enough: he is one of the most recorded people alive. So this runs a
 * search first and hands the build a briefing -- who they are, how they come
 * across in interviews and online, what they keep coming back to -- and the
 * build writes the voice profile from that rather than from memory alone.
 *
 * "Anyone with a public life" is meant literally: a mid-sized YouTuber, a
 * regional film star, a streamer, a K-pop idol, a cricketer, someone dead for a
 * century, typed in any script and spelt however people spell them. Besides a
 * briefing, two other answers come back:
 *
 *   - "which": the name is several people ("Chris") and none is the obvious
 *     one. The screen offers the candidates rather than guessing, because a
 *     confident portrayal of the wrong Chris is worse than asking.
 *   - fictional: a character, not a person. Built from their source work and
 *     run under MODES.fictional.
 *
 * It is also the gate. A name that turns up no public figure is almost always a
 * private person, and this is not a way to build one of those from whatever the
 * internet has on them. It says so and stops.
 *
 * A separate request from the build so neither runs into the time limit, and
 * so the screen can say which of the two it is waiting on. */

export const runtime = "nodejs";
export const maxDuration = 60;

const bodySchema = z.object({
  them: z.string().trim().min(1).max(60),
  era: z.string().trim().max(120).optional(),
});

const SYSTEM = `You research a person in public life, or a fictional character, so that a companion app can portray them. Search the web. Prefer interviews, talk shows, podcasts and their own social media over listicles.

Anyone with a real public presence counts, anywhere in the world: film, TV, music, sport, YouTube, Instagram, streaming, podcasts, comedy, business, writing, history. A mid-sized creator counts as much as a global star, and so does someone long dead. The name may be misspelt, partial, a nickname, a handle, or in any script -- work out who is meant.

Reply in exactly one of four shapes.

1. A real person. Write a plain-text briefing, 250-400 words, for someone who has to play them convincingly. Start with these two lines:
KNOWN FOR: <what they are known for, in under ten words>
FULL NAME: <the name fans call them by, correctly spelt, in Latin script -- "Mortal", not "Naman Mathur"; "SRK" typed in means "Shah Rukh Khan">

Then cover, in plain prose:
- Who they are in public: their work and what they are best known for.
- How they come across when they talk: energy, humour, warmth or reserve, how they handle compliments, fans and the press.
- How they actually speak: the languages they use and mix, how they open an answer, verbal habits and phrases they are known for, pace, how long they talk.
- What they come back to in public: the subjects, stories and opinions about their work they return to.
- Up to three things they are genuinely on record as saying, marked as quotes, only if you found them.

Rules for real people:
- Public record only. Nothing about their romantic relationships, family, health, money, religion or politics beyond what is unavoidable in describing their work.
- No rumours, gossip, controversies or allegations. Nothing about their body.

2. A fictional character -- from a film, series, book, comic, anime or game. Same length, starting with these three lines:
FICTIONAL: <who they are and which work they are from, in under twelve words>
FULL NAME: <the name fans call them by -- "Tony Stark", not "Anthony Edward Stark">
AGE: <adult, or minor, as they are for most of the work>

Then cover: who they are in the story; how they talk (accent, dialect, catchphrases, verbal habits, how long they talk); their temperament and what drives them; the other characters they talk about and how they feel about them; what they would say about their world. Describe the character; do not reproduce passages from the work.

3. The name could mean several different people or characters, and none of them is clearly the one most people would mean. Do not pick one. Reply with the line WHICH: and then two to five lines, most famous first, each exactly
<full name> | <what they are known for, under eight words>
and nothing else. If one of them is plainly who almost everyone means ("Shahrukh" is Shah Rukh Khan), use shape 1 instead.

4. The name does not match anyone with a public record -- a private individual, or nobody you can find. Reply with exactly ${NOT_ENOUGH} and nothing else.`;

export async function POST(req: Request) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return Response.json({ error: "Put their name in first." }, { status: 400 });
  const { them, era } = parsed.data;

  const provider = getProvider();
  /* No search available: the build still works, from memory, as it always has. */
  if (!provider.searchWeb) return Response.json({ searched: false, research: "", knownFor: "", sources: [] });

  try {
    const { text, sources } = await provider.searchWeb({
      system: SYSTEM,
      prompt: `Research ${them}${era ? `, specifically ${era}` : ""}.`,
    });
    const found = readResearch(text);

    if (found.kind === "none") {
      return Response.json(
        {
          error: `Couldn't find ${them} in public life or in fiction. Check the spelling, or add what they're known for — "Disha Patani, actor" — so the search finds the right one.`,
          code: "not_enough",
        },
        { status: 422 }
      );
    }

    if (found.kind === "which") {
      return Response.json(
        { error: `There's more than one ${them}. Which one?`, code: "ambiguous", candidates: found.candidates },
        { status: 409 }
      );
    }

    const { research, knownFor, fullName, fictional, minor } = found;
    return Response.json({ searched: true, research, knownFor, fullName, fictional, minor, sources });
  } catch (err) {
    console.error("figure research failed", err);
    /* Not fatal: the build can still go ahead from memory. The caller decides. */
    const { message } = userFacingError(err);
    return Response.json({ error: message }, { status: 502 });
  }
}
