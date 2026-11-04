"use client";

/* Building a persona from a real chat export.
 *
 * This is the backbone: describing how someone writes is nearly impossible in
 * words, but it is trivially measurable from their messages. Median message
 * length, whether they start lowercase, whether they send four in a row instead
 * of one — nobody can tell you these about themselves, and they are most of what
 * makes a voice recognisable.
 *
 * Everything here runs in the browser. The export is never uploaded: only a
 * sampled excerpt and the measured statistics are sent on to build the persona,
 * which keeps the rest of a private conversation — usually including a second
 * person who never agreed to any of this — on the device.
 *
 * Ported from the Presence prototype, where it was the part that worked.
 */

export interface ChatMessage {
  who: string;
  at: number;
  text: string;
}

export interface Participant {
  name: string;
  count: number;
  chars: number;
  first: number;
  last: number;
}

export interface ParsedChat {
  messages: ChatMessage[];
  participants: Participant[];
  /** Lines that looked like messages but could not be read. Surfaced rather
   *  than swallowed: a format this parser has not seen should be visible. */
  unreadable: number;
}

/* ---------------------------------------------------------------- unzip */

/** Reads the largest .txt out of a zip using only the browser's own
 *  DecompressionStream, so importing costs no dependency. */
export async function unzipLargestTxt(buf: ArrayBuffer): Promise<string> {
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);

  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 66000); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("That doesn't look like a zip file.");

  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const found: string[] = [];

  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    if (!/\.txt$/i.test(name) || /__MACOSX/.test(name)) continue;

    const lnameLen = dv.getUint16(lho + 26, true);
    const lextraLen = dv.getUint16(lho + 28, true);
    const start = lho + 30 + lnameLen + lextraLen;
    const data = u8.subarray(start, start + compSize);

    if (method === 0) {
      found.push(new TextDecoder().decode(data));
    } else if (method === 8) {
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      found.push(await new Response(stream).text());
    }
  }

  if (!found.length) throw new Error("No chat file inside that zip. Export again and choose 'Without media'.");
  return found.sort((a, b) => b.length - a.length)[0];
}

/* ---------------------------------------------------------------- parse */

/* WhatsApp's line format varies by locale and platform: brackets or not,
   12- or 24-hour, day-first or month-first. */
const LINE_RE =
  /^‎?\[?(\d{1,4}[/.\-]\d{1,2}[/.\-]\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?)\s*([APap]\.?[Mm]\.?)?\]?\s*(?:[-–]\s*)?([^:\n]{1,60}?):\s?([\s\S]*)$/;

/* Attachment placeholders, in whatever language the phone was set to.
 *
 * This list used to be English only, so an export from a phone set to Hindi,
 * Spanish or Portuguese counted every photo, voice note and sticker as a real
 * message. In a chat with any photos in it that is a large share of the total,
 * and it lands in the measured statistics -- median message length, "starts
 * lowercase", the distinctive-words list -- which are then handed to the model
 * as "counts, not impressions. Match them."
 *
 * Android wraps its placeholder in angle brackets in every locale, so that is
 * the general rule and needs no translations. iOS writes a localised phrase
 * instead, so those are listed for the languages this is most likely to meet.
 */
const BRACKETED = /^‎?<[^>]{1,80}>$/;

const NOISE_RE =
  new RegExp(
    "^(‎)?(" +
      [
        "image omitted", "video omitted", "audio omitted", "sticker omitted",
        "GIF omitted", "document omitted", "Contact card omitted",
        "This message was deleted", "You deleted this message",
        "missed voice call", "missed video call", "null",
        "छवि छोड़ी गई",
        "वीडियो छोड़ा गया",
        "ऑडियो छोड़ा गया",
        "स्टिकर छोड़ा गया",
        "इस संदेश को मिटा दिया गया",
        "imagen omitida", "video omitido", "audio omitido", "sticker omitido",
        "Se eliminó este mensaje", "imagem ocultada", "áudio ocultado",
        "Esta mensagem foi apagada", "image absente", "vidéo absente",
        "Ce message a été supprimé", "Bild weggelassen",
        "Diese Nachricht wurde gelöscht", "gambar tidak disertakan",
        "Pesan ini telah dihapus",
      ].join("|") +
      ")$",
    "i"
  );

/** Is this message an attachment placeholder rather than something said? */
const isNoise = (text: string) => BRACKETED.test(text) || NOISE_RE.test(text);

const SYSTEM_RE =
  /(end-to-end encrypted|created group|added you|changed the subject|changed this group|joined using this group|changed their phone number|security code changed|You're now an admin|messages and calls are)/i;

/* "X left" is a system line, and /left$/ against every line also matched any
   wrapped line of a real message ending in that word -- "go left", "there was
   nothing left" -- and deleted it. No bound on length or word count separates
   those from "Piyush Kapoor left", because nothing about the text does.
   
   What separates them is the timestamp. A leave notice is its own line and
   carries one; a line that wrapped off the message above it never does. So this
   is only ever applied to timestamped lines, below. */
const LEAVE_RE = /\bleft$/i;

/* A line that begins like a message header but did not parse.
 *
 * These fell through to the continuation branch and were glued onto the end of
 * the previous person's message, so one unrecognised timestamp variant both
 * corrupted the message before it and attributed its words to the wrong person.
 * Skipped and counted instead, so a format this parser has not seen is visible
 * rather than quietly folded into someone's voice. */
const HEADER_ISH = /^‎?\[?\s*\d{1,4}[/.\-]\d{1,2}[/.\-]\d{2,4}[,\s]/;

function stampOf(dateStr: string, timeStr: string, ampm?: string): number {
  const [a, b, rawYear] = dateStr.split(/[/.\-]/).map(Number);
  let year = rawYear;
  if (year < 100) year += year > 70 ? 1900 : 2000;

  // Day-first and month-first exports are indistinguishable below 13, so the
  // ambiguous case falls back to day-first. It only shifts a timestamp, never
  // the ordering of messages, which is what the sampling actually relies on.
  let day: number, month: number;
  if (a > 12) { day = a; month = b; }
  else if (b > 12) { month = a; day = b; }
  else { day = a; month = b; }

  const [hh, mm] = timeStr.split(":").map(Number);
  const h = ampm ? (hh % 12) + (/p/i.test(ampm) ? 12 : 0) : hh;
  const t = new Date(year, month - 1, day, h, mm || 0).getTime();
  return Number.isFinite(t) ? t : 0;
}

export function parseExport(raw: string): ParsedChat {
  const lines = raw.replace(/\r/g, "").split("\n");
  const msgs: ChatMessage[] = [];
  let unreadable = 0;

  for (const line of lines) {
    const m = line.match(LINE_RE);
    if (m) {
      msgs.push({ who: m[4].trim(), at: stampOf(m[1], m[2], m[3]), text: (m[5] || "").trim() });
    } else if (HEADER_ISH.test(line)) {
      /* Timestamped, but no "Name:" in it. Either a system notice, or a message
         in a format this parser does not know. The second kind is worth
         counting: appending it would corrupt the message above and put its
         words in someone else's mouth, and silently dropping it would hide that
         the export was only partly understood. */
      if (!SYSTEM_RE.test(line) && !LEAVE_RE.test(line.trim())) unreadable++;
    } else if (msgs.length && line.trim() && !SYSTEM_RE.test(line)) {
      // A message that wrapped onto its own line belongs to the one before it.
      msgs[msgs.length - 1].text += "\n" + line.trim();
    }
  }

  const messages = msgs.filter((m) => m.text && !isNoise(m.text.trim()));

  const tally = new Map<string, Participant>();
  for (const m of messages) {
    const e = tally.get(m.who) ?? { name: m.who, count: 0, chars: 0, first: Infinity, last: 0 };
    e.count++;
    e.chars += m.text.length;
    if (m.at) { e.first = Math.min(e.first, m.at); e.last = Math.max(e.last, m.at); }
    tally.set(m.who, e);
  }

  return {
    messages,
    participants: [...tally.values()].sort((a, b) => b.count - a.count),
    unreadable,
  };
}

/* ---------------------------------------------------------------- measure */

const STOP = new Set(
  ("the a an and or but if so of to in on at for with is are was were be been am i you he she it we they " +
   "me my your his her our their this that not no yes do does did have has had will would can could just " +
   "get got go going about all any as by from how more most now out over some than then there when what " +
   "who why up down u ur im its it's dont don't").split(" ")
);

export interface StyleReport {
  text: string;
  n: number;
  first: number;
  last: number;
}

/* Reading a transcript rather than a chat export.
 *
 * For a public figure there is no export, and the whole build rests on what
 * replaces it. The honest answer is a real interview: something they actually
 * said, in their own words, at length.
 *
 * The measurement machinery does not care where messages came from -- styleOf
 * and sampleWindows take ChatMessage[] and nothing else -- so a transcript
 * parsed into that shape gets measured exactly like an export does, and the
 * metrics block stays a measurement instead of becoming an impression. That is
 * the single thing separating a portrayal that sounds like them from one that
 * sounds like what a model thinks a famous person sounds like.
 *
 * Three shapes turn up, and all three are handled:
 *   NAME: text            transcripts, magazine Q&As, subtitle dumps
 *   NAME                  a speaker on their own line, words underneath
 *   text with no labels   auto-captions of someone talking, which is one
 *                         speaker by definition
 */

/** A label followed by a colon: "SRK:", "Shah Rukh Khan:", "INTERVIEWER:". */
const SPEAKER_RE = /^\s*([^:\n]{1,40}?)\s*:\s*(.*)$/;

/** A label alone on its own line, words beneath it. Deliberately strict --
 *  short, no sentence punctuation -- so a real line of speech is not mistaken
 *  for a name. */
const BARE_LABEL_RE = /^\s*([\p{Lu}][\p{L}.'\- ]{0,38})\s*$/u;

/* Timing lines and cue numbers from subtitle files.
   
   Matched by what they are made of rather than by shape: SRT writes
   "00:00:04,120 --> 00:00:07,400" and WebVTT writes a full stop instead of the
   comma, and a regex built around one of those silently lets the other through
   -- where SPEAKER_RE then reads "00" as the speaker and the rest as something
   they said. A line with no letters in it is not speech. */
const TIMECODE_RE = /^[\d:,.\-> \[\]]+$/;

export function parseTranscript(raw: string, fallbackName: string): ParsedChat {
  const lines = raw.replace(/\r/g, "").split("\n");
  const msgs: ChatMessage[] = [];
  let pending: string | null = null;

  for (const line of lines) {
    const text = line.trim();
    if (!text || TIMECODE_RE.test(text)) continue;

    const labelled = text.match(SPEAKER_RE);
    if (labelled && labelled[2].trim()) {
      msgs.push({ who: labelled[1].trim(), at: 0, text: labelled[2].trim() });
      pending = null;
      continue;
    }

    const bare = text.match(BARE_LABEL_RE);
    if (bare && !/[.!?,]$/.test(text)) {
      pending = bare[1].trim();
      continue;
    }

    if (pending) {
      msgs.push({ who: pending, at: 0, text });
      continue;
    }

    /* An unlabelled line belongs to whoever was speaking, not to the person
       being built -- otherwise a wrapped sentence in an interview invents a
       second participant with the subject's name and measures half their words
       as somebody else's.
       
       It continues the message above while that message is unfinished, and
       starts a new one once it has ended. That matters most for auto-captions,
       which arrive as arbitrary fragments with no labels at all: grouping them
       into sentences is what makes "typical message length" mean anything. */
    const last = msgs[msgs.length - 1];
    if (last && !/[.!?]$/.test(last.text)) {
      last.text += " " + text;
    } else {
      msgs.push({ who: last ? last.who : fallbackName, at: 0, text });
    }
  }

  const messages = msgs.filter((m) => m.text && !isNoise(m.text));

  const tally = new Map<string, Participant>();
  for (const m of messages) {
    const e = tally.get(m.who) ?? { name: m.who, count: 0, chars: 0, first: Infinity, last: 0 };
    e.count++;
    e.chars += m.text.length;
    tally.set(m.who, e);
  }

  return {
    messages,
    /* By characters, not by count. An interviewer asks many short questions and
       the person answering says far more -- ranking by count would put the
       interviewer first in almost every transcript. */
    participants: [...tally.values()].sort((a, b) => b.chars - a.chars),
    unreadable: 0,
  };
}

/** Measures how one participant writes, as instructions a model can follow. */
export function styleOf(messages: ChatMessage[], name: string): StyleReport {
  const mine = messages.filter((m) => m.who === name);
  const theirs = messages.filter((m) => m.who !== name);
  if (!mine.length) return { text: "", n: 0, first: 0, last: 0 };

  const lens = mine.map((m) => m.text.length).sort((a, b) => a - b);
  const median = lens[Math.floor(lens.length / 2)];
  const pct = (n: number) => Math.round((n / mine.length) * 100);

  const lower = pct(mine.filter((m) => /^[a-z]/.test(m.text)).length);
  const endPunct = pct(mine.filter((m) => /[.!?]$/.test(m.text.trim())).length);
  const noComma = pct(mine.filter((m) => m.text.length > 25 && !m.text.includes(",")).length);
  const exclaim = pct(mine.filter((m) => m.text.includes("!")).length);
  const qs = pct(mine.filter((m) => m.text.includes("?")).length);

  const emoji: Record<string, number> = {};
  for (const m of mine) {
    for (const e of m.text.match(/\p{Extended_Pictographic}/gu) ?? []) emoji[e] = (emoji[e] ?? 0) + 1;
  }
  const topEmoji = Object.entries(emoji).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const emojiPct = pct(mine.filter((m) => /\p{Extended_Pictographic}/u.test(m.text)).length);

  // Sending several short messages instead of one long one is one of the most
  // recognisable habits a person has, and one nobody would think to describe.
  let bursts = 0;
  for (let i = 1; i < messages.length; i++) {
    const a = messages[i - 1], b = messages[i];
    if (b.who === name && a.who === name && b.at && a.at && b.at - a.at < 90000) bursts++;
  }
  const burstPct = pct(bursts);

  const sign = mine.filter((m) => {
    const last = m.text.trim().split("\n").pop()!.trim().replace(/[.!]$/, "");
    return last.length < 20 && last.toLowerCase() === name.toLowerCase().split(" ")[0];
  }).length;

  const freq = (arr: ChatMessage[]) => {
    const f: Record<string, number> = {};
    for (const m of arr) {
      for (const w of m.text.toLowerCase().match(/[a-z']{2,}/g) ?? []) if (!STOP.has(w)) f[w] = (f[w] ?? 0) + 1;
    }
    return f;
  };
  const fa = freq(mine), fb = freq(theirs);
  const na = Object.values(fa).reduce((s, x) => s + x, 0) || 1;
  const nb = Object.values(fb).reduce((s, x) => s + x, 0) || 1;
  /* Words relative to the *other* person, not to English at large. That is what
     isolates the vocabulary belonging to them rather than to the friendship. */
  const distinctive = Object.entries(fa)
    .filter(([, c]) => c >= 4)
    .map(([w, c]) => [w, (c / na) / ((fb[w] ?? 0) / nb + 1 / nb)] as [string, number])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([w]) => w);

  const openers: Record<string, number> = {};
  for (const m of mine) {
    const first = m.text.toLowerCase().split(/\s+/).slice(0, 2).join(" ").replace(/[^a-z' ]/g, "").trim();
    if (first.length > 2) openers[first] = (openers[first] ?? 0) + 1;
  }
  const topOpeners = Object.entries(openers)
    .sort((a, b) => b[1] - a[1]).slice(0, 5).filter(([, c]) => c > 2).map(([w]) => w);

  /* Percentages from a handful of messages are noise wearing a number.
   *
   * These go into the prompt under "these are counts, not impressions. Match
   * them", so a participant with nine messages produced "Starts a message
   * lowercase: 100% of the time" and the model obeyed it exactly. That happens
   * easily: pick the wrong speaker in a group export, or build from a chat
   * where the other person barely wrote. Below a usable sample the honest thing
   * is to say the sample is small and let the brief lean on the messages
   * themselves. */
  if (mine.length < 25) {
    return {
      text: `Messages measured: ${mine.length}. That is too few to measure habits from, so there are no statistics here — go by the sample messages themselves and do not infer rules from how few there are.`,
      n: mine.length,
      first: 0,
      last: 0,
    };
  }

  const text = [
    `Messages measured: ${mine.length}`,
    `Typical message length: ${median} characters. ${median < 30 ? "Very short. Do not write paragraphs." : median < 80 ? "Short." : "Longer than average."}`,
    `Starts a message lowercase: ${lower}% of the time.`,
    `Ends with a full stop, question mark or exclamation: ${endPunct}%.`,
    noComma > 50 ? `Rarely uses commas even in longer messages (${noComma}% without).` : null,
    `Uses "!": ${exclaim}% of messages. Asks a question: ${qs}%.`,
    emojiPct > 2
      ? `Emoji in ${emojiPct}% of messages${topEmoji.length ? `, most often ${topEmoji.map(([e, c]) => `${e} (${c})`).join(" ")}` : ""}.`
      : "Almost never uses emoji.",
    `Sends back-to-back messages rather than one long one: ${burstPct}% follow their own previous message within 90 seconds.${burstPct > 25 ? " This is a strong habit — split replies often." : ""}`,
    sign > 3 ? `Signs off with their own name at the end of ${pct(sign)}% of messages.` : null,
    topOpeners.length ? `Common openings: ${topOpeners.map((o) => `"${o}"`).join(", ")}.` : null,
    distinctive.length ? `Words they use far more than the other person: ${distinctive.join(", ")}.` : null,
  ].filter(Boolean).join("\n");

  let first = Infinity, last = 0;
  for (const m of mine) {
    if (!m.at) continue;
    first = Math.min(first, m.at);
    last = Math.max(last, m.at);
  }

  return { text, n: mine.length, first: Number.isFinite(first) ? first : 0, last };
}

/** Excerpts spread across the whole history rather than the most recent chunk,
 *  each keeping the surrounding turns so replies have something to reply to. */
export function sampleWindows(messages: ChatMessage[], name: string, budget = 11000): string {
  const idx = messages.map((m, i) => (m.who === name ? i : -1)).filter((i) => i >= 0);
  if (!idx.length) return "";

  const WINDOWS = 34, SPAN = 7;
  const picks: [number, number][] = [];
  for (let w = 0; w < WINDOWS; w++) {
    const anchor = idx[Math.floor((w / WINDOWS) * idx.length)];
    picks.push([Math.max(0, anchor - SPAN), Math.min(messages.length, anchor + SPAN + 1)]);
  }

  const merged: [number, number][] = [];
  for (const [s, e] of picks.sort((a, b) => a[0] - b[0])) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }

  /* Fill up to the budget rather than stopping at the first window that will
     not fit whole. In a dense chat the windows overlap and merge into a single
     block far larger than the budget, and breaking on it returned an empty
     sample -- so a persona would be built from statistics alone, with none of
     their actual words, and nothing would say so. */
  const out: string[] = [];
  let used = 0;
  for (const [s, e] of merged) {
    if (used >= budget) break;
    const lines: string[] = [];
    for (let i = s; i < e; i++) {
      const line = `${messages[i].who}: ${messages[i].text}`;
      if (used + line.length + 1 > budget) break;
      lines.push(line);
      used += line.length + 1;
    }
    if (lines.length) out.push(lines.join("\n"));
  }
  return out.join("\n\n···\n\n");
}

/** What a file looked like when nothing could be read from it.
 *
 *  WhatsApp's export format varies by platform, locale and version, and this
 *  parser will not have seen every one. When it fails the useful thing is not
 *  "that didn't work" but a sample of the line it could not read, so the format
 *  can be identified. Shown only on the user's own screen; nothing is sent. */
export class UnreadableExport extends Error {
  constructor(readonly sampleLine: string, readonly lineCount: number) {
    super(
      lineCount === 0
        ? "That file is empty."
        : `Read ${lineCount.toLocaleString()} lines but couldn't recognise any messages in them.`
    );
    this.name = "UnreadableExport";
  }
}

/** Reads a .txt or .zip export. */
export async function readExportFile(file: File): Promise<ParsedChat> {
  const isZip = /\.zip$/i.test(file.name) || file.type === "application/zip";
  const raw = isZip ? await unzipLargestTxt(await file.arrayBuffer()) : await file.text();
  return parseText(raw);
}

/** Parses already-read text, so a format this parser cannot open as a file can
 *  still be pasted in. */
export function parseText(raw: string): ParsedChat {
  const parsed = parseExport(raw);
  if (!parsed.participants.length) {
    const lines = raw.split(/\r?\n/).filter((l) => l.trim());
    throw new UnreadableExport((lines[0] ?? "").slice(0, 120), lines.length);
  }
  return parsed;
}
