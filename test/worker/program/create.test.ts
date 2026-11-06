import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getEpisode, insertEpisode } from "../../../src/worker/db/episodes";
import { upsertHistory } from "../../../src/worker/db/history";
import { insertItem } from "../../../src/worker/db/items";
import { insertLetter } from "../../../src/worker/db/letters";
import { createListener } from "../../../src/worker/db/listeners";
import { makeEpisode } from "../../../src/worker/program/create";
import { resetDb } from "../../helpers/db";
import { itemDraft, letterDraft } from "../db/helpers";

async function seed() {
  const me = await createListener(env.DB);
  const other = await createListener(env.DB);
  const near = await insertItem(env.DB, itemDraft({ title: "手元の曲" }));
  await upsertHistory(env.DB, [{ listenerId: me.id, itemId: near.id, source: "manual", occurredAt: null, rank: null }]);
  await insertLetter(env.DB, letterDraft(near.id, { listenerId: other.id, radioName: "しずく", place: "松本", body: "手紙", bodyJa: "手紙" }));
  return me;
}

const cloud = async (id: string) => (await getEpisode(env.DB, id))!.cloudTts;

beforeEach(async () => {
  await resetDb(env.DB);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("makeEpisode cloud voice", () => {
  it("gives every episode the cloud voice when a key exists, not just the first", async () => {
    const me = await seed();
    const keyed = { ...env, GOOGLE_TTS_SA_JSON: "sa-test" };
    const first = await makeEpisode(keyed, me);
    const second = await makeEpisode(keyed, me);
    expect(first.ok && second.ok).toBe(true);
    expect(await cloud((first as { id: string }).id)).toBe(true);
    expect(await cloud((second as { id: string }).id)).toBe(true);
  });

  it("stores the listener's language on the episode", async () => {
    const me = await seed();
    const made = await makeEpisode({ ...env, GOOGLE_TTS_SA_JSON: "" }, { ...me, lang: "en" });
    expect((await getEpisode(env.DB, (made as { id: string }).id))!.lang).toBe("en");
    const ja = await makeEpisode({ ...env, GOOGLE_TTS_SA_JSON: "" }, me);
    expect((await getEpisode(env.DB, (ja as { id: string }).id))!.lang).toBe("ja");
  });

  it("leaves the voice off without a key", async () => {
    const me = await seed();
    const made = await makeEpisode({ ...env, GOOGLE_TTS_SA_JSON: "" }, me);
    expect(await cloud((made as { id: string }).id)).toBe(false);
  });

  it("does not let CLOUD_TTS_GLOBAL_DAILY_LIMIT stop an episode from being made", async () => {
    const me = await seed();
    const made = await makeEpisode({ ...env, GOOGLE_TTS_SA_JSON: "sa-test", CLOUD_TTS_GLOBAL_DAILY_LIMIT: "0" }, me);
    expect(made.ok).toBe(true);
  });
});

describe("makeEpisode limits", () => {
  it("allows 60 segments a day by default: the 61st is the limit", async () => {
    const me = await seed();
    const unset = { ...env, EPISODE_DAILY_LIMIT: "", EPISODE_GLOBAL_DAILY_LIMIT: "", GOOGLE_TTS_SA_JSON: "" };
    // Made today already, cheaply: rows only.
    for (let n = 0; n < 59; n++) await insertEpisode(env.DB, { listenerId: me.id, segments: [], verified: true, report: { verbatim: true, sources: true, topical: true, pii: true, details: [] } });
    const sixtieth = await makeEpisode(unset, me);
    expect(sixtieth.ok).toBe(true);
    expect(await makeEpisode(unset, me)).toEqual({ ok: false, reason: "limit" });
  });

  it("makes one segment whatever the stored dial would have asked for", async () => {
    const me = await seed();
    const made = await makeEpisode({ ...env, GOOGLE_TTS_SA_JSON: "" }, me, { first: true });
    expect((await getEpisode(env.DB, (made as { id: string }).id))!.segments).toHaveLength(1);
  });
});
