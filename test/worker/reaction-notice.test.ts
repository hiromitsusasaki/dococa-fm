import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import type { Variables } from "../../src/worker/auth/session";
import { insertItem } from "../../src/worker/db/items";
import { insertLetter } from "../../src/worker/db/letters";
import { createListener, updateListener } from "../../src/worker/db/listeners";
import type { Env } from "../../src/worker/env";
import { reactionNotice, unseenReactions } from "../../src/worker/reaction-notice";
import type { Listener } from "../../src/worker/types";
import { resetDb } from "../helpers/db";
import { itemDraft, letterDraft } from "./db/helpers";

beforeEach(() => resetDb(env.DB));

describe("reactionNotice", () => {
  it("keeps each request's check apart: a later request of the same listener finishing first leaves the earlier one's dot", async () => {
    const me = (await updateListener(env.DB, (await createListener(env.DB)).id, { googleSub: "sub-1" }))!;
    const other = await createListener(env.DB);
    const item = await insertItem(env.DB, itemDraft());
    const mine = await insertLetter(env.DB, letterDraft(item.id, { listenerId: me.id }));
    await insertLetter(env.DB, letterDraft(item.id, { kind: "watashimo", parentLetterId: mine.id, listenerId: other.id, body: "私も", bodyJa: "私も" }));

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const app = new Hono<{ Bindings: Env; Variables: Variables }>();
    app.use("*", async (c, next) => {
      c.set("listener", { ...me } as Listener);
      await next();
    });
    app.use("*", reactionNotice);
    app.get("/slow", async (c) => {
      await gate;
      return c.text(String(await unseenReactions({ ...me } as Listener)));
    });
    app.get("/fast", async (c) => c.text(String(await unseenReactions(me))));

    const slow = app.request("/slow", {}, env);
    const fast = await app.request("/fast", {}, env);
    expect(await fast.text()).toBe("true");
    release();
    expect(await (await slow).text()).toBe("true");
    // Another listener's id, or outside any request, finds nothing.
    expect(await unseenReactions({ ...me, id: other.id } as Listener)).toBe(false);
  });
});
