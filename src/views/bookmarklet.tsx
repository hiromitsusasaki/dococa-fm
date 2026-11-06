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
export function BookmarkletHelp({ code, lang }: { code: string | null; lang: Lang }) {
  const t = tFor(lang);
  if (!code) return <p>{t("bookmarklet.unavailable")}</p>;
  return (
    <>
      <p>
        <a class="button" href={code} draggable="true">
          {t("bookmarklet.drag")}
        </a>
      </p>
      <h3>{t("bookmarklet.addTitle")}</h3>
      <ol class="bookmarklet-steps">
        <li>{t("bookmarklet.help1")}</li>
        <li>{t("bookmarklet.help2")}</li>
        <li>{t("bookmarklet.help3")}</li>
      </ol>
    </>
  );
}
