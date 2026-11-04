import { offsetOf, wallClock } from "@/lib/presence/time";

import { sseData } from "./sse";
import {
  AIProvider,
  ChatMessage,
  ExtractedMemory,
  ExtractionClock,
  GenerateOptions,
  GenerateResult,
  ProviderError,
  SearchResult,
  SpeechStream,
} from "./types";

const BASE = "https://generativelanguage.googleapis.com/v1beta";

const key = () => process.env.GEMINI_API_KEY ?? "";
const model = () => process.env.GEMINI_MODEL || "gemini-3.6-flash";
/* text-embedding-004 was retired and 404s -- the same failure mode as the old
   chat model. Ask the API what it actually serves before changing this. */
const embedModel = () => process.env.EMBEDDING_MODEL || "gemini-embedding-001";
const timeoutMs = () => Number(process.env.UPSTREAM_TIMEOUT_MS || 60000);
/* The TTS model for calls. Measured: 2.5-flash-preview-tts does not stream at
   all (one chunk after ~9s for 11s of speech); 3.8-flash-lite-tts starts in
   ~1.2s and finishes faster than it plays. */
const speechModel = () => process.env.SPEECH_MODEL || "gemini-3.8-flash-lite-tts";
/* Photos a Muse sends. Measured on the same phone-photo prompt: flash-lite-image
   ~7.5s, flash-image ~12s, and at chat size the two are hard to tell apart. */
const imageModel = () => process.env.IMAGE_MODEL || "gemini-3.1-flash-lite-image";

/* The key travels as a header, never in the query string. A key in a URL is
   written to access logs, kept by proxies, and quoted back inside error text. */
function headers() {
  if (!key()) throw new ProviderError("no_key", "GEMINI_API_KEY is not set");
  return { "content-type": "application/json", "x-goog-api-key": key() };
}


/* Gemini blocks at MEDIUM by default, and that is the wrong threshold for this
   product. A persona built from a real couple's messages carries their actual
   affection, and the reply is affection back -- ordinary between partners, and
   squarely inside what a medium threshold stops. The symptom is not an error
   but an empty response: the prompt is rejected, three attempts fail in three
   seconds, and the user is told their partner "didn't come to the phone".
   Diagnosed from exactly that.

   ONLY_HIGH, not NONE. High-confidence harmful content is still blocked; what
   changes is that a consenting adult talking to a companion they built is no
   longer caught by a setting meant for something else. */
const SAFETY_SETTINGS = [
  "HARM_CATEGORY_HARASSMENT",
  "HARM_CATEGORY_HATE_SPEECH",
  "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  "HARM_CATEGORY_DANGEROUS_CONTENT",
].map((category) => ({ category, threshold: "BLOCK_ONLY_HIGH" }));

/** Gemini calls the assistant role "model" and takes the system prompt as its
 *  own field rather than a message. */
function toGeminiBody(opts: GenerateOptions) {
  const body: Record<string, unknown> = {
    contents: opts.messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [
        { text: m.content },
        ...(m.images ?? []).map((img) => ({ inlineData: { mimeType: img.mime, data: img.data } })),
      ],
    })),
    generationConfig: {
      temperature: opts.temperature ?? 1,
      /* Omitted deliberately when no cap is asked for. Gemini 3.x spends 300-1000
         tokens reasoning before it writes, and maxOutputTokens caps thinking and
         reply together -- an 850-token budget measured out at 30 tokens of actual
         text. thinkingConfig.thinkingBudget:0 is not a workaround: 3.6-flash
         rejects it with a 400 and 3.8-flash ignores it. */
      ...(opts.maxTokens ? { maxOutputTokens: opts.maxTokens } : {}),
      ...(opts.thinking ? { thinkingConfig: { thinkingLevel: opts.thinking } } : {}),
    },
  };
  body.safetySettings = SAFETY_SETTINGS;
  if (opts.system) body.systemInstruction = { parts: [{ text: opts.system }] };
  return body;
}

/** Strips anything key-shaped before an error goes anywhere a user might see. */
function redact(text: string): string {
  let out = String(text ?? "");
  const k = key();
  if (k.length > 8) out = out.split(k).join("<redacted>");
  return out
    .replace(/AIza[A-Za-z0-9_-]{10,}/g, "<redacted>")
    .replace(/(key|api[_-]?key|token)=[^&\s"']+/gi, "$1=<redacted>");
}

function classify(status: number, detail: string): ProviderError {
  const d = redact(detail);
  if (status === 404 || /no longer available|not found|not supported/i.test(d)) {
    return new ProviderError("bad_model", `Model "${model()}" is unavailable: ${d}`, status);
  }
  if (status === 429) return new ProviderError("rate_limited", d, status);
  if (status === 401 || status === 403) return new ProviderError("no_key", d, status);
  return new ProviderError("upstream", d, status);
}

async function post(path: string, body: unknown, signal?: AbortSignal) {
  const res = await fetch(`${BASE}/${path}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(timeoutMs()),
  });
  return res;
}

/* Finish reasons that mean the reply was cut off by a filter rather than
   finished. STOP is a finished reply; anything here is a reply that ended
   because something decided it should, often mid-sentence. */
const STOPPED = new Set(["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION", "IMAGE_SAFETY"]);

function textOf(data: unknown): {
  text: string;
  finish?: string;
  blocked?: string;
  usage?: GenerateResult["usage"];
} {
  const d = data as {
    candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
    /* Set when the *input* was rejected rather than the output. Without reading
       it, a blocked prompt is indistinguishable from a model that said nothing,
       which is what made this take three rounds to find. */
    promptFeedback?: { blockReason?: string };
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  };
  const cand = d?.candidates?.[0];
  /* Deliberately NOT trimmed. A streaming delta may legitimately be " you" or
     "the " -- trimming each fragment silently welds words together, which
     showed up as "prepareyou" and "Pull upthe" on screen. Callers that want a
     whole response trim once, at the end. */
  const text = (cand?.content?.parts || []).map((p) => p.text || "").join("");
  return {
    text,
    finish: cand?.finishReason,
    blocked: d?.promptFeedback?.blockReason,
    usage: {
      inputTokens: d?.usageMetadata?.promptTokenCount,
      outputTokens: d?.usageMetadata?.candidatesTokenCount,
      thinkingTokens: d?.usageMetadata?.thoughtsTokenCount,
    },
  };
}

export const geminiProvider: AIProvider = {
  name: "gemini",

  async generateResponse(opts: GenerateOptions): Promise<GenerateResult> {
    const res = await post(`models/${encodeURIComponent(model())}:generateContent`, toGeminiBody(opts), opts.signal);
    const data = await res.json();
    if (!res.ok) throw classify(res.status, (data as { error?: { message?: string } })?.error?.message || "no detail");

    const { text: rawText, finish, blocked, usage } = textOf(data);
    const text = rawText.trim();
    if (blocked) {
      throw new ProviderError("blocked", `The request was blocked before generation (${blocked}).`);
    }
    if (!text) {
      if (finish && STOPPED.has(finish)) throw new ProviderError("stopped", `The reply was stopped by a filter (${finish}).`);
      if (finish === "MAX_TOKENS") {
        throw new ProviderError("empty", "The whole token budget went on reasoning before any reply was written.");
      }
      throw new ProviderError("empty", `Nothing came back (finishReason: ${finish ?? "unknown"}).`);
    }
    return { text, usage, model: model() };
  },

  async *streamResponse(opts: GenerateOptions): AsyncIterable<string> {
    const res = await post(
      `models/${encodeURIComponent(model())}:streamGenerateContent?alt=sse`,
      toGeminiBody(opts),
      opts.signal
    );
    if (!res.ok || !res.body) {
      let detail = `HTTP ${res.status}`;
      try {
        const d = await res.json();
        detail = (d as { error?: { message?: string } })?.error?.message || detail;
      } catch { /* keep the status */ }
      throw classify(res.status, detail);
    }

    let emitted = false;
    let blockedBy: string | undefined;
    let lastFinish: string | undefined;
    for await (const payload of sseData(res.body)) {
      try {
        const { text, blocked, finish } = textOf(JSON.parse(payload));
        if (blocked) blockedBy = blocked;
        if (finish) lastFinish = finish;
        if (text) { emitted = true; yield text; }
      } catch { /* a frame we cannot parse is not worth killing the stream for */ }
    }

    /* Naming the cause matters: a blocked prompt and a model that simply said
       nothing look identical from the outside, and are fixed differently. */
    if (blockedBy) throw new ProviderError("blocked", `The request was blocked before generation (${blockedBy}).`);

    /* Stopped partway is an error even when text already came through. This
       used to end the stream quietly, so half a sentence arrived looking like
       a finished reply and was saved as one -- the "she stops mid-message"
       that was reported. The caller holds the text back and decides. */
    if (lastFinish && STOPPED.has(lastFinish)) {
      throw new ProviderError(
        "stopped",
        emitted
          ? `The reply was stopped partway through (${lastFinish}).`
          : `The reply was stopped before it started (${lastFinish}).`
      );
    }
    if (!emitted) throw new ProviderError("empty", `The model streamed nothing back (finishReason: ${lastFinish ?? "none"}).`);
  },

  async generateEmbedding(text: string, dims?: number): Promise<number[] | null> {
    if (!key()) return null;
    const res = await post(`models/${encodeURIComponent(embedModel())}:embedContent`, {
      content: { parts: [{ text }] },
      ...(dims ? { outputDimensionality: dims } : {}),
    });
    if (!res.ok) {
      // Retrieval falls back to lexical scoring rather than failing the request:
      // a Muse that recalls slightly less well beats a Muse that errors.
      console.error("embedding failed", res.status, redact(await res.text().catch(() => "")));
      return null;
    }
    const data = (await res.json()) as { embedding?: { values?: number[] } };
    const values = data?.embedding?.values ?? null;
    if (!values || !dims) return values;

    /* Only the full-width vector comes back normalised. A truncated one does
       not, and cosine similarity on unnormalised vectors compares lengths as
       well as directions -- which is not what it is being asked. Measured at
       256 dims: raw norm 0.34, so every score would be scaled by an arbitrary
       amount that varies per memory. */
    const norm = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0));
    return norm > 0 ? values.map((v) => v / norm) : values;
  },

  async summarize(text: string, instruction?: string): Promise<string> {
    const { text: out } = await this.generateResponse({
      system:
        instruction ??
        "Summarise the conversation below in under 120 words. Keep facts about the user, " +
          "decisions, and anything they seemed to care about. Write plainly, no preamble.",
      messages: [{ role: "user", content: text }],
      // Uncapped for the same reason as extraction: the cap covers reasoning.
      temperature: 0.3,
    });
    return out;
  },

  extractMemories(transcript: ChatMessage[], existingMemories: string[], clock?: ExtractionClock): Promise<ExtractedMemory[]> {
    return extractMemoriesVia(this, transcript, existingMemories, clock);
  },

  /* Speech, streamed. Gemini sends base64 PCM inside SSE frames; this decodes
     them as they come and hands back the raw bytes, so the browser can start
     playing the first syllable while the rest of the sentence is generated.
     Deliberately no safetySettings: the text has already been through
     generation and its filters, and a second pass would make a reply that
     exists on screen and cannot be heard. */
  async speak(text: string, voice: string, signal?: AbortSignal): Promise<SpeechStream> {
    const res = await post(`models/${encodeURIComponent(speechModel())}:streamGenerateContent?alt=sse`, {
      contents: [{ role: "user", parts: [{ text }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
      },
    }, signal);
    if (!res.ok || !res.body) throw classify(res.status, (await res.text().catch(() => "")) || "no detail");

    let rate = 24000;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let first: Uint8Array | null = null;

    /* Read up to the first audio before answering, so a request that fails
       before speaking fails as an error rather than as silence. */
    const pull = async (): Promise<Uint8Array[] | null> => {
      const { done, value } = await reader.read();
      if (done) return null;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? "";
      const out: Uint8Array[] = [];
      for (const frame of frames) {
        const line = frame.split(/\r?\n/).find((l) => l.startsWith("data:"));
        if (!line) continue;
        let evt: { candidates?: { content?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] } }[]; promptFeedback?: { blockReason?: string } };
        try { evt = JSON.parse(line.slice(5).trim()); } catch { continue; }
        if (evt.promptFeedback?.blockReason) throw new ProviderError("blocked", `Speech was blocked (${evt.promptFeedback.blockReason}).`);
        for (const p of evt.candidates?.[0]?.content?.parts ?? []) {
          const d = p.inlineData;
          if (!d?.data) continue;
          rate = Number(/rate=(\d+)/.exec(d.mimeType ?? "")?.[1] ?? rate);
          out.push(Uint8Array.from(Buffer.from(d.data, "base64")));
        }
      }
      return out;
    };

    while (!first) {
      const got = await pull();
      if (got === null) throw new ProviderError("empty", "No audio came back.");
      if (got.length) {
        first = got[0];
        const queued = got.slice(1);
        return {
          rate,
          audio: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(first!);
              for (const q of queued) controller.enqueue(q);
            },
            /* Must enqueue something or close before returning: a pull that
               resolves having added nothing is never called again, and the
               stream stalls mid-sentence with nothing to say why. SSE frames
               without audio in them are common, so keep reading past them. */
            async pull(controller) {
              try {
                for (;;) {
                  const more = await pull();
                  if (more === null) { controller.close(); return; }
                  if (!more.length) continue;
                  for (const m of more) controller.enqueue(m);
                  return;
                }
              } catch (err) {
                controller.error(err);
              }
            },
            /* The user interrupting cancels this; the upstream read it abandons
               must not surface as an unhandled rejection. */
            cancel() { reader.cancel().catch(() => {}); },
          }),
        };
      }
    }
    throw new ProviderError("empty", "No audio came back.");
  },

  /* One picture, as a casual phone photo. The framing is fixed here, not left
     to the caller: whatever the description says, the result is an ordinary
     snapshot with nobody in it. */
  async picture(description: string, signal?: AbortSignal): Promise<{ mime: string; data: string }> {
    return makeImage(`A casual, unposed photo that someone just took on their phone and sent to a close friend in a chat: ${description}

Shot on a phone camera: natural, available light, slightly imperfect framing, ordinary and real -- not professional, not stylised, not an advert. Nobody in the frame: no people, no faces, no bodies, at most the edge of a hand. No text overlays, captions, watermarks or borders.`, "3:4", signal);
  },

  /* A profile picture of someone made up: an ordinary adult, as they would
     look in their own WhatsApp photo. Only ever asked for a character invented
     here (see /api/solo/avatar); a real person is never drawn. */
  async portrait(description: string, signal?: AbortSignal): Promise<{ mime: string; data: string }> {
    return makeImage(`The profile picture an ordinary person would use on WhatsApp or Instagram, of this made-up character: ${description}

A photo of one adult, at least in their twenties, head and shoulders, fully clothed, looking natural and friendly. Taken on a phone -- natural light, an everyday background, a little imperfect, not a studio or model shoot. Not a celebrity or any real, recognisable person. No text, captions, watermarks or borders.`, "1:1", signal);
  },

  /* Grounded in Google Search. What the model half-remembers about a famous
     person is the thing most likely to come out generic or out of date; a
     search is what they are actually like now, from interviews and coverage,
     and it says where it came from. */
  async searchWeb(opts: { system: string; prompt: string }): Promise<SearchResult> {
    const res = await post(`models/${encodeURIComponent(model())}:generateContent`, {
      contents: [{ role: "user", parts: [{ text: opts.prompt }] }],
      systemInstruction: { parts: [{ text: opts.system }] },
      tools: [{ google_search: {} }],
      safetySettings: SAFETY_SETTINGS,
      generationConfig: { temperature: 0.3 },
    });
    const data = await res.json();
    if (!res.ok) throw classify(res.status, (data as { error?: { message?: string } })?.error?.message || "no detail");

    const { text: raw, finish, blocked } = textOf(data);
    if (blocked) throw new ProviderError("blocked", `The request was blocked before generation (${blocked}).`);
    const text = raw.trim();
    if (!text) {
      if (finish && STOPPED.has(finish)) throw new ProviderError("stopped", `The reply was stopped by a filter (${finish}).`);
      throw new ProviderError("empty", `Nothing came back (finishReason: ${finish ?? "unknown"}).`);
    }

    type Chunk = { web?: { uri?: string; title?: string } };
    const chunks =
      (data as { candidates?: { groundingMetadata?: { groundingChunks?: Chunk[] } }[] })
        ?.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
    const seen = new Set<string>();
    const sources: SearchResult["sources"] = [];
    for (const c of chunks) {
      const w = c.web;
      if (!w?.uri || !w.title || seen.has(w.title)) continue;
      seen.add(w.title);
      sources.push({ title: w.title, url: w.uri });
      if (sources.length >= 6) break;
    }
    return { text, sources };
  },
};

/* One generated image, for picture() and portrait(): the framing is theirs,
   the request and the reading of it are the same. */
async function makeImage(prompt: string, aspectRatio: string, signal?: AbortSignal): Promise<{ mime: string; data: string }> {
  const res = await post(`models/${encodeURIComponent(imageModel())}:generateContent`, {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    safetySettings: SAFETY_SETTINGS,
    generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio } },
  }, signal);
  const data = await res.json();
  if (!res.ok) throw classify(res.status, (data as { error?: { message?: string } })?.error?.message || "no detail");
  const d = data as {
    candidates?: { content?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] }; finishReason?: string }[];
    promptFeedback?: { blockReason?: string };
  };
  if (d.promptFeedback?.blockReason) throw new ProviderError("blocked", `The picture was blocked (${d.promptFeedback.blockReason}).`);
  const img = d.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData;
  if (!img?.data) throw new ProviderError("empty", `No picture came back (finishReason: ${d.candidates?.[0]?.finishReason ?? "unknown"}).`);
  return { mime: img.mimeType || "image/png", data: img.data };
}

/* Shared by both providers: the prompt and the parsing are identical, only the
   model differs. Kept here rather than duplicated in anthropic.ts. */
export async function extractMemoriesVia(
  provider: AIProvider,
  transcript: ChatMessage[],
  existingMemories: string[],
  clock?: ExtractionClock
): Promise<ExtractedMemory[]> {
  const tz = clock?.timeZone;
  /* Each line stamped with when it was said, in their own timezone, so
     "tomorrow" can be turned into a date. */
  const stamp = (i: number) => {
    const at = clock?.at?.[i];
    const t = at ? Date.parse(at) : NaN;
    return Number.isFinite(t) ? `[${wallClock(t, tz)}] ` : "";
  };
  const convo = transcript.map((m, i) => `${stamp(i)}${m.role === "user" ? "User" : "Muse"}: ${m.content}`).join("\n");
  const timing = clock
    ? `It is now ${wallClock(clock.now, tz)} where the user is (timezone ${tz || "UTC"}, UTC${offsetOf(tz, clock.now)}). Lines are stamped with when they were said.\n\n`
    : "";
  /* Numbered, so a new fact can point at the one it replaces. */
  const known = existingMemories.length
    ? `Already known. Do not repeat these, but note their numbers -- you may need one:\n${existingMemories
        .map((m, i) => `[${i}] ${m}`)
        .join("\n")}`
    : "Nothing is known about this user yet.";

  const system = `You pull durable facts out of a conversation so a companion can remember them later.

${timing}${known}

Return ONLY a JSON array. No prose, no code fence. Each item:
{"content": string, "type": "PERMANENT"|"PREFERENCE"|"GOAL"|"RELATIONSHIP"|"EVENT"|"SHARED"|"PROMISE"|"DONE", "importance": 1-5, "confidence": 0-1, "replaces": number[], "when": string|null }

Plans, appointments and dated events -- a meeting, an exam, a trip, a deadline,
something that happened on a particular day -- are EVENTs. A plan to do
something together with the Muse (a movie night, a call, a game, "dinner"
over text) is an EVENT too: name the Muse in it, e.g. "User and the Muse plan
to watch a movie together at 21:00 on Saturday 4 October". Only name the Muse in
a plan when the Muse is part of it. For an EVENT whose
moment the conversation pins down, set "when" to that moment as ISO 8601 with the
user's UTC offset, e.g. "2026-10-02T11:00:00+05:30", working it out from when the
line was said: "tomorrow at 11" said on Wednesday night is Thursday 11:00. Write
the content with the actual day and date ("User plans to meet Rhea at 11:00 on
Thursday 2 October"), never with words like today, tonight or tomorrow, which
stop being true. If only the day is known ("a presentation on Monday"), give
that date alone, e.g. "2026-10-05" -- a day is enough to know when it is.
"when" is null only when not even the day is known. A plan
is a plan: record that it was arranged, not that it happened. If a later line
says how a plan went, or that it moved, that is a new fact which replaces the
plan.

A commitment the other side of the conversation makes -- the character saying
"I'll be there in 20 minutes", "I'll call you at 9", "give me an hour" -- is an
EVENT too: record it as "The character said they would <what> at <time>", with
"when" set to the exact moment worked out from when it was said (minutes
matter: "in 20 minutes" said at 14:02 is 14:22). Say "The character", never
"the Muse".

Two kinds of EVENT matter in particular. If the user asks to be reminded of
something, record "User asked to be reminded on <day and date> to <what>",
with "when" set to the moment they want the reminder. If the user says they
will report back ("I'll tell you tomorrow how it goes"), record "User said they
would tell the Muse how <what> went", with "when" set to when that was due.

"replaces" lists the numbers of any known facts this one makes untrue, and is
usually empty. People change jobs, move city, end relationships, stop smoking --
and the old fact does not become a second fact, it stops being true. If the user
says they quit the engineering job, the new memory replaces the one saying they
work as an engineer. Only list something the new fact actually contradicts: a
detail that merely adds to one ("their sister is called Priya" beside "their
sister is getting married") replaces nothing.

Record something only if it is durable, useful later, and about the user. A fact
stated once in passing still counts; small talk does not. Focus on the turns
marked (latest), but use the earlier ones to resolve what they refer to -- write
"their interview on Friday", not "an event on Friday", when the earlier turns
say what it is. Write each memory as a
plain third-person sentence about the user, e.g. "User's dog is called Bruno."

SHARED is the one kind that is not a fact about the user: it is something
between the two of them that has become theirs. A nickname one calls the other,
a running joke, a bit they keep doing, a phrase they have both started using, a
thing they tease each other about. Record one only when it clearly landed -- the
user laughed, played along, used it back, or it came up again -- not every joke
the Muse tried. Write what it is and where it came from, so it can be used
again: "Running joke: the Muse calls User 'chotu' since User fell asleep on a
call at 9pm." or "Shared bit: User and the Muse rate every meal out of 10 and
argue about the score." Use importance 4 for one that has clearly stuck.

PROMISE is the Muse leaving something open that it owes the user: it said it
would tell them something later ("remind me to tell you what happened with
Riya", "baad me batati hu", "wait till you hear this"), or would do something
for them later. Record what is owed, in a few words: "The Muse said it would
tell User what happened with Riya." Only when the Muse said it, in the turns
marked (latest), and only if it has not already told them in these turns.
DONE closes one: if a known PROMISE (by its number) was kept in these turns --
the Muse told the story, did the thing -- return {"content": "Kept: <what>",
"type": "DONE", "replaces": [its number]}.

Do not invent anything. Apart from SHARED and PROMISE, do not record the
Muse's own statements as facts about the user. If nothing qualifies, return [].

Intimate or sexual parts of a conversation are recorded, if at all, in general
terms -- "User and the Muse are affectionate with each other" -- never as a
description. A memory is a note, not a transcript.`;

  /* No maxTokens. Gemini 3.x spends 300-1000 tokens reasoning before it writes
     anything, and the cap covers thinking and output together -- a 900 budget
     left too little for the JSON, which then failed to parse and looked exactly
     like "there was nothing worth remembering". Silent, and wrong. */
  const { text } = await provider.generateResponse({
    system,
    messages: [{ role: "user", content: convo }],
    temperature: 0.2,
  });

  const parsed = parseMemories(text);
  if (!parsed.length && text.trim() && text.trim() !== "[]") {
    /* Distinguishes "nothing qualified" from "the model wrote something we
       could not read". Without this the two are indistinguishable in logs. */
    console.error("memory extraction produced unparseable output:", text.slice(0, 300));
  }
  return parsed;
}

/** Models wrap JSON in fences or prose often enough that this must be tolerant. */
export function parseMemories(raw: string): ExtractedMemory[] {
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const start = s.indexOf("[");
  const end = s.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(s.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const types = new Set(["PERMANENT", "PREFERENCE", "GOAL", "RELATIONSHIP", "EVENT", "SHARED", "PROMISE", "DONE"]);
  const clamp = (n: unknown, lo: number, hi: number, dflt: number) => {
    const v = Number(n);
    return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt;
  };

  return parsed
    .filter((m): m is Record<string, unknown> => !!m && typeof m === "object")
    .map((m) => ({
      content: String(m.content ?? "").trim(),
      type: (types.has(String(m.type)) ? String(m.type) : "PERMANENT") as ExtractedMemory["type"],
      importance: Math.round(clamp(m.importance, 1, 5, 3)),
      confidence: clamp(m.confidence, 0, 1, 0.7),
      /* Indexes only. Anything that is not a plain non-negative integer is
         dropped rather than guessed at -- a wrong index here would delete a
         memory the user never asked to lose, which is worse than keeping a
         stale one. */
      replaces: Array.isArray(m.replaces)
        ? m.replaces
            .map((i) => Number(i))
            .filter((i) => Number.isInteger(i) && i >= 0)
        : [],
      /* Raw here; the route resolves it against the user's timezone. */
      when: typeof m.when === "string" && m.when.trim() ? m.when.trim() : null,
    }))
    .filter((m) => m.content.length > 0 && m.content.length <= 500);
}
