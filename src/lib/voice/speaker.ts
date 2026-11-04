"use client";

/* Playing a Muse's voice as it streams in, and stopping it the instant the
 * user talks over it.
 *
 * Web Audio rather than an <audio> element: the speak route sends raw PCM as it
 * is generated, and each chunk is scheduled to start exactly where the last one
 * ends -- so the first syllable plays while the rest of the sentence is still
 * being made, sentences follow one another without a gap, and stop() silences
 * everything queued at once. An <audio> element can do none of the three.
 *
 * Mobile browsers only allow sound after a tap, so unlock() must be called
 * from inside the Call button's handler, before anything is awaited. The one
 * Speaker is kept at module level so the call screen can pick up the context
 * the tap unlocked.
 */

type Ctx = AudioContext;

export class Speaker {
  private ctx: Ctx | null = null;
  private sources = new Set<AudioBufferSourceNode>();
  private endAt = 0;
  /** Bumped by stop(), so a stream still being read stops scheduling. */
  private generation = 0;

  /** Call synchronously from a tap. Safe to call more than once. */
  unlock(): void {
    if (typeof window === "undefined") return;
    if (!this.ctx || this.ctx.state === "closed") {
      const C: typeof AudioContext | undefined =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!C) return;
      this.ctx = new C();
    }
    void this.ctx.resume().catch(() => {});
    /* iOS unlocks on the first sound actually started inside the gesture. */
    const silent = this.ctx.createBuffer(1, 1, 22050);
    const src = this.ctx.createBufferSource();
    src.buffer = silent;
    src.connect(this.ctx.destination);
    src.start(0);
  }

  get ready(): boolean {
    return Boolean(this.ctx && this.ctx.state !== "closed");
  }

  /** The audio clock, in seconds. */
  get now(): number {
    return this.ctx?.currentTime ?? 0;
  }

  get playing(): boolean {
    return Boolean(this.ctx && this.ctx.currentTime < this.endAt - 0.02);
  }

  /** When everything queued so far will have finished, on the audio clock. */
  get queuedUntil(): number {
    return this.endAt;
  }

  async resume(): Promise<void> {
    await this.ctx?.resume().catch(() => {});
  }

  /* Plays one stream of 16-bit mono PCM after whatever is already queued.
     Resolves with when it starts and ends on the audio clock, or null if it was
     stopped (or had nothing in it). `onFirst` fires when its first chunk is
     scheduled. */
  async enqueue(
    stream: ReadableStream<Uint8Array>,
    rate: number,
    onFirst?: (startsAt: number) => void
  ): Promise<{ start: number; end: number } | null> {
    const ctx = this.ctx;
    if (!ctx) return null;
    const gen = this.generation;
    const reader = stream.getReader();
    let carry: Uint8Array | null = null;
    let start = -1;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (gen !== this.generation) { void reader.cancel().catch(() => {}); return null; }
        if (done) break;
        let bytes = value;
        if (carry) {
          const joined = new Uint8Array(carry.length + bytes.length);
          joined.set(carry);
          joined.set(bytes, carry.length);
          bytes = joined;
          carry = null;
        }
        /* A chunk can split a sample in half; keep the odd byte for the next. */
        if (bytes.length % 2) { carry = bytes.slice(bytes.length - 1); bytes = bytes.slice(0, bytes.length - 1); }
        if (!bytes.length) continue;
        const samples = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2);
        const buf = ctx.createBuffer(1, samples.length, rate);
        const ch = buf.getChannelData(0);
        for (let i = 0; i < samples.length; i++) ch[i] = samples[i] / 32768;

        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        /* A little lead on the first chunk after silence, so it is not clipped. */
        const at = Math.max(this.endAt, ctx.currentTime + 0.06);
        src.start(at);
        this.endAt = at + buf.duration;
        this.sources.add(src);
        src.onended = () => this.sources.delete(src);
        if (start < 0) { start = at; onFirst?.(at); }
      }
    } catch {
      if (gen !== this.generation) return null;
      throw new Error("playback");
    }
    return start < 0 ? null : { start, end: this.endAt };
  }

  /** Silences everything playing or queued, immediately. */
  stop(): void {
    this.generation++;
    for (const s of this.sources) {
      try { s.stop(); } catch { /* already stopped */ }
    }
    this.sources.clear();
    this.endAt = this.ctx?.currentTime ?? 0;
  }

  /** Resolves once everything queued has played (or stop() was called). */
  whenIdle(): Promise<void> {
    const gen = this.generation;
    return new Promise((resolve) => {
      const tick = () => {
        if (gen !== this.generation || !this.ctx || this.ctx.currentTime >= this.endAt - 0.01) resolve();
        else setTimeout(tick, 60);
      };
      tick();
    });
  }
}

/** The one speaker, so the context unlocked by the Call tap is the one used. */
export const speaker = new Speaker();
