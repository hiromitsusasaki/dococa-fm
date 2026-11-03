import type { Child } from "hono/jsx";
import { t } from "../worker/i18n/t";

type LayoutProps = { title: string; children?: Child; script?: boolean };

export function Layout({ title, children, script }: LayoutProps) {
  return (
    <html lang="ja">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{`${title} | ${t("app.name")}`}</title>
        <link rel="stylesheet" href="/app.css" />
      </head>
      <body>
        {children}
        {script && (
          <script
            type="module"
            src={import.meta.env.DEV ? "/src/client/player.tsx" : "/assets/player.js"}
          />
        )}
      </body>
    </html>
  );
}
