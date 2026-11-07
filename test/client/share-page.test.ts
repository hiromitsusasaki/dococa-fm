import { afterEach, describe, expect, it, vi } from "vitest";

describe("the share page entry", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("wires div.share on load: copy goes to the clipboard, the share sheet shows where it exists", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText }, share: vi.fn(() => Promise.resolve()) });
    document.body.innerHTML = `<div class="share"><button type="button" data-share="https://x.test/letters/1" data-text="t" hidden>共有</button><button type="button" data-copy="https://x.test/letters/1" data-copied="ok">copy</button></div>`;
    await import("../../src/client/share-page");
    expect(document.querySelector<HTMLElement>("[data-share]")!.hidden).toBe(false);
    document.querySelector<HTMLElement>("[data-copy]")!.click();
    expect(writeText).toHaveBeenCalledWith("https://x.test/letters/1");
  });
});
