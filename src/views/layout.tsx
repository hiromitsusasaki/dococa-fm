import { env } from "cloudflare:workers";
import type { Child } from "hono/jsx";
import { raw } from "hono/html";
import { type Lang, tFor } from "../worker/i18n/t";
import { unseenReactions } from "../worker/reaction-notice";
import type { Listener } from "../worker/types";

type LayoutProps = { title: string; children?: Child; /** The client entry to load: `player`, `station`, or `share-page` (only the share buttons). */
  script?: "player" | "station" | "share-page"; lang?: Lang;
  /** Link-preview tags, for pages meant to be shared. Without them a page previews as the app (its name, tagline and key visual). */
  og?: {
    title: string;
    description: string;
    url: string;
    type?: "website" | "article";
    image?: string;
    audio?: string;
    /** An X card; `player` plays `player` (an https page that may be framed) in the timeline. */
    twitter?: { card: "player"; player: string; width: number; height: number };
  };
  /** Shown inside a frame on another page of the site (the send modal): no header. */
  embed?: boolean;
} & (
  /** With the session's listener the header needs the current path, so its sign-in link comes back here. */
  | { listener: Listener; path: string }
  /** Without one the header shows the wordmark, the About link and the theme toggle. */
  | { listener?: undefined; path?: undefined }
);

const FONTS_HREF = "https://fonts.googleapis.com/css2?family=Righteous&family=Zen+Kaku+Gothic+New:wght@400;500;700&display=swap";

/** Runs in the head, before first paint: a saved light/dark choice goes onto `html[data-theme]`; "auto" or an unreadable store leaves it off, so the device decides. */
const THEME_BOOT = `try{var t=localStorage.getItem("dfm.theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}`;

/** Wires the three header buttons: set `data-theme`, remember the choice (best effort) and mirror it in `aria-pressed`. */
const THEME_WIRE = `(function(){var r=document.documentElement,bs=document.querySelectorAll("[data-theme-set]");function cur(){var t=r.getAttribute("data-theme");return t==="light"||t==="dark"?t:"auto"}function show(){var c=cur();bs.forEach(function(b){b.setAttribute("aria-pressed",String(b.getAttribute("data-theme-set")===c))})}bs.forEach(function(b){b.addEventListener("click",function(){var v=b.getAttribute("data-theme-set");if(v==="auto")r.removeAttribute("data-theme");else r.setAttribute("data-theme",v);try{if(v==="auto")localStorage.removeItem("dfm.theme");else localStorage.setItem("dfm.theme",v)}catch(e){}show()})});show()})();`;

/** In the send modal's frame, Escape reaches the frame's document, not the parent's dialog: ask the parent to close it. */
export const EMBED_ESCAPE = `addEventListener("keydown",function(e){if(e.key==="Escape")try{parent.postMessage({type:"dfm:close"},location.origin)}catch(_){}});`;

const THEMES = ["light", "dark", "auto"] as const;
const LANGS = ["ja", "en"] as const;

/** The `/me` link, with a dot (never a number) while someone's 私も or 一言 waits there unseen; on `/me` itself, none. */
async function MeLink({ listener, label, dot, here }: { listener: Listener; label: string; dot: string; here: boolean }) {
  const unseen = !here && (await unseenReactions(listener));
  return (
    <a href="/me">
      {label}
      {unseen && <span class="dot" role="img" aria-label={dot}></span>}
    </a>
  );
}

function SiteHeader({ listener, path, lang }: { listener?: Listener; path?: string; lang: Lang }) {
  const t = tFor(lang);
  const signedIn = listener !== undefined && listener.googleSub !== null;
  return (
    <header class="site-header">
      <a class="site-name wordmark" href="/">{t("app.name")}</a>
      <nav>
        <a href="/about" aria-current={path === "/about" ? "page" : undefined}>{t("about.link")}</a>
        {listener && <a href="/put">{t("home.put")}</a>}
        {listener &&
          (signedIn ? (
            <>
              <MeLink listener={listener} label={t("me.title")} dot={t("me.newReactions")} here={path?.split("?")[0] === "/me"} />
              <a class="settings-link" href="/settings" aria-label={t("settings.title")} title={t("settings.title")} aria-current={path?.split("?")[0] === "/settings" ? "page" : undefined}>
                <span class="gear" aria-hidden="true">{"\u2699\uFE0E"}</span>
              </a>
              <span class="site-user" title={t("signin.as", { name: listener.displayName })}>
                {listener.displayName}
              </span>
              <form method="post" action="/auth/signout">
                <button type="submit" class="quiet">{t("signin.out")}</button>
              </form>
            </>
          ) : (
            <a href={`/auth/google?next=${encodeURIComponent(path ?? "/")}`}>{t("signin.google")}</a>
          ))}
      </nav>
      {listener && (
        <form method="post" action="/lang" class="lang-toggle" role="group" aria-label={t("lang.label")} data-confirm>
          <input type="hidden" name="next" value={path ?? "/"} />
          {LANGS.map((l) => (
            <button type="submit" name="lang" value={l} aria-pressed={String(lang === l)} lang={l} aria-label={t(`lang.${l}`)}>
              <span class="full" aria-hidden="true">{t(`lang.${l}`)}</span>
              <span class="short" aria-hidden="true">{t(`lang.${l}Short`)}</span>
            </button>
          ))}
        </form>
      )}
      <div class="theme-toggle" role="group" aria-label={t("theme.label")}>
        {THEMES.map((mode) => (
          <button type="button" data-theme-set={mode} aria-pressed="false" title={t(`theme.${mode}`)} aria-label={t(`theme.${mode}`)}>
            <span class="full" aria-hidden="true">{t(`theme.${mode}`)}</span>
            <span class="short" aria-hidden="true">{t(`theme.${mode}Short`)}</span>
          </button>
        ))}
      </div>
    </header>
  );
}

/** `lang` is the listener's; pages outside the session (admin, health) leave it at Japanese. */
export function Layout({ title, children, script, lang = "ja", listener, path, og, embed = false }: LayoutProps) {
  const t = tFor(lang);
  const origin = env.PUBLIC_ORIGIN;
  const preview = og ?? { title: t("app.name"), description: t("app.tagline"), url: `${origin}${path ?? "/"}` };
  return (
    <html lang={lang}>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title === t("app.name") ? title : `${title} · ${t("app.name")}`}</title>
        <meta name="description" content={t("app.tagline")} />
        <meta name="theme-color" content="#121a2e" />
        <meta property="og:site_name" content={t("app.name")} />
        <meta property="og:title" content={preview.title} />
        <meta property="og:description" content={preview.description} />
        <meta property="og:url" content={preview.url} />
        <meta property="og:type" content={preview.type ?? "website"} />
        <meta property="og:image" content={preview.image ?? `${origin}/kv.jpg`} />
        {preview.audio && <meta property="og:audio" content={preview.audio} />}
        {preview.twitter ? (
          <>
            <meta name="twitter:card" content={preview.twitter.card} />
            <meta name="twitter:player" content={preview.twitter.player} />
            <meta name="twitter:player:width" content={String(preview.twitter.width)} />
            <meta name="twitter:player:height" content={String(preview.twitter.height)} />
          </>
        ) : (
          <meta name="twitter:card" content="summary_large_image" />
        )}
        <link rel="manifest" href="/manifest.webmanifest" />
        <link rel="icon" href="/icon.svg" type="image/svg+xml" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
        <link rel="stylesheet" href={FONTS_HREF} />
        <link rel="stylesheet" href="/app.css" />
        <script>{raw(THEME_BOOT)}</script>
      </head>
      <body class={embed ? "embed" : undefined}>
        {!embed && <SiteHeader listener={listener} path={path} lang={lang} />}
        {children}
        <script>{raw(THEME_WIRE)}</script>
        {embed && <script>{raw(EMBED_ESCAPE)}</script>}
        {script && (
          <script
            type="module"
            src={import.meta.env.DEV ? `/src/client/${script}.tsx` : `/assets/${script}.js`}
          />
        )}
      </body>
    </html>
  );
}
