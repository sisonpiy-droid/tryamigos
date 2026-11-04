/* The provider boundary (PRD §32).
 *
 * Nothing above this file may know which model answered. That matters for
 * more than tidiness: Presence, the prototype this grew out of, hard-coded a
 * model ID that Google later retired, and the failure surfaced as a generic
 * "unavailable" three layers up. Providers here normalise their own errors
 * into ProviderError so the caller can say something true about each one.
 */

export type Role = "user" | "assistant";

export interface ChatMessage {
  role: Role;
  content: string;
  /** Photos sent with the message, base64. Only providers that can see use them. */
  images?: { mime: string; data: string }[];
}

export interface GenerateOptions {
  system?: string;
  messages: ChatMessage[];
  /** Omit to let the model finish. See the note in gemini.ts on thinking tokens. */
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  /* How much the model reasons before it answers. "minimal" for a voice call,
     where a spoken reply is a sentence or two and every second of thinking is
     a second of silence on the line: measured, it halves the wait for the first
     word (~3.2s to ~1.4s). Omitted, the provider default -- text chat keeps it. */
  thinking?: "minimal" | "low";
}

export interface GenerateResult {
  text: string;
  /** Server-side only. §8 forbids surfacing model names or token counts. */
  usage?: { inputTokens?: number; outputTokens?: number; thinkingTokens?: number };
  model: string;
}

export type ProviderErrorCode =
  | "no_key"
  | "bad_model"
  | "rate_limited"
  | "timeout"
  /* The prompt itself was refused before anything was written. About what
     was sent -- the saved profile, usually. */
  | "blocked"
  /* Generation started and a filter stopped it. About what was being written,
     not what was sent, so the same prompt can go through on another try. */
  | "stopped"
  | "empty"
  | "upstream";

export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/** One extracted memory, before it is persisted. Mirrors the Memory model. */
export interface ExtractedMemory {
  content: string;
  /* SHARED is between the two of them rather than about the user: a running
     joke, a nickname, a bit they keep coming back to. Solo keeps it as its own
     kind; the account app, whose database has no such kind, files it under
     RELATIONSHIP. */
  /* PROMISE is something the Muse owes them ("I'll tell you later"); DONE
     closes one, through `replaces`, and is never stored itself. */
  type: "PERMANENT" | "PREFERENCE" | "GOAL" | "RELATIONSHIP" | "EVENT" | "SHARED" | "PROMISE" | "DONE";
  importance: number; // 1-5
  confidence: number; // 0-1
  /* Indexes into the `known` list this fact makes untrue.
     
     People change jobs and leave cities, and without this the old fact simply
     stays: a user who quit engineering for photography ended up with a
     character that believed both at once, and both got injected into the same
     prompt. Usually empty. */
  replaces?: number[];
  /** For a plan or event with a known moment: ISO, resolved to the user's timezone. */
  when?: string | null;
}

/* When the conversation being mined happened. Without it "tomorrow at 11"
   could only be stored as the words "tomorrow at 11", which are wrong a day later. */
export interface ExtractionClock {
  timeZone?: string;
  now: number;
  /** One per transcript message, same order. */
  at?: (string | undefined)[];
}

export interface AIProvider {
  readonly name: "gemini" | "anthropic";

  generateResponse(opts: GenerateOptions): Promise<GenerateResult>;

  /** Yields text deltas. §45: streaming beats a spinner for long replies. */
  streamResponse(opts: GenerateOptions): AsyncIterable<string>;

  /** Returns null when the provider has no embedding model configured, so
   *  memory retrieval can fall back to lexical scoring rather than break. */
  /** `dims` requests a narrower vector; below full width the result is
   *  unit-normalised, which cosine similarity assumes. */
  generateEmbedding(text: string, dims?: number): Promise<number[] | null>;

  summarize(text: string, instruction?: string): Promise<string>;

  extractMemories(
    transcript: ChatMessage[],
    existingMemories: string[],
    clock?: ExtractionClock
  ): Promise<ExtractedMemory[]>;

  /** A reply grounded in a live web search, with the pages it drew on.
   *  Optional: a provider without search leaves it out, and callers fall back
   *  to what the model already knows. */
  searchWeb?(opts: { system: string; prompt: string }): Promise<SearchResult>;

  /** Text spoken in a prebuilt voice, streamed as raw 16-bit mono PCM.
   *  Optional: without it, calls are unavailable rather than broken. */
  speak?(text: string, voice: string, signal?: AbortSignal): Promise<SpeechStream>;

  /** A casual phone photo of what is described, with nobody in it. Optional:
   *  without it, a Muse simply never sends photos. */
  picture?(description: string, signal?: AbortSignal): Promise<{ mime: string; data: string }>;

  /** A profile picture of a made-up adult character. Optional, like picture(). */
  portrait?(description: string, signal?: AbortSignal): Promise<{ mime: string; data: string }>;
}

export interface SpeechStream {
  /** Samples per second of the PCM in `audio`. */
  rate: number;
  /** Little-endian signed 16-bit mono PCM, as it is generated. */
  audio: ReadableStream<Uint8Array>;
}

export interface SearchResult {
  text: string;
  sources: { title: string; url: string }[];
}
