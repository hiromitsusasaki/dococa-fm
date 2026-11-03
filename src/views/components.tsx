import type { Item, Letter } from "../worker/types";
import { t } from "../worker/i18n/t";
import { ja } from "../worker/i18n/ja";

type CardItem = Pick<Item, "kind" | "title" | "creator" | "year" | "imageUrl">;

export function ItemCard({ item, heading: Heading = "h1" }: { item: CardItem; heading?: "h1" | "h2" }) {
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

const outLabel = (key: string): string | null => (`out.${key}` in ja ? t(`out.${key}` as keyof typeof ja) : null);

/** Links the item has, then plain searches for the services it has none for. */
export function OutLinks({ item }: { item: Pick<Item, "kind" | "title" | "creator" | "outLinks"> }) {
  const q = encodeURIComponent(`${item.title} ${item.creator}`.trim());
  const own = Object.entries(item.outLinks).flatMap(([key, href]) => {
    const label = outLabel(key);
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

export const whoOf = (l: Pick<Letter, "radioName" | "place">): string => {
  const who = l.radioName ? t("letter.who", { name: l.radioName }) : t("listener.anonymous");
  return l.place ? t("letter.whoPlace", { who, place: l.place }) : who;
};

function ReportForm({ letterId }: { letterId: string }) {
  return (
    <form method="post" action={`/letters/${letterId}/report`}>
      <button type="submit" class="quiet">{t("report.button")}</button>
    </form>
  );
}

/** The translation first, with the untouched original beside it when the letter was not written in Japanese. */
export function LetterText({ letter }: { letter: Pick<Letter, "body" | "bodyJa" | "lang"> }) {
  return (
    <>
      <p class="letter-body">{letter.bodyJa}</p>
      {letter.lang !== "ja" && (
        <details class="letter-original">
          <summary>{t("item.originalBody")}</summary>
          <p>{letter.body}</p>
        </details>
      )}
    </>
  );
}

function Reaction({ r }: { r: Letter }) {
  if (r.kind === "watashimo") {
    return (
      <li class="reaction">
        {t("reaction.from", { who: whoOf(r), body: r.bodyJa })}
        <ReportForm letterId={r.id} />
      </li>
    );
  }
  return (
    <li class="reaction reply">
      <LetterText letter={r} />
      <p class="letter-who">{whoOf(r)}</p>
      <ReportForm letterId={r.id} />
    </li>
  );
}

function LetterCard({ letter, reactions, itemId }: { letter: Letter; reactions: Letter[]; itemId: string }) {
  return (
    <li class="letter" id={`letter-${letter.id}`}>
      <LetterText letter={letter} />
      <p class="letter-who">{whoOf(letter)}</p>
      {letter.kind === "found" && (
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
      )}
      {reactions.length > 0 && <ul class="reactions">{reactions.map((r) => <Reaction r={r} />)}</ul>}
      <div class="letter-actions">
        <form method="post" action="/letters">
          <input type="hidden" name="itemId" value={itemId} />
          <input type="hidden" name="kind" value="watashimo" />
          <input type="hidden" name="parentLetterId" value={letter.id} />
          <input type="hidden" name="body" value={t("reaction.watashimo")} />
          <button type="submit">{t("reaction.watashimoButton")}</button>
        </form>
        <form method="post" action="/letters" class="reply-form">
          <input type="hidden" name="itemId" value={itemId} />
          <input type="hidden" name="kind" value="reply" />
          <input type="hidden" name="parentLetterId" value={letter.id} />
          <input type="text" name="body" maxlength={200} placeholder={t("reaction.replyPlaceholder")} aria-label={t("reaction.reply")} />
          <button type="submit">{t("reaction.replySubmit")}</button>
        </form>
        <ReportForm letterId={letter.id} />
      </div>
    </li>
  );
}

/** Letters oldest first, found voices in their own section, reactions under their parent. No counts anywhere. */
export function LetterList({ itemId, letters }: { itemId: string; letters: Letter[] }) {
  const reactionsOf = (id: string) => letters.filter((l) => l.parentLetterId === id);
  const top = letters.filter((l) => l.parentLetterId === null);
  const mine = top.filter((l) => l.kind !== "found");
  const found = top.filter((l) => l.kind === "found");
  const render = (l: Letter) => <LetterCard letter={l} reactions={reactionsOf(l.id)} itemId={itemId} />;
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
