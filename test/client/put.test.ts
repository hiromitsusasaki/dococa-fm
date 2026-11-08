import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wirePut } from "../../src/client/put";

describe("ask the DJ back on the send page", () => {
  let off = () => {};
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    document.body.innerHTML =
      '<form class="put-form"><input type="hidden" name="itemId" value="I1"><p class="put-askback" data-none="いまは問いを思いつきませんでした" hidden></p><textarea name="body">雨の日に聴くと落ち着きます</textarea><p class="put-ask-row"><button type="button" class="put-ask" data-ask-url="/put/ask">DJ に問い返してもらう</button></p></form>';
    off = wirePut(document);
  });
  afterEach(() => {
    off();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  const press = async () => {
    document.querySelector<HTMLButtonElement>(".put-ask")!.click();
    await vi.advanceTimersByTimeAsync(0);
  };
  const slot = () => document.querySelector<HTMLElement>(".put-askback")!;

  it("posts the item and draft as JSON and shows the question above the textarea", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ question: "どんな場面でしたか？" }), { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);
    await press();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/put/ask");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ itemId: "I1", draft: "雨の日に聴くと落ち着きます" });
    expect(slot().hidden).toBe(false);
    expect(slot().textContent).toBe("どんな場面でしたか？");
    expect(slot().compareDocumentPosition(document.querySelector("textarea")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.querySelector<HTMLButtonElement>(".put-ask")!.disabled).toBe(false);
  });

  it("shows the none text for 3 seconds when no question comes, or the request fails", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({ question: null }), { status: 200 }))));
    await press();
    expect(slot().textContent).toBe("いまは問いを思いつきませんでした");
    expect(slot().hidden).toBe(false);
    await vi.advanceTimersByTimeAsync(2999);
    expect(slot().hidden).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(slot().hidden).toBe(true);
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
    await press();
    expect(slot().textContent).toBe("いまは問いを思いつきませんでした");
    expect(slot().hidden).toBe(false);
  });

  it("does not call the server for an empty draft", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    document.querySelector("textarea")!.value = "  ";
    await press();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(slot().textContent).toBe("いまは問いを思いつきませんでした");
  });
});
