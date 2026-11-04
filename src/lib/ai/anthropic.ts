import { extractMemoriesVia } from "./gemini";
import { sseData } from "./sse";
import {
  AIProvider,
  ChatMessage,
  ExtractedMemory, ExtractionClock,
  GenerateOptions,
  GenerateResult,
  ProviderError,
} from "./types";

const URL = "https://api.anthropic.com/v1/messages";

const key = () => process.env.ANTHROPIC_API_KEY ?? "";
const model = () => process.env.ANTHROPIC_MODEL || "claude-sonnet-5";
const timeoutMs = () => Number(process.env.UPSTREAM_TIMEOUT_MS || 60000);
/** Anthropic requires max_tokens on every request, so "uncapped" still needs a number. */
const defaultMax = () => Number(process.env.ANTHROPIC_MAX_TOKENS || 8192);

function headers() {
  if (!key()) throw new ProviderError("no_key", "ANTHROPIC_API_KEY is not set");
  return {
    "content-type": "application/json",
    "x-api-key": key(),
    "anthropic-version": "2023-06-01",
  };
}

function redact(text: string): string {
  let out = String(text ?? "");
  const k = key();
  if (k.length > 8) out = out.split(k).join("<redacted>");
  return out.replace(/sk-ant-[A-Za-z0-9_-]{10,}/g, "<redacted>");
}

function classify(status: number, detail: string): ProviderError {
  const d = redact(detail);
  if (status === 404 || /model/i.test(d)) return new ProviderError("bad_model", d, status);
  if (status === 429) return new ProviderError("rate_limited", d, status);
  if (status === 401 || status === 403) return new ProviderError("no_key", d, status);
  return new ProviderError("upstream", d, status);
}

function body(opts: GenerateOptions, stream: boolean) {
  return JSON.stringify({
    model: model(),
    max_tokens: opts.maxTokens ?? defaultMax(),
    temperature: opts.temperature ?? 1,
    ...(opts.system ? { system: opts.system } : {}),
    messages: opts.messages,
    ...(stream ? { stream: true } : {}),
  });
}

export const anthropicProvider: AIProvider = {
  name: "anthropic",

  async generateResponse(opts: GenerateOptions): Promise<GenerateResult> {
    const res = await fetch(URL, {
      method: "POST",
      headers: headers(),
      body: body(opts, false),
      signal: opts.signal ?? AbortSignal.timeout(timeoutMs()),
    });
    const data = await res.json();
    if (!res.ok) throw classify(res.status, (data as { error?: { message?: string } })?.error?.message || "no detail");

    const d = data as {
      content?: { type: string; text?: string }[];
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text = (d.content || []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n").trim();
    if (!text) throw new ProviderError("empty", "Nothing came back.");

    return {
      text,
      usage: { inputTokens: d.usage?.input_tokens, outputTokens: d.usage?.output_tokens },
      model: model(),
    };
  },

  async *streamResponse(opts: GenerateOptions): AsyncIterable<string> {
    const res = await fetch(URL, {
      method: "POST",
      headers: headers(),
      body: body(opts, true),
      signal: opts.signal ?? AbortSignal.timeout(timeoutMs()),
    });
    if (!res.ok || !res.body) {
      let detail = `HTTP ${res.status}`;
      try {
        const d = await res.json();
        detail = (d as { error?: { message?: string } })?.error?.message || detail;
      } catch { /* keep the status */ }
      throw classify(res.status, detail);
    }

    let emitted = false;
    for await (const payload of sseData(res.body)) {
      try {
        const evt = JSON.parse(payload) as { type?: string; delta?: { type?: string; text?: string } };
        if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta" && evt.delta.text) {
          emitted = true;
          yield evt.delta.text;
        }
      } catch { /* partial or non-JSON frame */ }
    }

    if (!emitted) throw new ProviderError("empty", "The model streamed nothing back.");
  },

  async generateEmbedding(_text?: string, _dims?: number): Promise<number[] | null> {
    /* Anthropic has no first-party embedding endpoint. Returning null makes the
       retriever fall back to lexical scoring rather than fail -- and if this
       deployment also has a Gemini key, getEmbeddingProvider() prefers that. */
    return null;
  },

  async summarize(text: string, instruction?: string): Promise<string> {
    const { text: out } = await this.generateResponse({
      system:
        instruction ??
        "Summarise the conversation below in under 120 words. Keep facts about the user, " +
          "decisions, and anything they seemed to care about. Write plainly, no preamble.",
      messages: [{ role: "user", content: text }],
      maxTokens: 400,
      temperature: 0.3,
    });
    return out;
  },

  extractMemories(transcript: ChatMessage[], existing: string[], clock?: ExtractionClock): Promise<ExtractedMemory[]> {
    return extractMemoriesVia(this, transcript, existing, clock);
  },
};
