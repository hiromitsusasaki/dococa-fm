/** Web Speech helpers. Every wait here is bounded, so a missing or silent engine never stalls the radio. */

const VOICES_WAIT_MS = 2000;
const SILENT_MS_PER_CHAR = 120;
const SILENT_MIN_MS = 1500;
/** Some engines never fire `end`; give up on an utterance after this long per character plus a margin. */
const WATCHDOG_MS_PER_CHAR = 400;
const WATCHDOG_MARGIN_MS = 5000;

// Held so the engine's utterance is not garbage-collected before it ends (a Chrome quirk).
let speaking: SpeechSynthesisUtterance | null = null;

const synth = (): SpeechSynthesis | undefined => (typeof speechSynthesis === "undefined" ? undefined : speechSynthesis);

/** player_waits_for_voices: the list is often empty at first; wait for `voiceschanged` up to 2 s, then go on. */
export function loadVoices(): Promise<SpeechSynthesisVoice[]> {
  const s = synth();
  if (!s) return Promise.resolve([]);
  const now = s.getVoices();
  if (now.length > 0) return Promise.resolve(now);
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      s.removeEventListener("voiceschanged", done);
      resolve(s.getVoices());
    };
    const timer = setTimeout(done, VOICES_WAIT_MS);
    s.addEventListener("voiceschanged", done);
  });
}

export const pickVoice = (voices: SpeechSynthesisVoice[], voiceURI: string): SpeechSynthesisVoice | undefined =>
  voices.find((v) => v.voiceURI === voiceURI) ?? voices.find((v) => v.lang.startsWith("ja")) ?? undefined;

/** Resolves when the line has been read (or skipped through `signal`). Without speech support it just waits a reading time. */
export function speak(text: string, voice: SpeechSynthesisVoice | undefined, signal: AbortSignal): Promise<void> {
  const s = synth();
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (speaking === utterance) speaking = null;
      resolve();
    };
    const onAbort = () => {
      s?.cancel();
      finish();
    };
    const utterance = s ? new SpeechSynthesisUtterance(text) : null;
    signal.addEventListener("abort", onAbort);
    if (!s || !utterance) {
      timer = setTimeout(finish, Math.max(SILENT_MIN_MS, text.length * SILENT_MS_PER_CHAR));
      return;
    }
    utterance.lang = "ja-JP";
    if (voice) utterance.voice = voice;
    utterance.onend = finish;
    utterance.onerror = finish;
    speaking = utterance;
    timer = setTimeout(() => {
      s.cancel();
      finish();
    }, text.length * WATCHDOG_MS_PER_CHAR + WATCHDOG_MARGIN_MS);
    s.speak(utterance);
  });
}
