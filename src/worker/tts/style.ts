/**
 * How Gemini-TTS should read every line: a late-night city-FM host, clear and natural, calm and never pushing
 * the voice. The voice is Charon (see GEMINI_TTS_VOICE). The suave / dandy wording chosen on 2026-11-05 (samples
 * "P" / "Q") was heard as too sticky (ねっとり) in both languages in production on 2026-11-07; the owner asked
 * for simple and clean.
 *
 * Written as an instruction ("read the following…"), as Google's examples are: the descriptive form was read
 * aloud as text on every short line in production (2026-11-06). The imperative form still is, rarely, which
 * `spokeThePrompt` in google.ts catches by the clip's length. The English prompt was not seen read aloud in
 * its descriptive form and was read in an imperative one, so it keeps its form.
 */
export const DJ_STYLE_PROMPT =
  "次の文を、深夜の都会の FM の男性 DJ のように読んでください。落ち着いて澄んだ、自然で簡潔な話し方で。テンポは急がず、抑揚は軽く、声を張らず、粘らず、母音を伸ばさず、誇張しないでください。";

/** The English counterpart, for when the programme is generated in English (Phase 3). */
export const DJ_STYLE_PROMPT_EN =
  "A late-night city FM host with a clear, crisp, natural delivery. Easy, unhurried pace; light, clean intonation; warm but understated, like talking to a friend. Not breathy, not sultry, no drawn-out vowels, no exaggeration.";
