import type { Child } from "hono/jsx";
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

function SiteHeader({ listener, path, lang }: { listener?: Listener; path?: string; lang: Lang }) {
  const t = tFor(lang);
  const signedIn = listener !== undefined && listener.googleSub !== null;
  return (
    <header class="site-header">
      <a class="site-name" href="/">{t("app.name")}</a>
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
        <meta name="theme-color" content="#0f0f1e" />
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
        <link rel="stylesheet" href="/app.css" />
      </head>
      <body>
        <SiteHeader listener={listener} path={path} lang={lang} />
        {children}
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
