import type { Child } from "hono/jsx";
import { type Lang, tFor } from "../worker/i18n/t";

type LayoutProps = { title: string; children?: Child; /** The client entry to load: `player` or `station`. */
  script?: "player" | "station"; lang?: Lang };

/** `lang` is the listener's; pages outside the session (admin, health) leave it at Japanese. */
export function Layout({ title, children, script, lang = "ja" }: LayoutProps) {
  const t = tFor(lang);
  return (
    <html lang={lang}>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{`${title} | ${t("app.name")}`}</title>
        <meta name="theme-color" content="#0f0f1e" />
        <link rel="manifest" href="/manifest.webmanifest" />
        <link rel="icon" href="/icon.svg" type="image/svg+xml" />
        <link rel="stylesheet" href="/app.css" />
      </head>
      <body>
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
