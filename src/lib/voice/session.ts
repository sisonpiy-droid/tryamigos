"use client";

import { endCall, findMuse, insertAfter, newCallId, newMessage, readReaction, startCall, type SoloMessage, type SoloMuse, type SoloState } from "@/lib/solo/store";
import { learnFrom } from "@/lib/solo/learn";
import { voiceFor } from "@/lib/solo/media";
import { prepareTurn, streamReply, withAppMessage } from "@/lib/solo/turn";
import { Listener, askForMic, canListen, listenLanguage, type ListenError } from "./listener";
import { speaker } from "./speaker";
import { takeSpeakable } from "./voices";

/* One voice call.
 *
 *   you speak -> browser recognition -> a user message in the ordinary thread
 *     -> the same /api/solo/chat turn text chat uses (register "live")
 *     -> each sentence spoken through /api/solo/speak as soon as it is written
 *     -> the reply saved to the thread, and memory learned from it
 *
 * Recognition keeps running while the Muse talks. A couple of words from the
 * user that are not just the Muse's own voice coming back through the mic stop
 * the audio, cancel what was still being generated, keep only the part that
 * was actually heard, and the call carries on from what the user said.
 *
 * Owns no conversation of its own: every line goes into the Muse's ordinary
 * thread tagged via "voice", and the call itself is a metadata record.
 */

export type CallState = "connecting" | "listening" | "processing" | "speaking" | "interrupted" | "ended" | "error";

export interface CallView {
  state: CallState;
  muted: boolean;
  /** What the user is saying right now, as recognised so far. */
  heard: string;
  /** What the Muse is saying right now. */
  caption: string;
  /** A problem worth a line on screen. Fatal ones come with state "error". */
  notice: string | null;
  /** True when the notice can be cleared by trying again. */
  canRetry: boolean;
  startedAt: number | null;
}

type Update = (next: SoloState | ((cur: SoloState) => SoloState)) => void;

const MESSAGES: Record<ListenError | "ai" | "tts" | "offline" | "timeout", string> = {
  denied: "Try Amigos needs your microphone for calls. Allow it for this site in your browser settings, then try again.",
  "no-mic": "No microphone was found. Check one is connected and not in use by another app, then try again.",
  unsupported: "This browser can't do voice calls. Open Try Amigos in Chrome, Edge or Safari.",
  network: "Couldn't hear you. Try again.",
  failed: "Couldn't hear you. Try again.",
  ai: "Something went wrong. Try again.",
  timeout: "Something went wrong. Try again.",
  tts: "I couldn't play that response.",
  offline: "You're offline.",
};

/** How long a pause after a finished phrase means they have finished talking. */
const END_OF_TURN_MS = 400;
/** Words of the user's that count as talking over the Muse. */
const BARGE_IN_WORDS = 2;
/** No first word from the model in this long is a failed turn, not a slow one. */
const FIRST_WORD_TIMEOUT_MS = 25_000;

const words = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);

interface Piece { text: string; start?: number }

interface Turn {
  abort: AbortController;
  pieces: Piece[];
  chain: Promise<void>;
  /** The user message this turn answers; absent for the greeting. */
  answering?: string;
  audible: boolean;
}

export class CallSession {
  readonly callId = newCallId();
  private view: CallView = { state: "connecting", muted: false, heard: "", caption: "", notice: null, canRetry: false, startedAt: null };
  private listener: Listener | null = null;
  private turn: Turn | null = null;
  private pending: string[] = [];
  private sendTimer: ReturnType<typeof setTimeout> | null = null;
  private interimNow = "";
  private ended = false;
  private recorded = false;
  private failed = false;
  private wake: { release(): Promise<void> } | null = null;
  private voice = "";

  constructor(
    private museId: string,
    private fallback: SoloMuse,
    private getState: () => SoloState,
    private update: Update,
    private onView: (v: CallView) => void
  ) {}

  private set(patch: Partial<CallView>) {
    if (this.ended && patch.state && patch.state !== "ended") return;
    this.view = { ...this.view, ...patch };
    this.onView(this.view);
  }

  /* A save lands on the next render, not the moment update() returns. Anything
     that reads the thread straight after saving -- building the reply, learning
     from it -- waits for the message to actually be there, or it would answer
     the conversation without the sentence the user just said. */
  private async settled(id: string | undefined): Promise<void> {
    if (!id) return;
    const has = () => (this.getState().conversations[this.museId] ?? []).some((m) => m.id === id);
    for (let i = 0; i < 60 && !has(); i++) await new Promise((r) => setTimeout(r, 16));
  }

  private muse(): SoloMuse {
    return findMuse(this.getState(), this.museId) ?? this.fallback;
  }

  /* ------------------------------------------------------------- lifecycle */

  async start(): Promise<void> {
    this.set({ state: "connecting", notice: null, canRetry: false });
    if (!canListen()) return this.fatal("unsupported", false);
    const mic = await askForMic();
    if (this.ended) return;
    if (mic) return this.fatal(mic, mic !== "unsupported");

    /* Usually already unlocked by the Call tap; harmless if so. */
    speaker.unlock();
    await speaker.resume();
    await this.ensureVoice();
    if (this.ended) return;

    if (!this.recorded) {
      this.update((cur) => startCall(cur, this.museId, this.callId));
      this.recorded = true;
    }
    void this.keepAwake();

    this.listener = new Listener(listenLanguage(this.muse().languages), {
      interim: (t) => this.onInterim(t),
      final: (t) => this.onFinal(t),
      error: (k) => this.onListenError(k),
    });
    if (!this.view.muted) this.listener.start();
    this.set({ startedAt: this.view.startedAt ?? Date.now() });

    /* They pick up: the Muse speaks first, the way a call starts. */
    void this.runTurn(true);
  }

  /** After a microphone problem: ask again. */
  retry(): void {
    this.failed = false;
    if (this.listener) {
      this.set({ notice: null, canRetry: false, state: "listening" });
      if (!this.view.muted) this.listener.start();
      return;
    }
    void this.start();
  }

  toggleMute(): void {
    const muted = !this.view.muted;
    this.set({ muted, heard: "" });
    if (muted) this.listener?.stop();
    else this.listener?.start();
  }

  /** The app went to the background: stop listening, let the audio finish. */
  pause(): void {
    this.listener?.stop();
  }

  resume(): void {
    if (this.ended) return;
    void speaker.resume();
    void this.keepAwake();
    if (!this.view.muted && this.view.state !== "error") this.listener?.start();
  }

  end(): void {
    if (this.ended) return;
    let last = this.turn ? this.cutOff() : undefined;
    this.ended = true;
    if (this.sendTimer) clearTimeout(this.sendTimer);
    /* Anything said but not yet sent still belongs in the history. */
    if (this.pending.length) last = this.saveUser(this.pending.join(" "));
    this.pending = [];
    this.listener?.stop();
    speaker.stop();
    if (this.recorded) {
      void this.settled(last).then(() => {
        this.update((cur) => endCall(cur, this.callId, this.failed ? "FAILED" : "COMPLETED"));
        void this.learn();
      });
    }
    void this.wake?.release().catch(() => {});
    this.wake = null;
    this.view = { ...this.view, state: "ended", heard: "", caption: "" };
    this.onView(this.view);
  }

  private fatal(kind: ListenError, canRetry: boolean): void {
    this.failed = true;
    this.set({ state: "error", notice: MESSAGES[kind], canRetry });
  }

  private async keepAwake(): Promise<void> {
    try {
      const nav = navigator as unknown as { wakeLock?: { request(type: "screen"): Promise<{ release(): Promise<void> }> } };
      if (nav.wakeLock && !this.wake) this.wake = await nav.wakeLock.request("screen");
    } catch { /* not supported, or the page is hidden */ }
  }

  /* Shared with voice notes, so a call and a voice note sound the same. If
     none can be chosen the speak route falls back to a default voice. */
  private async ensureVoice(): Promise<void> {
    const v = await voiceFor(this.muse(), this.museId, this.update);
    if (v) this.voice = v;
  }

  /* ------------------------------------------------------------- hearing */

  private onListenError(kind: ListenError): void {
    if (this.ended) return;
    if (kind === "denied" || kind === "no-mic" || kind === "unsupported") return this.fatal(kind, kind !== "unsupported");
    /* Recognition hiccups are not the end of the call: say so, keep going. */
    this.set({ notice: MESSAGES[kind], canRetry: kind === "failed" });
  }

  /* The Muse's own voice, picked up by the mic and recognised as the user.
     Most of what was "heard" being words the Muse is saying right now means
     it was the speaker, not a person. */
  private isEcho(text: string): boolean {
    if (!this.turn || !speaker.playing) return false;
    const said = new Set(this.turn.pieces.filter((p) => p.start !== undefined).flatMap((p) => words(p.text)));
    const heard = words(text);
    if (!heard.length || !said.size) return false;
    return heard.filter((w) => said.has(w)).length / heard.length >= 0.6;
  }

  private onInterim(text: string): void {
    if (this.ended || this.view.muted) return;
    this.interimNow = text;
    if (text) {
      if (this.sendTimer) { clearTimeout(this.sendTimer); this.sendTimer = null; }
      if (this.turn && words(text).length >= BARGE_IN_WORDS && !this.isEcho(text)) this.interrupt();
    } else if (this.pending.length) {
      this.scheduleSend();
    }
    if (!this.isEcho(text)) this.set({ heard: [...this.pending, text].join(" ").trim(), notice: text ? null : this.view.notice });
  }

  private onFinal(text: string): void {
    if (this.ended || this.view.muted) return;
    if (this.isEcho(text)) return;
    if (this.turn) this.interrupt();
    this.pending.push(text);
    this.interimNow = "";
    this.set({ heard: this.pending.join(" "), notice: null });
    this.scheduleSend();
  }

  private scheduleSend(): void {
    if (this.sendTimer) clearTimeout(this.sendTimer);
    this.sendTimer = setTimeout(() => {
      this.sendTimer = null;
      if (this.interimNow || !this.pending.length || this.ended) return;
      const said = this.pending.join(" ").trim();
      this.pending = [];
      this.set({ heard: "" });
      if (!said) return;
      const id = this.saveUser(said);
      void this.runTurn(false, id);
    }, END_OF_TURN_MS);
  }

  /* --------------------------------------------------------------- saving */

  private saveUser(content: string): string {
    const msg = newMessage("user", content);
    const tagged: SoloMessage = { ...msg, via: "voice", callId: this.callId };
    this.update((cur) => ({
      ...cur,
      conversations: { ...cur.conversations, [this.museId]: [...(cur.conversations[this.museId] ?? []), tagged] },
    }));
    return tagged.id;
  }

  private saveMuse(content: string, answering: string | undefined, interrupted = false): string | undefined {
    const text = readReaction(content).rest.replace(/\n?\s*-{3,}\s*\n?/g, " ").trim();
    if (!text) return undefined;
    const msg: SoloMessage = { ...newMessage("muse", text), via: "voice", callId: this.callId, ...(interrupted ? { interrupted: true } : {}) };
    this.update((cur) =>
      answering
        ? insertAfter(cur, this.museId, answering, [msg])
        : { ...cur, conversations: { ...cur.conversations, [this.museId]: [...(cur.conversations[this.museId] ?? []), msg] } }
    );
    return msg.id;
  }

  /** The same extraction text chat runs, over the latest stretch of the thread. */
  private async learn(after?: string): Promise<void> {
    await this.settled(after);
    const s = this.getState();
    const window = (s.conversations[this.museId] ?? []).slice(-8);
    if (window.some((m) => m.callId === this.callId)) {
      void learnFrom({ museIds: [this.museId], window, state: s, update: this.update });
    }
  }

  /* ------------------------------------------------------------- speaking */

  /* The user talked over the Muse. Stop the audio, cancel the rest of the
     reply, and keep only what was actually heard, so the history matches the
     call rather than what the model had planned to say. */
  private interrupt(): void {
    if (!this.turn) return;
    const wasSpeaking = this.turn.audible;
    this.cutOff();
    this.set({ state: wasSpeaking ? "interrupted" : "listening", caption: "" });
  }

  private cutOff(): string | undefined {
    const t = this.turn;
    if (!t) return undefined;
    this.turn = null;
    t.abort.abort();
    const now = speaker.now;
    speaker.stop();
    const heard = t.pieces.filter((p) => p.start !== undefined && p.start <= now + 0.05).map((p) => p.text).join(" ");
    return heard ? this.saveMuse(heard, t.answering, true) : undefined;
  }

  private async runTurn(greeting: boolean, answering?: string): Promise<void> {
    if (this.ended) return;
    if (this.turn) this.cutOff();
    const turn: Turn = { abort: new AbortController(), pieces: [], chain: Promise.resolve(), answering, audible: false };
    this.turn = turn;
    const signal = turn.abort.signal;
    if (!greeting) this.set({ state: "processing", caption: "" });

    await this.settled(answering);
    if (signal.aborted || this.turn !== turn) return;
    const prepared = await prepareTurn(this.getState(), this.museId, { signal, register: "live", fallback: this.fallback, embedWithinMs: 250 });
    if (!prepared || signal.aborted || this.turn !== turn) return;
    if (greeting) {
      withAppMessage(prepared, "(The call has just connected and you have picked up. Answer it the way you would answer a call from them -- briefly -- then let them talk.)");
    }

    let buffer = "";
    let first = true;
    let gotWord = false;
    const timer = setTimeout(() => { if (!gotWord) turn.abort.abort("timeout"); }, FIRST_WORD_TIMEOUT_MS);

    let outcome;
    try {
      outcome = await streamReply(prepared.body, signal, (_soFar, delta) => {
        gotWord = true;
        buffer += delta;
        const { pieces, rest } = takeSpeakable(buffer, first);
        buffer = rest;
        for (const p of pieces) { this.speak(turn, p); first = false; }
      });
    } catch {
      outcome = null;
    } finally {
      clearTimeout(timer);
    }

    if (this.turn !== turn) return;            // interrupted or ended: already handled
    if (!outcome || !outcome.ok) {
      const timedOut = signal.aborted && signal.reason === "timeout";
      const offline = typeof navigator !== "undefined" && navigator.onLine === false;
      this.turn = null;
      speaker.stop();
      this.set({
        state: "listening",
        caption: "",
        notice: offline ? MESSAGES.offline : timedOut ? MESSAGES.timeout : outcome && !outcome.ok ? outcome.message : MESSAGES.ai,
      });
      return;
    }
    if (buffer.trim()) this.speak(turn, buffer.trim());

    await turn.chain;
    if (this.turn !== turn) return;
    await speaker.whenIdle();
    if (this.turn !== turn) return;

    this.turn = null;
    void this.learn(this.saveMuse(outcome.text, answering));
    this.set({ state: "listening", caption: "" });
  }

  /* Ask for this piece's audio now, play it after the pieces before it. Asking
     early is what hides the TTS round trip behind the audio already playing. */
  private speak(turn: Turn, text: string): void {
    const piece: Piece = { text };
    turn.pieces.push(piece);
    const signal = turn.abort.signal;
    const audio = fetch("/api/solo/speak", {
      method: "POST",
      signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, voice: this.voice || undefined }),
    }).catch(() => null);

    turn.chain = turn.chain.then(async () => {
      if (signal.aborted) return;
      const res = await audio;
      if (signal.aborted) return;
      if (res?.status === 204) return;
      if (!res?.ok || !res.body) {
        /* The words still count: show them, so the call does not go silent
           for no visible reason. */
        this.set({ notice: MESSAGES.tts, caption: text, state: "speaking" });
        return;
      }
      const rate = Number(res.headers.get("x-sample-rate")) || 24000;
      try {
        await speaker.enqueue(res.body, rate, (startsAt) => {
          piece.start = startsAt;
          const delay = Math.max(0, (startsAt - speaker.now) * 1000);
          setTimeout(() => {
            if (this.turn !== turn) return;
            turn.audible = true;
            this.set({ state: "speaking", caption: text, notice: null });
          }, delay);
        });
      } catch {
        if (!signal.aborted) this.set({ notice: MESSAGES.tts, caption: text });
      }
    });
  }
}
