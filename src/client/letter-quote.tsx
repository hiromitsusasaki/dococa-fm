/** @jsxImportSource hono/jsx/dom */
import { foundLabel, isHttpUrl, type LetterLine, type PlayerOriginals, whoOf } from "./playback";

/** The letter being read: the text in the listener's language, the original behind a toggle, and who sent it. */
export function LetterQuote({ letter, original, str, toggleKey }: { letter: LetterLine; original: PlayerOriginals[string] | undefined; str: (key: string) => string; toggleKey: string }) {
  return (
    <blockquote class={letter.kind === "found" ? "player-letter found" : "player-letter"}>
      <p>{original?.main ?? letter.text}</p>
      {original?.original != null && original.original !== original.main && (
        <details class="player-original">
          <summary>{str(toggleKey)}</summary>
          <p>{original.original}</p>
        </details>
      )}
      <footer class="letter-who">
        {letter.kind === "found" && isHttpUrl(letter.sourceUrl) ? (
          <a href={letter.sourceUrl} rel="noopener noreferrer nofollow" target="_blank">
            {foundLabel(letter, letter.sourceUrl, str)}
          </a>
        ) : (
          whoOf(letter, str)
        )}
      </footer>
    </blockquote>
  );
}
