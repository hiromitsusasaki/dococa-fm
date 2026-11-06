/**
 * How Gemini-TTS should read every line. Chosen by the owner after an audition on 2026-11-05 (sample "P"):
 * a chic, dandy late-night city-FM host, calm and never pushing the voice, but with a smooth tempo and rich
 * intonation. The voice is Charon (see GEMINI_TTS_VOICE).
 *
 * Written as an instruction ("read the following…"), as Google's examples are: the descriptive form was read
 * aloud as text on every short line in production (2026-11-06). The imperative form still is, rarely, which
 * `spokeThePrompt` in google.ts catches by the clip's length. The English prompt was not seen read aloud in
 * its descriptive form and was read in an imperative one, so it keeps its form.
 */
export const DJ_STYLE_PROMPT =
  "次の文を、深夜の都会の FM の男性 DJ のように読んでください。シックでダンディに、終始落ち着いた穏やかな話し方で、声を張らず、テンポは滑らかに、抑揚は豊かに、固有名詞と作品名で少し声を立て、言葉の間で呼吸するように。誇張しないでください。";

/** The English counterpart (sample "Q"), for when the programme is generated in English (Phase 3). */
export const DJ_STYLE_PROMPT_EN =
  "A suave, chic male DJ on a late-night city FM show around 11pm. Low, calm, mature voice; relaxed delivery, never pushing the voice. Keep a lively tempo and clear, expressive intonation with rises and falls, and let the pauses breathe. Speaking to one close friend, no exaggeration";
