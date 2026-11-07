import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wireShare } from "../../src/client/share";

const set = (key: "share" | "clipboard", value: unknown) => Object.defineProperty(navigator, key, { value, configurable: true });
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("share links on the page", () => {
  let off = () => {};
  beforeEach(() => {
    document.body.innerHTML =
      '<div class="share"><a class="pill" href="https://x.com/intent/post?text=t&url=u">X で共有</a><button type="button" data-share="https://dococafm.app/letters/L1" data-text="曲A · しずくさんのお便り — Dococa FM" hidden>共有</button><button type="button" data-copy="https://dococafm.app/letters/L1" data-copied="リンクをコピーしました">リンクをコピー</button></div>';
  });
  afterEach(() => {
    off();
    set("share", undefined);
    set("clipboard", undefined);
    vi.unstubAllGlobals();
  });
  const button = (attr: string) => document.querySelector<HTMLButtonElement>(`[${attr}]`)!;

  it("keeps the share-sheet button hidden where the browser has none", () => {
    set("share", undefined);
    off = wireShare(document);
    expect(button("data-share").hidden).toBe(true);
  });

  it("shows the share-sheet button where there is one and shares the title, short text and page", async () => {
    const share = vi.fn(() => Promise.reject(new DOMException("closed", "AbortError")));
    set("share", share);
    off = wireShare(document);
    expect(button("data-share").hidden).toBe(false);
    button("data-share").click();
    await flush();
    expect(share).toHaveBeenCalledWith({ title: "Dococa FM", text: "曲A · しずくさんのお便り — Dococa FM", url: "https://dococafm.app/letters/L1" });
  });

  it("copies the link and toasts; without a clipboard it shows the link to copy by hand", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    set("clipboard", { writeText });
    off = wireShare(document);
    button("data-copy").click();
    await flush();
    expect(writeText).toHaveBeenCalledWith("https://dococafm.app/letters/L1");
    expect(document.querySelector(".toast")!.textContent).toBe("リンクをコピーしました");
    set("clipboard", undefined);
    const ask = vi.fn(() => null);
    vi.stubGlobal("prompt", ask);
    button("data-copy").click();
    expect(ask).toHaveBeenCalledWith("リンクをコピー", "https://dococafm.app/letters/L1");
  });
});
