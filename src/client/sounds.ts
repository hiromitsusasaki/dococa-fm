/** The radio's own sounds and the ON AIR lamp's ear: one Web Audio context, made inside the first tap. Only the station page loads this. */
import { isIOS } from "./audio";

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
  /** Taps a clip element for `level`; does nothing where the graph cannot attach or is not trusted (no Web Audio, Safari). */
  listen(el: HTMLMediaElement): void;
  /** How loud the tapped clip is now, 0..1; null while none is tapped or it is not playing (the browser voice cannot be tapped). */
  level(): number | null;
  /** Closes the context (the station is unmounted). */
  close(): void;
};

/**
 * Safari (macOS and iOS, every WebKit browser on iOS) is never tapped: a tapped element is heard only through the context, and WebKit
 * can leave it suspended or interrupted (an output change, a call) while the element plays on in silence. The lamp is not worth that.
 */
export const noTap = (): boolean =>
  typeof navigator !== "undefined" && (isIOS() || /^((?!chrome|chromium|crios|fxios|edg|android).)*safari/i.test(navigator.userAgent));

/** `onPlay` is called each time the tapped clip starts playing, so the lamp only runs then. */
export function createSounds(onPlay?: () => void): Sounds {
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
    } catch {
      return;
    }
    if (onPlay) {
      el.addEventListener?.("play", onPlay);
      if (!el.paused) onPlay();
    }
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
      if (!ctx || noTap()) return;
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
    close() {
      void ctx?.close?.().catch(() => {});
      ctx = null;
      analyser = null;
      clip = null;
    },
  };
}
