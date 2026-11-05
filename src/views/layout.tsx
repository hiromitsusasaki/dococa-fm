import type { Child } from "hono/jsx";
import { raw } from "hono/html";
import { type Lang, tFor } from "../worker/i18n/t";
import type { Listener } from "../worker/types";

type LayoutProps = { title: string; children?: Child; /** The client entry to load: `player` or `station`. */
  script?: "player" | "station"; lang?: Lang;
  /** Link-preview tags, for pages meant to be shared. */
  og?: { title: string; description: string; url: string };
} & (
  /** With the session's listener the header needs the current path, so its sign-in link comes back here. */
  | { listener: Listener; path: string }
  /** Without one the header shows only the wordmark. */
  | { listener?: undefined; path?: undefined }
);

const FONTS_HREF = "https://fonts.googleapis.com/css2?family=Righteous&family=Zen+Kaku+Gothic+New:wght@400;500;700&display=swap";

/** Runs in the head, before first paint: a saved light/dark choice goes onto `html[data-theme]`; "auto" or an unreadable store leaves it off, so the device decides. */
const THEME_BOOT = `try{var t=localStorage.getItem("dfm.theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}`;

/** Wires the three header buttons: set `data-theme`, remember the choice (best effort) and mirror it in `aria-pressed`. */
const THEME_WIRE = `(function(){var r=document.documentElement,bs=document.querySelectorAll("[data-theme-set]");function cur(){var t=r.getAttribute("data-theme");return t==="light"||t==="dark"?t:"auto"}function show(){var c=cur();bs.forEach(function(b){b.setAttribute("aria-pressed",String(b.getAttribute("data-theme-set")===c))})}bs.forEach(function(b){b.addEventListener("click",function(){var v=b.getAttribute("data-theme-set");if(v==="auto")r.removeAttribute("data-theme");else r.setAttribute("data-theme",v);try{if(v==="auto")localStorage.removeItem("dfm.theme");else localStorage.setItem("dfm.theme",v)}catch(e){}show()})});show()})();`;

const THEMES = ["light", "dark", "auto"] as const;

function SiteHeader({ listener, path, lang }: { listener?: Listener; path?: string; lang: Lang }) {
  const t = tFor(lang);
  const signedIn = listener !== undefined && listener.googleSub !== null;
  return (
    <header class="site-header">
      <a class="site-name wordmark" href="/">{t("app.name")}</a>
      {listener && (
        <nav>
          <a href="/put">{t("home.put")}</a>
          {signedIn ? (
            <>
              <a href="/me">{t("me.title")}</a>
              <span class="site-user">{t("signin.as", { name: listener.displayName })}</span>
              <form method="post" action="/auth/signout">
                <button type="submit" class="quiet">{t("signin.out")}</button>
              </form>
            </>
          ) : (
            <a href={`/auth/google?next=${encodeURIComponent(path ?? "/")}`}>{t("signin.google")}</a>
          )}
        </nav>
      )}
      <div class="theme-toggle" role="group" aria-label={t("theme.label")}>
        {THEMES.map((mode) => (
          <button type="button" data-theme-set={mode} aria-pressed="false" title={t(`theme.${mode}`)} aria-label={t(`theme.${mode}`)}>
            {mode === "auto" ? (
              <>
                <span class="full" aria-hidden="true">{t("theme.auto")}</span>
                <span class="short" aria-hidden="true">{t("theme.autoShort")}</span>
              </>
            ) : (
              t(`theme.${mode}`)
            )}
          </button>
        ))}
      </div>
    </header>
  );
}

/** `lang` is the listener's; pages outside the session (admin, health) leave it at Japanese. */
export function Layout({ title, children, script, lang = "ja", listener, path, og }: LayoutProps) {
  const t = tFor(lang);
  return (
    <html lang={lang}>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title === t("app.name") ? title : `${title} | ${t("app.name")}`}</title>
        <meta name="theme-color" content="#121a2e" />
        {og && (
          <>
            <meta property="og:title" content={og.title} />
            <meta property="og:description" content={og.description} />
            <meta property="og:url" content={og.url} />
            <meta property="og:type" content="website" />
          </>
        )}
        <link rel="manifest" href="/manifest.webmanifest" />
        <link rel="icon" href="/icon.svg" type="image/svg+xml" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
        <link rel="stylesheet" href={FONTS_HREF} />
        <link rel="stylesheet" href="/app.css" />
        <script>{raw(THEME_BOOT)}</script>
      </head>
      <body>
        <SiteHeader listener={listener} path={path} lang={lang} />
        {children}
        <script>{raw(THEME_WIRE)}</script>
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
