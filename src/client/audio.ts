/** Audio helpers: clips (cloud TTS) and the bed under the DJ. */

/** A short silent clip: playing it inside a tap is what lets the element play later without one (iOS Safari). */
const SILENT_WAV = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";

export type ClipPlayer = {
  /** Call synchronously inside the tap: starts the one shared element so later `play` calls are allowed. */
  unlock(): void;
  /** Plays `url` until it ends, `seconds` pass, or `signal` aborts. Always resolves: false when the clip failed (error event, non-2xx, play refused), true otherwise. */
  play(url: string, signal: AbortSignal, seconds?: number): Promise<boolean>;
  /** 0..1, applied to the shared element now and whenever it is created. */
  setVolume(volume: number): void;
};

/** One reusable element for every TTS clip: a fresh `new Audio` per clip would lose the tap's permission. `onCreate` sees it once, when it is made. */
export function createClipPlayer(onCreate?: (el: HTMLAudioElement) => void): ClipPlayer {
  let audio: HTMLAudioElement | null = null;
  let volume = 1;
  const element = () => {
    if (audio) return audio;
    audio = Object.assign(new Audio(), { volume });
    onCreate?.(audio);
    return audio;
  };
  return {
    setVolume(v) {
      volume = v;
      if (audio) audio.volume = v;
    },
    unlock() {
      const a = element();
      a.src = SILENT_WAV;
      a.play().catch(() => {});
    },
    play(url, signal, seconds) {
      return new Promise<boolean>((resolve) => {
        const a = element();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (ok = true) => {
          clearTimeout(timer);
          signal.removeEventListener("abort", onEnded);
          a.removeEventListener("ended", onEnded);
          a.removeEventListener("error", onError);
          a.pause();
          resolve(ok);
        };
        const onEnded = () => finish();
        const onError = () => finish(false);
        a.addEventListener("ended", onEnded);
        a.addEventListener("error", onError);
        signal.addEventListener("abort", onEnded);
        if (seconds !== undefined) timer = setTimeout(onEnded, seconds * 1000);
        a.src = url;
        a.play().catch(onError);
      });
    },
  };
}

export const BED_URLS = ["/bed-1.mp3", "/bed-2.mp3", "/bed-3.mp3", "/bed-4.mp3", "/bed-5.mp3"];
// The beds are about -24 LUFS, so 0.3 puts them roughly 18 dB under the voice.
const BED_VOLUME = 0.3;
/** A new episode's bed comes in under the old one over this long, equal power. */
export const BED_FADE_MS = 1500;
const FADE_STEP_MS = 50;

export type Bed = { unlock(): void; next(): void; start(): void; stop(): void; setVolume(volume: number): void };

/**
 * Two looping elements, so a new episode's bed can cross the old one: `next` while a bed plays fades the playing one out and
 * the other in (cos/sin over `BED_FADE_MS`); while none plays it only changes the url for the next `start`.
 */
export function createBed(opts: { urls?: string[] } = {}): Bed {
  const urls = opts.urls ?? BED_URLS;
  const beds: HTMLAudioElement[] = [];
  let at = 0;
  let current: string | null = null;
  let level = BED_VOLUME;
  let fade: ReturnType<typeof setInterval> | undefined;
  /** A random url other than the one in use (when there is another to take). */
  const pick = () => {
    const others = urls.length > 1 ? urls.filter((u) => u !== current) : urls;
    return others[Math.floor(Math.random() * others.length)]!;
  };
  const make = (i: number) => (beds[i] ??= Object.assign(new Audio(), { loop: true, volume: level }));
  const element = () => {
    const bed = make(at);
    if (current === null) {
      current = pick();
      bed.src = current;
    }
    return bed;
  };
  const endFade = () => {
    if (fade === undefined) return;
    clearInterval(fade);
    fade = undefined;
    beds[1 - at]?.pause();
    if (beds[at]) beds[at]!.volume = level;
  };
  return {
    /** The listener's volume (0..1) scales the bed's own quiet level. */
    setVolume(v) {
      level = BED_VOLUME * v;
      if (fade === undefined) for (const b of beds) b.volume = level;
    },
    /** Inside the tap: lets both elements play later without a gesture (iOS Safari). */
    unlock() {
      const a = element();
      a.play().catch(() => {});
      a.pause();
      const b = make(1 - at);
      if (!b.src) b.src = SILENT_WAV;
      b.play().catch(() => {});
      b.pause();
    },
    /** A new episode begins: another bed, crossed over the one playing, or kept for the next start(). */
    next() {
      if (current === null) return;
      current = pick();
      const old = beds[at];
      if (!old || old.paused) {
        if (old) old.src = current;
        return;
      }
      endFade();
      at = 1 - at;
      const incoming = make(at);
      incoming.src = current;
      incoming.volume = 0;
      incoming.play().catch(() => {});
      const began = Date.now();
      fade = setInterval(() => {
        const t = Math.min(1, (Date.now() - began) / BED_FADE_MS);
        old.volume = level * Math.cos((t * Math.PI) / 2);
        incoming.volume = level * Math.sin((t * Math.PI) / 2);
        if (t >= 1) endFade();
      }, FADE_STEP_MS);
    },
    start() {
      element().play().catch(() => {});
    },
    stop() {
      endFade();
      for (const b of beds) b.pause();
    },
  };
}

export type SoundKind = "switch" | "dial" | "watashimo";

/** The radio's own sounds, quiet by design: wave, pitch, length (s) and loudness before the volume knob. */
const SOUNDS: Record<SoundKind, { type: OscillatorType; hz: number; s: number; gain: number }> = {
  switch: { type: "triangle", hz: 110, s: 0.02, gain: 0.08 },
  dial: { type: "square", hz: 1800, s: 0.01, gain: 0.05 },
  watashimo: { type: "sine", hz: 880, s: 0.08, gain: 0.04 },
};

export type Sounds = {
  /** Inside the tap: makes and resumes the one context. Before it, nothing sounds. */
  unlock(): void;
  /** A click or chime scaled by `volume` (0..1); silent at 0 or without Web Audio. */
  play(kind: SoundKind, volume: number): void;
  /** Taps a clip element for `level`; does nothing where the graph cannot attach (no Web Audio, iOS). */
  listen(el: HTMLMediaElement): void;
  /** How loud the tapped clip is now, 0..1; null while none is tapped or it is not playing (the browser voice cannot be tapped). */
  level(): number | null;
};

/** iOS routes a tapped element only while the context runs, and suspends it on interruptions: the lamp is not worth a silent clip. */
const isIOS = () => typeof navigator !== "undefined" && (/iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));

export function createSounds(): Sounds {
  let ctx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let buf: Uint8Array<ArrayBuffer> | null = null;
  let clip: HTMLMediaElement | null = null;
  const tapped = new WeakSet<HTMLMediaElement>();
  const attach = (el: HTMLMediaElement) => {
    if (!ctx || ctx.state !== "running" || tapped.has(el)) return;
    tapped.add(el);
    try {
      const src = ctx.createMediaElementSource(el);
      src.connect(ctx.destination);
      const a = ctx.createAnalyser();
      a.fftSize = 256;
      src.connect(a);
      analyser = a;
      clip = el;
      buf = new Uint8Array(a.fftSize);
    } catch {}
  };
  return {
    unlock() {
      if (ctx || typeof AudioContext === "undefined") return;
      try {
        ctx = new AudioContext();
        void ctx.resume?.().catch(() => {});
      } catch {
        ctx = null;
      }
    },
    play(kind, volume) {
      if (!ctx || volume <= 0) return;
      const s = SOUNDS[kind];
      try {
        const t = ctx.currentTime;
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = s.type;
        osc.frequency.value = s.hz;
        g.gain.setValueAtTime(s.gain * volume, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + s.s);
        osc.connect(g).connect(ctx.destination);
        osc.start(t);
        osc.stop(t + s.s);
      } catch {}
    },
    listen(el) {
      if (!ctx || isIOS()) return;
      if (ctx.state === "running") return attach(el);
      ctx.resume().then(() => attach(el), () => {});
    },
    level() {
      if (!analyser || !buf || !clip || clip.paused) return null;
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += ((v - 128) / 128) ** 2;
      return Math.min(1, Math.sqrt(sum / buf.length) * 4);
    },
  };
}
