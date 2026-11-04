import { anthropicProvider } from "./anthropic";
import { geminiProvider } from "./gemini";
import { REFUSAL_SNIFF_CHARS, looksLikeRefusal, retryNudge, stopNudge } from "./refusal";
import { AIProvider, ChatMessage, ProviderError } from "./types";

export * from "./types";
export { geminiProvider, anthropicProvider };

/* Provider selection is explicit-first.
 *
 * Checking keys in a fixed order is a trap: a stale key left in the environment
 * silently beats the one you meant to use, and nothing in the config hints at
 * it. LLM_PROVIDER decides whenever it is set. */
export function getProvider(): AIProvider {
  const forced = (process.env.LLM_PROVIDER || "").toLowerCase();
  if (forced === "gemini") {
    if (!process.env.GEMINI_API_KEY) throw new ProviderError("no_key", "LLM_PROVIDER=gemini but GEMINI_API_KEY is not set");
    return geminiProvider;
  }
  if (forced === "anthropic") {
    if (!process.env.ANTHROPIC_API_KEY) throw new ProviderError("no_key", "LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set");
    return anthropicProvider;
  }
  if (process.env.GEMINI_API_KEY) return geminiProvider;
  if (process.env.ANTHROPIC_API_KEY) return anthropicProvider;
  throw new ProviderError("no_key", "No model provider is configured");
}

export function hasProvider(): boolean {
  return Boolean(process.env.GEMINI_API_KEY || process.env.ANTHROPIC_API_KEY);
}

/** Embeddings come from whichever provider actually has them, regardless of
 *  which one is answering chat. Returns null when none does. */
export function getEmbeddingProvider(): AIProvider | null {
  if (process.env.GEMINI_API_KEY) return geminiProvider;
  return null;
}

/* §44: users see a plain sentence, never a provider string or stack trace.
   The detail is logged server-side instead. */
export function userFacingError(err: unknown): { message: string; retryable: boolean } {
  if (err instanceof ProviderError) {
    switch (err.code) {
      case "no_key":
      case "bad_model":
        return { message: "Something went wrong on our side. We're looking at it.", retryable: false };
      case "rate_limited":
        return { message: "That's a lot at once. Give it a minute and try again.", retryable: true };
      case "timeout":
        return { message: "That took too long to come back. Try again?", retryable: true };
      case "blocked":
        return { message: "That one couldn't be answered. Try putting it differently.", retryable: false };
      case "stopped":
        return { message: "A safety filter stopped that reply partway through. Try again?", retryable: true };
      case "empty":
      default:
        return { message: "Something went wrong. Try again.", retryable: true };
    }
  }
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
    return { message: "That took too long to come back. Try again?", retryable: true };
  }
  return { message: "Something went wrong. Try again.", retryable: true };
}


/* ------------------------------------------------- streaming with a guard */

export type GuardedEvent =
  | { type: "delta"; text: string }
  /* `history`: the reply only went through on that shorter history (an index
     into `histories`), so the caller can stop sending the rest. */
  | { type: "done"; history?: number; /** Which prompt got through: 0 the first, 1 the first fallback... */ variant?: number }
  /* `reason` distinguishes four very different failures that used to look
     alike to the caller: the model declined in character-breaking words, it
     produced nothing, the prompt was refused before generation, or a filter
     stopped the reply partway through. They need different messages and
     different fixes. */
  | { type: "refused"; reason: "refusal" | "empty" | "blocked" | "stopped" };

type Failure = "refusal" | "empty" | "blocked" | "stopped";

/** Generates a reply, and only lets it out once it is whole and in character.
 *
 *  It used to stream as soon as the first ninety characters looked fine. That
 *  was enough to catch a refusal, which announces itself at once -- but not a
 *  filter stopping the reply halfway, which by then had already reached the
 *  screen and could not be taken back. Half a sentence was saved as a finished
 *  message. Holding the whole reply costs nothing a texting app shows anyway
 *  (a message arrives whole, after "typing"), and it means a stopped or
 *  refused attempt can simply be tried again without anyone seeing it.
 *
 *  On failure it retries: a refusal or a stop gets a second pass with a nudge,
 *  a blocked prompt goes straight to the next, plainer variant. If every
 *  attempt fails it yields `refused`, and the caller keeps the conversation
 *  unchanged. */
export async function* streamGuarded(opts: {
  system: string;
  messages: ChatMessage[];
  /** Used in the retry nudges. */
  name: string;
  /** Passed through to the provider; see GenerateOptions.thinking. */
  thinking?: "minimal" | "low";
  /* Start passing text through once this much has arrived, ends a sentence,
     and does not read as a refusal -- instead of holding the whole reply. For
     a voice call, where the first sentence can be spoken while the rest is
     written. A failure after that point is an error, not a retry: some of the
     reply has already gone. */
  releaseAfter?: number;
  /* Progressively less verbatim material, tried in order once the full prompt
     has failed. A persona built from someone's real messages can carry content
     the provider will not accept at any threshold, and the only lever left is
     to send less of it. A plainer version of the character is worth having;
     silence is not. */
  fallbacks?: string[];
  /* Injected only by tests. The ladder below is the code that runs when
     everything else has already failed, so it is never exercised by using the
     app -- which is how a version of it that softened almost nothing survived
     into production. Taking the provider as an argument is the seam that lets
     it be driven through each failure on purpose. */
  provider?: AIProvider;
  /* Shorter versions of the conversation, tried in order once every prompt
     variant has been refused before generation. The fallbacks above only ever
     trim the profile, but the history goes with every one of them: a
     conversation holding one message or photo the provider will not accept
     (PROHIBITED_CONTENT, which no setting changes) was refused on every rung,
     every turn, forever -- with the profile blamed for it. Leaving the old part
     out is the only way such a conversation carries on. */
  histories?: ChatMessage[][];
}): AsyncIterable<GuardedEvent> {
  const provider = opts.provider ?? getProvider();
  const variants = [opts.system, ...(opts.fallbacks ?? [])];
  const nudge = (why: Failure) => (why === "stopped" ? stopNudge(opts.name) : retryNudge(opts.name));

  let lastReason: Failure = "refusal";

  for (let v = 0; v < variants.length; v++) {
    /* The full prompt gets two passes: as written, then with a nudge. Later
       variants already carry one, so a second identical pass would only cost
       latency. */
    const passes = v === 0 ? 2 : 1;
    for (let pass = 0; pass < passes; pass++) {
      const system = v > 0 || pass === 1 ? variants[v] + nudge(lastReason) : variants[v];

      const parts: string[] = [];
      let detail = "";
      let failed: Failure | null = null;
      let released = false;

      try {
        for await (const delta of provider.streamResponse({ system, messages: opts.messages, thinking: opts.thinking })) {
          parts.push(delta);
          if (released) { yield { type: "delta", text: delta }; continue; }
          if (opts.releaseAfter) {
            const sofar = parts.join("");
            if (sofar.length >= opts.releaseAfter && /[.!?…]\s|\n/.test(sofar) && !looksLikeRefusal(sofar.slice(0, REFUSAL_SNIFF_CHARS))) {
              released = true;
              for (const p of parts) yield { type: "delta", text: p };
            }
          }
        }
      } catch (err) {
        if (released) throw err;
        /* A stream that produces nothing, is refused, or is stopped by a filter
           is a failed attempt, not an error: nothing has been sent, so it can be
           tried again. Anything else -- a timeout, a bad key -- is real. */
        const code = err instanceof ProviderError ? err.code : null;
        if (code !== "empty" && code !== "blocked" && code !== "stopped") throw err;
        failed = code;
        detail = err instanceof Error ? err.message : String(err);
      }

      const text = parts.join("");
      if (released) { yield { type: "done" }; return; }
      if (!failed && !text.trim()) failed = "empty";
      if (!failed && looksLikeRefusal(text.slice(0, REFUSAL_SNIFF_CHARS))) failed = "refusal";

      if (!failed) {
        for (const p of parts) yield { type: "delta", text: p };
        yield { type: "done", variant: v };
        return;
      }
      lastReason = failed;

      /* Logged because this is otherwise invisible. When a persona goes quiet
         the only evidence is a message to the user, and without the model's
         actual words there is nothing to diagnose from. Truncated, and it is
         the model's output rather than anyone's conversation. */
      console.error(
        `[refusal] ${opts.name} variant ${v + 1}/${variants.length} pass ${pass + 1} reason=${failed}` +
          (detail ? ` detail=${detail}` : "") +
          (text.trim() ? ` text=${text.slice(0, 200).replace(/\s+/g, " ")}` : "")
      );

      /* A block or an empty stream is about what the prompt contains, not how
         it was asked. Repeating the same material behind a politer preamble
         changes nothing and only spends latency, so drop to the next variant
         and send less. A refusal or a stop is about what came out, and asking
         again with a nudge often changes that. */
      if (failed === "blocked" || failed === "empty") break;
    }
  }

  /* Every prompt refused before generation: the trouble is in what the
     conversation carries, so send less of it. Each shorter history gets the
     full prompt, then the plainest, and the whole reply is held as before. */
  if (lastReason === "blocked" && opts.histories?.length) {
    const systems = [...new Set([variants[0], variants.at(-1)!])];
    for (let h = 0; h < opts.histories.length; h++) {
      for (const system of systems) {
        const parts: string[] = [];
        let failed: Failure | null = null;
        let detail = "";
        try {
          for await (const delta of provider.streamResponse({ system, messages: opts.histories[h], thinking: opts.thinking })) {
            parts.push(delta);
          }
        } catch (err) {
          const code = err instanceof ProviderError ? err.code : null;
          if (code !== "empty" && code !== "blocked" && code !== "stopped") throw err;
          failed = code;
          detail = err instanceof Error ? err.message : String(err);
        }
        const text = parts.join("");
        if (!failed && !text.trim()) failed = "empty";
        if (!failed && looksLikeRefusal(text.slice(0, REFUSAL_SNIFF_CHARS))) failed = "refusal";
        if (!failed) {
          console.error(`[refusal] ${opts.name} went through on shorter history ${h + 1}/${opts.histories.length}`);
          for (const p of parts) yield { type: "delta", text: p };
          yield { type: "done", history: h };
          return;
        }
        lastReason = failed;
        console.error(`[refusal] ${opts.name} shorter history ${h + 1}/${opts.histories.length} reason=${failed}${detail ? ` detail=${detail}` : ""}`);
        /* Not blocked any more: the history is fine and something else is
           wrong, which a still shorter one will not fix. */
        if (failed !== "blocked") break;
      }
      if (lastReason !== "blocked") break;
    }
  }

  yield { type: "refused", reason: lastReason };
}
