import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getVerifiedEpisode, listVerifiedEpisodes } from "../db/episodes";
import { getItem, getItemsByIds } from "../db/items";
import { getLetter, listLettersForItem } from "../db/letters";
import type { Env } from "../env";
import type { ja } from "../i18n/ja";
import { type Lang, tFor } from "../i18n/t";
import { type LetterFailure, type LetterInput, createLetter } from "../letters/create";
import { makeEpisode } from "../program/create";
import { prepareLetter } from "../program/prepare";
import { loadPublicEpisode } from "../program/stored";
import type { Episode, Listener } from "../types";
import { renderEpisode, renderItemPage } from "./markdown";

type ToolResult = { content: [{ type: "text"; text: string }]; isError?: true };

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

const failureText = (f: LetterFailure, lang: Lang): string => {
  const t = tFor(lang);
  return f.reason ? `${t(f.key)} ${t(`letters.reason.${f.reason}` as keyof typeof ja)}` : t(f.key);
};

/** Letters rejected since the episode was made are left out, as on the episode page. */
async function renderStoredEpisode(db: D1Database, episode: Episode, lang: Lang): Promise<string> {
  const { segments, letters } = await loadPublicEpisode(db, episode, lang);
  const items = await getItemsByIds(db, segments.map((s) => s.itemId));
  return renderEpisode({ ...episode, segments }, { items, letters }, lang);
}

/** The verified episode to hand over: a fresh one when asked and allowed, otherwise the latest, otherwise a first one. */
async function pickEpisode(env: Env, db: D1Database, listener: Listener, wantNew: boolean): Promise<Episode | null> {
  const latest = async () => (await listVerifiedEpisodes(db, listener.id, 1))[0] ?? null;
  if (!wantNew) {
    const existing = await latest();
    if (existing) return existing;
  }
  const made = await makeEpisode(env, listener);
  if (made.ok) return getVerifiedEpisode(db, made.id);
  return latest();
}

async function itemPageWithNotice(db: D1Database, itemId: string, notice: string, lang: Lang): Promise<ToolResult> {
  const item = await getItem(db, itemId);
  if (!item) return ok(notice);
  return ok(`${notice}\n\n${renderItemPage(item, await listLettersForItem(db, item.id), lang)}`);
}

/** Exactly four tools: the DJ side never gets write access beyond placing a letter or a reaction as the listener. */
export function createMcpServer(env: Env, db: D1Database, listener: Listener, waitUntil: (work: Promise<unknown>) => void = () => {}): McpServer {
  const server = new McpServer({ name: "dococa-fm", version: "0.1.0" });
  const lang = listener.lang;
  const t = tFor(lang);

  server.registerTool(
    "get_episode",
    {
      description: "今日の番組を取り出す。new を true にすると新しい回を作る（上限に当たれば最新の回）。",
      inputSchema: { new: z.boolean().optional() },
    },
    async ({ new: wantNew }) => {
      const episode = await pickEpisode(env, db, listener, wantNew === true);
      return episode ? ok(await renderStoredEpisode(db, episode, lang)) : fail(t("mcp.noEpisode"));
    },
  );

  server.registerTool(
    "get_item",
    {
      description: "作品のカードと、その作品に届いているお便りを取り出す。",
      inputSchema: { itemId: z.string().max(100) },
    },
    async ({ itemId }) => {
      const item = await getItem(db, itemId);
      return item ? ok(renderItemPage(item, await listLettersForItem(db, item.id), lang)) : fail(t("mcp.itemNotFound"));
    },
  );

  const place = async (input: LetterInput, notice: string): Promise<ToolResult> => {
    const result = await createLetter(env, db, listener, input);
    if (result.ok && result.letter.kind === "letter") waitUntil(prepareLetter(env, db, result.letter.id));
    return result.ok ? itemPageWithNotice(db, result.itemId, notice, lang) : fail(failureText(result, lang));
  };

  server.registerTool(
    "post_letter",
    {
      description: "作品にお便りを送る（200 字まで）。作品は URL か itemId で指す。書いたとおりに届く。",
      inputSchema: { url: z.string().max(2000).optional(), itemId: z.string().max(100).optional(), body: z.string() },
    },
    // The web gate for new letters is requireSignin; MCP has no session, so the same rule is checked here.
    ({ url, itemId, body }) => (listener.googleSub === null ? fail(t("signin.needed")) : place({ url, itemId, body, kind: "letter" }, t("mcp.posted"))),
  );

  server.registerTool(
    "react",
    {
      description: "届いているお便りに「私も」か一言を返す。letterId は get_item で分かる。",
      inputSchema: { letterId: z.string().max(100), kind: z.enum(["watashimo", "reply"]), body: z.string().optional() },
    },
    async ({ letterId, kind, body }) => {
      const parent = await getLetter(db, letterId);
      if (!parent) return fail(t("letters.badParent"));
      return place({ itemId: parent.itemId, body: body ?? "", kind, parentLetterId: parent.id }, t("mcp.reacted"));
    },
  );

  return server;
}
