import { type Lang, tFor } from "../worker/i18n/t";

/** The javascript: one-liner that opens /put on the current page; null when the configured origin is not a plain http(s) one. */
export function bookmarkletCode(publicOrigin: string): string | null {
  try {
    const url = new URL(publicOrigin);
    const plain = /^https?:\/\/[A-Za-z0-9.:[\]-]+$/.test(url.origin);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || !plain) return null;
    return `javascript:location.href='${url.origin}/put?url='+encodeURIComponent(location.href)`;
  } catch {
    return null;
  }
}

/** The button to drag to the bookmarks bar and the three lines on how to use it. */
/** `heading` is the level under the surrounding heading: h2 on its own page, h3 inside the send page's panel. */
export function BookmarkletHelp({ code, lang, heading: Heading }: { code: string | null; lang: Lang; heading: "h2" | "h3" }) {
  const t = tFor(lang);
  if (!code) return <p>{t("bookmarklet.unavailable")}</p>;
  return (
    <>
      <p>
        <a class="button" href={code} draggable="true">
          {t("bookmarklet.drag")}
        </a>
      </p>
      <Heading>{t("bookmarklet.addTitle")}</Heading>
      <ol class="bookmarklet-steps">
        <li>{t("bookmarklet.help1")}</li>
        <li>{t("bookmarklet.help2")}</li>
        <li>{t("bookmarklet.help3")}</li>
      </ol>
    </>
  );
}
