/* The voices a Muse can speak in on a call.
 *
 * Gemini's prebuilt voices are named after stars and moons -- Kore, Fenrir,
 * Callirrhoe -- which tells someone choosing one nothing. Every entry is
 * described by how it sounds, because the question being answered is "what does
 * Rhea sound like", not "which moon". Every id was checked against the live TTS
 * model before going in.
 *
 * This is the only place provider ids appear. A Muse stores a `voiceId` that
 * points in here, so changing provider means changing this file and the speak
 * route, not anyone's saved characters. Gemini detects the language from the
 * text, so no voice is tied to one -- Hinglish works in all of them.
 */

export interface Voice {
  /** The prebuilt voice name the provider expects. */
  id: string;
  /** What to call it on screen. */
  label: string;
  /** How it sounds, in the terms someone picking one would use. */
  note: string;
  /** Rough pitch, so the list can be grouped into something scannable. */
  range: "higher" | "lower";
}

export const VOICES: Voice[] = [
  { id: "Kore",         label: "Warm",      note: "even and friendly, right for most people",     range: "higher" },
  { id: "Leda",         label: "Young",     note: "lighter and quicker, early twenties",          range: "higher" },
  { id: "Aoede",        label: "Breezy",    note: "airy and unhurried, easy to listen to",        range: "higher" },
  { id: "Callirrhoe",   label: "Soft",      note: "gentle and close, for someone tender",         range: "higher" },
  { id: "Despina",      label: "Bright",    note: "upbeat and animated, talks with their hands",  range: "higher" },
  { id: "Zephyr",       label: "Clear",     note: "crisp and articulate, slightly formal",        range: "higher" },
  { id: "Vindemiatrix", label: "Gentle",    note: "quiet and measured, never raises it",          range: "higher" },
  { id: "Sulafat",      label: "Rich",      note: "fuller and warmer, a bit older",               range: "higher" },
  { id: "Gacrux",       label: "Mature",    note: "settled and grown-up, a parent or grandparent", range: "higher" },

  { id: "Puck",         label: "Playful",   note: "quick and mischievous, always half joking",    range: "lower" },
  { id: "Achird",       label: "Friendly",  note: "open and easy, the friend everyone likes",     range: "lower" },
  { id: "Zubenelgenubi", label: "Casual",   note: "laid-back, talks like he's on the sofa",       range: "lower" },
  { id: "Charon",       label: "Steady",    note: "low and unbothered, says less",                range: "lower" },
  { id: "Fenrir",       label: "Excitable", note: "fast and energetic, gets carried away",        range: "lower" },
  { id: "Enceladus",    label: "Breathy",   note: "soft-spoken and close, almost a murmur",       range: "lower" },
  { id: "Umbriel",      label: "Easy",      note: "relaxed and unhurried, nothing to prove",      range: "lower" },
  { id: "Sadaltager",   label: "Wise",      note: "knowledgeable and patient, a teacher",         range: "lower" },
  { id: "Algieba",      label: "Deep",      note: "the lowest of them, slow and deliberate",      range: "lower" },
];

export const DEFAULT_VOICE = "Kore";

export const isVoice = (id: string | undefined): id is string => !!id && VOICES.some((v) => v.id === id);

export const voiceById = (id: string | undefined): Voice =>
  VOICES.find((v) => v.id === id) ?? VOICES.find((v) => v.id === DEFAULT_VOICE)!;

/* What a reply looks like once it is going to be heard rather than read.
 *
 * The model writes for a screen even when told it is on a call: an emoji, a
 * "---" between texts, an app timestamp copied back, *asterisk actions*. Read
 * aloud those come out as "skull" or a pause with nothing in it, so they go. */
export function forSpeech(text: string): string {
  return text
    .replace(/^\s*\[[^\]\n]{0,80}\]\s*/gm, "")             // app timestamps
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")                     // **bold** is just the word
    .replace(/\*[^*\n]{1,80}\*/g, " ")                       // *laughs*
    .replace(/(^|\n)\s*-{3,}\s*(?=\n|$)/g, "$1")            // burst separators
    .replace(/\p{Extended_Pictographic}(️|‍\p{Extended_Pictographic})*/gu, " ")
    .replace(/[#_`~>]+/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

/* Splitting a reply into pieces to speak while the rest is still being written.
 *
 * The first piece goes as soon as there is a sentence, however short, because
 * that is the wait the user actually feels. After that, pieces are kept to a
 * sensible size: a TTS request per three-word sentence costs a round trip each
 * and sounds choppy, one per paragraph makes the next one late. */
const FIRST_MIN = 2;      // characters: "Haan!" is a fine first thing to hear
const NEXT_MIN = 60;
const SOFT_MAX = 220;     // past this, break at a comma rather than wait for a full stop

export function takeSpeakable(buffer: string, first: boolean): { pieces: string[]; rest: string } {
  const pieces: string[] = [];
  let rest = buffer;
  let isFirst = first;
  for (;;) {
    const min = isFirst ? FIRST_MIN : NEXT_MIN;
    const stop = /[.!?…।]+["')\]]*(\s+|$)|\n+/g;
    let cut = -1;
    let m: RegExpExecArray | null;
    while ((m = stop.exec(rest))) {
      /* A full stop at the very end might be "3." of "3.5" or "Dr." mid-name;
         only take it once something follows it. */
      if (m.index + m[0].length >= rest.length && !/\s$/.test(m[0]) && !/\n/.test(m[0])) break;
      if (m.index + m[0].length >= min) { cut = m.index + m[0].length; break; }
    }
    if (cut < 0 && rest.length > SOFT_MAX) {
      const comma = rest.lastIndexOf(", ", SOFT_MAX);
      if (comma > NEXT_MIN) cut = comma + 2;
    }
    if (cut < 0) break;
    const piece = rest.slice(0, cut).trim();
    rest = rest.slice(cut);
    if (piece) { pieces.push(piece); isFirst = false; }
  }
  return { pieces, rest };
}
