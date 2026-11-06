import type { Item, Letter } from "../worker/types";
import { displayText } from "../worker/letters/display";
import { type Lang, tFor } from "../worker/i18n/t";
import { ja } from "../worker/i18n/ja";
import { whoLine } from "../worker/letters/label";

type CardItem = Pick<Item, "kind" | "title" | "creator" | "year" | "imageUrl">;

export function ItemCard({ item, heading: Heading = "h1", lang }: { item: CardItem; heading?: "h1" | "h2" | "h3" | "h4"; lang: Lang }) {
  const t = tFor(lang);
  return (
    <section class="item-card">
      {item.imageUrl && <img src={item.imageUrl} alt="" width="120" height="120" loading="lazy" />}
      <div>
        <p class="item-kind">{t(`kind.${item.kind}`)}</p>
        <Heading>{item.title}</Heading>
        <p class="item-creator">
          {item.creator}
          {item.year !== null && ` (${item.year})`}
        </p>
      </div>
    </section>
  );
}

const outLabel = (key: string, lang: Lang): string | null => (`out.${key}` in ja ? tFor(lang)(`out.${key}` as keyof typeof ja) : null);

/** Links the item has, then plain searches for the services it has none for. */
export function OutLinks({ item, lang }: { item: Pick<Item, "kind" | "title" | "creator" | "outLinks">; lang: Lang }) {
  const t = tFor(lang);
  const q = encodeURIComponent(`${item.title} ${item.creator}`.trim());
  const own = Object.entries(item.outLinks).flatMap(([key, href]) => {
    const label = outLabel(key, lang);
    return label && isHttpUrl(href) ? [{ label, href }] : [];
  });
  const fallbacks = [
    ...(item.kind === "music" && !item.outLinks.spotify ? [{ label: t("out.search.spotify"), href: `https://open.spotify.com/search/${encodeURIComponent(item.title)}` }] : []),
    ...(item.kind !== "book" && !item.outLinks.youtube ? [{ label: t("out.search.youtube"), href: `https://www.youtube.com/results?search_query=${q}` }] : []),
    { label: t("out.google"), href: `https://www.google.com/search?q=${q}` },
  ];
  return (
    <ul class="out-links">
      {[...own, ...fallbacks].map((l) => (
        <li>
          <a href={l.href} rel="noopener noreferrer" target="_blank">
            {l.label}
          </a>
        </li>
      ))}
    </ul>
  );
}

export function isHttpUrl(s: string | null): s is string {
  return s !== null && /^https?:\/\//i.test(s);
}

/** The radio-name line; a demo account carries the 「デモ用」 mark at the end so nobody mistakes its letters for a real listener's. */
export const whoOf = (l: Pick<Letter, "radioName" | "place"> & Partial<Pick<Letter, "placeCountry" | "placeRegion">> & { demo?: boolean }, lang: Lang): string => {
  const t = tFor(lang);
  return whoLine(l, (key, params) => t(key, params), lang);
};

export function ReportForm({ letterId, lang }: { letterId: string; lang: Lang }) {
  const t = tFor(lang);
  return (
    <form method="post" action={`/letters/${letterId}/report`}>
      <button type="submit" class="quiet">{t("report.button")}</button>
    </form>
  );
}

/** The text in the listener's language first, with the untouched original behind a toggle when that is a translation. */
export function LetterText({ letter, lang }: { letter: Pick<Letter, "body" | "bodyJa" | "bodyEn" | "lang">; lang: Lang }) {
  const t = tFor(lang);
  const { main, original } = displayText(letter, lang);
  return (
    <>
      <p class="letter-body">{main}</p>
      {original !== null && original !== main && (
        <details class="letter-original">
          <summary>{t("letter.showOriginal")}</summary>
          <p>{original}</p>
        </details>
      )}
    </>
  );
}

function Reaction({ r, lang }: { r: Letter; lang: Lang }) {
  const t = tFor(lang);
  if (r.kind === "watashimo") {
    return (
      <li class="reaction">
        {t("reaction.from", { who: whoOf(r, lang), body: displayText(r, lang).main })}
        <ReportForm letterId={r.id} lang={lang} />
      </li>
    );
  }
  return (
    <li class="reaction reply">
      <LetterText letter={r} lang={lang} />
      <p class="letter-who">{whoOf(r, lang)}</p>
      <ReportForm letterId={r.id} lang={lang} />
    </li>
  );
}

/** The 私も and 一言 forms under a letter. */
export function ReactionForms({ letterId, itemId, lang }: { letterId: string; itemId: string; lang: Lang }) {
  const t = tFor(lang);
  return (
    <>
      <form method="post" action="/letters">
        <input type="hidden" name="itemId" value={itemId} />
        <input type="hidden" name="kind" value="watashimo" />
        <input type="hidden" name="parentLetterId" value={letterId} />
        <input type="hidden" name="body" value={t("reaction.watashimo")} />
        <button type="submit">{t("reaction.watashimoButton")}</button>
      </form>
      <form method="post" action="/letters" class="reply-form">
        <input type="hidden" name="itemId" value={itemId} />
        <input type="hidden" name="kind" value="reply" />
        <input type="hidden" name="parentLetterId" value={letterId} />
        <input type="text" name="body" maxlength={200} placeholder={t("reaction.replyPlaceholder")} aria-label={t("reaction.reply")} />
        <button type="submit">{t("reaction.replySubmit")}</button>
      </form>
    </>
  );
}

/** Where a found voice came from: its author, the link, and the way to ask for takedown. */
export function LetterSource({ letter, lang }: { letter: Pick<Letter, "id" | "sourceAuthor" | "sourceUrl">; lang: Lang }) {
  const t = tFor(lang);
  return (
    <p class="letter-source">
      {t("item.source")}: {letter.sourceAuthor ?? ""}
      {isHttpUrl(letter.sourceUrl) && (
        <>
          {" "}
          <a href={letter.sourceUrl} rel="noopener noreferrer nofollow" target="_blank">
            {letter.sourceUrl}
          </a>
        </>
      )}{" "}
      <a href={`/takedown?letterId=${letter.id}`}>{t("item.takedown")}</a>
    </p>
  );
}

const CARD_CHARS = 120;

/** A letter on the home page: the work's picture, the text cut at 120 code points (the full text is on the work's page), and who sent it. */
export function LetterCard({ letter, item, lang }: { letter: Letter; item: Item; lang: Lang }) {
  const t = tFor(lang);
  const chars = Array.from(displayText(letter, lang).main);
  const text = chars.length > CARD_CHARS ? `${chars.slice(0, CARD_CHARS).join("")}…` : chars.join("");
  const from = letter.kind === "found" ? `${t("item.source")}: ${letter.sourceAuthor ?? ""}` : whoOf(letter, lang);
  return (
    <a class="letter-card" href={`/stations/mine?letter=${letter.id}`}>
      <span class="letter-card-art">{item.imageUrl && <img src={item.imageUrl} alt="" width="96" height="96" loading="lazy" />}</span>
      <span class="letter-card-body">
        <span class="letter-card-text">{text}</span>
        <span class="letter-card-meta">{`${item.title} · ${from}`}</span>
        <span class="letter-card-play">{t("home.playFrom")}</span>
      </span>
    </a>
  );
}

function LetterRow({ letter, reactions, itemId, lang }: { letter: Letter; reactions: Letter[]; itemId: string; lang: Lang }) {
  const t = tFor(lang);
  return (
    <li class="letter" id={`letter-${letter.id}`}>
      <LetterText letter={letter} lang={lang} />
      {letter.kind !== "found" && <p class="letter-who">{whoOf(letter, lang)}</p>}
      {letter.kind === "found" && <LetterSource letter={letter} lang={lang} />}
      {reactions.length > 0 && <ul class="reactions">{reactions.map((r) => <Reaction r={r} lang={lang} />)}</ul>}
      <div class="letter-actions">
        <ReactionForms letterId={letter.id} itemId={itemId} lang={lang} />
        <ReportForm letterId={letter.id} lang={lang} />
      </div>
    </li>
  );
}

/** Letters oldest first, found voices in their own section, reactions under their parent. No counts anywhere. */
export function LetterList({ itemId, letters, lang }: { itemId: string; letters: Letter[]; lang: Lang }) {
  const t = tFor(lang);
  const reactionsOf = (id: string) => letters.filter((l) => l.parentLetterId === id);
  const top = letters.filter((l) => l.parentLetterId === null);
  const mine = top.filter((l) => l.kind !== "found");
  const found = top.filter((l) => l.kind === "found");
  const render = (l: Letter) => <LetterRow letter={l} reactions={reactionsOf(l.id)} itemId={itemId} lang={lang} />;
  return (
    <>
      <section class="letters">
        <h2>{t("item.letters")}</h2>
        {mine.length === 0 ? <p class="muted">{t("item.noLetters")}</p> : <ul>{mine.map(render)}</ul>}
      </section>
      {found.length > 0 && (
        <section class="letters found">
          <h2>{t("item.foundVoices")}</h2>
          <ul>{found.map(render)}</ul>
        </section>
      )}
    </>
  );
}
