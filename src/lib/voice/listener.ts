"use client";

/* Hearing the user, through the browser's own speech recognition.
 *
 * Chrome, Edge and Safari (desktop, Android and iOS) have it built in, it is
 * free, and it streams interim words as they are spoken -- which is what makes
 * interruption possible at all: the call knows someone is talking within a
 * fraction of a second, not after they finish. Firefox has none, and the call
 * screen says so rather than failing.
 *
 * Recognition sessions end on their own -- after silence, after a minute, after
 * the phone locks -- so this restarts itself for as long as the call wants to
 * listen, and gives up with an error only if it keeps failing straight away.
 */

export type ListenError = "denied" | "no-mic" | "network" | "unsupported" | "failed";

interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  onspeechstart: (() => void) | null;
}

type RecognitionCtor = new () => Recognition;

function ctor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export const canListen = (): boolean => ctor() !== null;

/* Asks for the microphone up front, so a refusal is a clear screen with a
   retry rather than a recognition error later. The stream is released straight
   away: on some Android builds holding it blocks recognition from using the mic. */
export async function askForMic(): Promise<ListenError | null> {
  if (!navigator.mediaDevices?.getUserMedia) return canListen() ? null : "unsupported";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    stream.getTracks().forEach((t) => t.stop());
    return null;
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "NotAllowedError" || name === "SecurityError") return "denied";
    if (name === "NotFoundError" || name === "NotReadableError" || name === "OverconstrainedError") return "no-mic";
    return "failed";
  }
}

export class Listener {
  private rec: Recognition | null = null;
  private wanted = false;
  private failures: number[] = [];

  constructor(
    private lang: string,
    private on: {
      /** Words so far in the current phrase, before it is final. */
      interim: (text: string) => void;
      /** A finished phrase. */
      final: (text: string) => void;
      error: (kind: ListenError) => void;
    }
  ) {}

  get listening(): boolean {
    return this.wanted;
  }

  start(): void {
    const C = ctor();
    if (!C) { this.on.error("unsupported"); return; }
    this.wanted = true;
    if (this.rec) return;
    const rec = new C();
    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const text = r[0]?.transcript ?? "";
        if (r.isFinal) { if (text.trim()) this.on.final(text.trim()); }
        else interim += text;
      }
      this.on.interim(interim.trim());
    };
    rec.onerror = (e) => {
      if (e.error === "no-speech" || e.error === "aborted") return;
      if (e.error === "not-allowed" || e.error === "service-not-allowed") { this.wanted = false; this.on.error("denied"); return; }
      if (e.error === "audio-capture") { this.wanted = false; this.on.error("no-mic"); return; }
      if (e.error === "network") this.on.error("network");
      this.failures.push(Date.now());
    };
    rec.onend = () => {
      this.rec = null;
      if (!this.wanted) return;
      /* Ending on its own is normal; ending over and over at once is not. */
      const now = Date.now();
      this.failures = this.failures.filter((t) => now - t < 4000);
      if (this.failures.length >= 4) { this.wanted = false; this.on.error("failed"); return; }
      setTimeout(() => { if (this.wanted && !this.rec) this.start(); }, 150);
    };
    this.rec = rec;
    try {
      rec.start();
    } catch {
      this.rec = null;
      this.failures.push(Date.now());
    }
  }

  stop(): void {
    this.wanted = false;
    const rec = this.rec;
    this.rec = null;
    if (rec) {
      rec.onend = null;
      try { rec.abort(); } catch { /* not running */ }
    }
    this.on.interim("");
  }
}

/* Which language to listen for.
 *
 * Most of these characters are spoken to in Hinglish, and en-IN transcribes
 * Hinglish into the same Latin-script mix the chats are written in, where hi-IN
 * would come back in Devanagari. Anyone else gets their browser's own language. */
export function listenLanguage(languages: string[] | undefined): string {
  const langs = (languages ?? []).map((l) => l.toLowerCase());
  if (langs.some((l) => l.includes("hinglish") || l.includes("hindi"))) return "en-IN";
  if (typeof navigator !== "undefined" && navigator.language) return navigator.language;
  return "en-US";
}
