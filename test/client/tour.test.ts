import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountStation, type StationOptions } from "../../src/client/station";
import { startTour, TOUR_KEY, tourDone } from "../../src/client/tour";

const labels = { next: "次へ", end: "はじめる", skip: "とばす", label: "使い方" };
const steps = [
  { at: "#a", title: "A", text: "first" },
  { at: "#b", title: "B", text: "second" },
];

const bubble = () => document.querySelector<HTMLElement>(".tour-bubble");
const nextButton = () => document.querySelector<HTMLButtonElement>("[data-tour-next]")!;
const skipButton = () => document.querySelector<HTMLButtonElement>("[data-tour-skip]")!;
const key = (k: string, target: EventTarget = document.activeElement ?? document) => target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '<button id="a">a</button><div id="b">b</div>';
});

afterEach(() => {
  if (document.querySelector(".tour")) key("Escape", document);
  vi.unstubAllGlobals();
});

describe("startTour", () => {
  it("shows the first step's title and sentence over a dim overlay, with the focus on 次へ", () => {
    startTour(steps, labels);
    expect(document.querySelectorAll(".tour").length).toBe(1);
    expect(document.querySelector(".tour-hole")).not.toBeNull();
    expect(bubble()!.getAttribute("role")).toBe("dialog");
    expect(bubble()!.querySelector("h2")!.textContent).toBe("A");
    expect(bubble()!.querySelector("p")!.textContent).toBe("first");
    expect(nextButton().textContent).toBe("次へ");
    expect(skipButton().textContent).toBe("とばす");
    expect(document.activeElement).toBe(nextButton());
  });

  it("次へ walks the steps; the last one ends the tour and marks it done", () => {
    startTour(steps, labels);
    nextButton().click();
    expect(bubble()!.querySelector("p")!.textContent).toBe("second");
    expect(nextButton().textContent).toBe("はじめる");
    expect(tourDone()).toBe(false);
    nextButton().click();
    expect(document.querySelector(".tour")).toBeNull();
    expect(localStorage.getItem(TOUR_KEY)).toBe("done");
    expect(tourDone()).toBe(true);
  });

  it("とばす ends it at once and marks it done", () => {
    startTour(steps, labels);
    skipButton().click();
    expect(document.querySelector(".tour")).toBeNull();
    expect(tourDone()).toBe(true);
  });

  it("Enter goes on, Escape skips; Tab stays inside the bubble", () => {
    startTour(steps, labels);
    key("Enter");
    expect(bubble()!.querySelector("p")!.textContent).toBe("second");
    key("Tab");
    expect(document.activeElement).toBe(skipButton());
    key("Tab");
    expect(document.activeElement).toBe(nextButton());
    key("Escape");
    expect(document.querySelector(".tour")).toBeNull();
    expect(tourDone()).toBe(true);
  });

  it("gives the focus back to where it was", () => {
    const a = document.getElementById("a")!;
    a.focus();
    startTour(steps, labels);
    skipButton().click();
    expect(document.activeElement).toBe(a);
  });

  it("a step whose part is not on the page still shows its bubble", () => {
    startTour([{ at: "#missing", title: "M", text: "nowhere" }], labels);
    expect(bubble()!.querySelector("p")!.textContent).toBe("nowhere");
  });

  it("one tour at a time; the returned function closes it without marking it done", () => {
    const close = startTour(steps, labels);
    startTour(steps, labels);
    expect(document.querySelectorAll(".tour").length).toBe(1);
    close();
    expect(document.querySelector(".tour")).toBeNull();
    expect(tourDone()).toBe(false);
  });
});

describe("the tour on the home", () => {
  const strings: Record<string, string> = {
    "station.tour": "使い方",
    "station.tourNext": "次へ",
    "station.tourEnd": "はじめる",
    "station.tourSkip": "とばす",
    "station.tour1Title": "スイッチ",
    "station.tour1": "スイッチを入れると、世界のどこかの誰かのお便りが流れます。サインインは要りません",
    "station.tour2Title": "ダイヤル",
    "station.tour2": "近く・遠く。好みに近いお便りか、少し遠くのお便りか。お便りを 3 通送ると効きはじめます",
    "station.tour3Title": "いま流れている",
    "station.tour3": "流れているお便りに「私も」と一言を返せます。",
    "station.tour4Title": "オンエア",
    "station.tour4": "いま流れているお便りと、このあとのお便り",
    "station.tour5Title": "サインイン",
    "station.tour5": "Google でサインインすると、お便りを送れて、自分のラジオと公開の URL が持てます",
    "station.tour5InTitle": "お便りを送る",
    "station.tour5In": "ここからお便りを送れます。送ったお便りはマイページに並びます",
  };
  const opts = (over: Partial<StationOptions> = {}): StationOptions => ({ stationKey: "mine", label: "あなたのラジオ", nextUrl: "/stations/mine/next", resumeUrl: "/stations/mine.json", ttsUrl: null, voiceURI: "", dial: 0.3, send: true, strings, ...over });
  let fetchSpy: ReturnType<typeof vi.fn>;
  let station: { unmount(): void; state(): { power: string } } | null;
  const SIGNIN = '<header class="site-header"><nav><a href="/auth/google?next=%2F">Google でサインイン</a></nav></header>';
  const mount = (over: Partial<StationOptions> = {}, header = SIGNIN) => {
    document.body.innerHTML = `${header}<div id="station"></div>`;
    station = mountStation(document.getElementById("station")!, opts(over));
    return station;
  };
  const text = () => bubble()?.querySelector("p")?.textContent;
  const walk = () => {
    const seen: string[] = [];
    while (bubble()) {
      seen.push(text()!);
      nextButton().click();
    }
    return seen;
  };

  beforeEach(() => {
    fetchSpy = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal("speechSynthesis", { speak: vi.fn(), cancel: vi.fn(), pause: vi.fn(), resume: vi.fn(), getVoices: () => [], addEventListener: () => {}, removeEventListener: () => {} });
    history.replaceState(null, "", "/");
    station = null;
  });
  afterEach(() => station?.unmount());

  it("opens on a first visit: what works without an account first, sign-in last; no audio, nothing fetched", () => {
    mount();
    expect(walk()).toEqual([strings["station.tour1"], strings["station.tour2"], strings["station.tour3"], strings["station.tour4"], strings["station.tour5"]]);
    expect(tourDone()).toBe(true);
    expect(station!.state().power).toBe("off");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(globalThis.speechSynthesis.speak).not.toHaveBeenCalled();
  });

  it("signed in, the last step is on the send panel and says so", () => {
    mount({}, "");
    const seen = walk();
    expect(seen.at(-1)).toBe(strings["station.tour5In"]);
    expect(seen).not.toContain(strings["station.tour5"]);
  });

  it("a returning visitor gets no tour; ?tour=1 opens it again", () => {
    localStorage.setItem(TOUR_KEY, "done");
    mount();
    expect(bubble()).toBeNull();
    station!.unmount();
    history.replaceState(null, "", "/?tour=1");
    mount();
    expect(text()).toBe(strings["station.tour1"]);
    // The flag is dropped from the address, so a reload does not open it again.
    expect(location.search).toBe("");
  });

  it("a first visit through a letter link is left to the letter; the tour waits for the next visit", () => {
    mount({ letterId: "L1" });
    expect(bubble()).toBeNull();
    expect(localStorage.getItem(TOUR_KEY)).toBeNull();
    station!.unmount();
    history.replaceState(null, "", "/?tour=1");
    mount({ letterId: "L1" });
    expect(text()).toBe(strings["station.tour1"]);
  });

  it("step 3 rings the on-air heading while the card is not on the page, the now-playing card when it is", () => {
    mount();
    nextButton().click();
    nextButton().click();
    expect(text()).toBe(strings["station.tour3"]);
    const hole = document.querySelector(".tour-hole")!;
    expect(hole.classList.contains("none")).toBe(false);
    const at = vi.spyOn(document.querySelector(".on-air h2")!, "getBoundingClientRect");
    window.dispatchEvent(new Event("resize"));
    expect(at).toHaveBeenCalled();
    skipButton().click();
    station!.unmount();
    document.body.innerHTML = '<section class="now panel"></section><aside><section class="panel on-air"><h2>オンエア</h2></section></aside>';
    const steps = [{ at: ".now, .on-air h2", title: "t", text: "x" }];
    const card = vi.spyOn(document.querySelector(".now")!, "getBoundingClientRect");
    startTour(steps, labels);
    expect(card).toHaveBeenCalled();
  });

  it("the quiet 使い方 on the face opens it again", () => {
    localStorage.setItem(TOUR_KEY, "done");
    mount();
    const again = document.querySelector<HTMLButtonElement>(".face button.tour-again")!;
    expect(again.textContent).toBe("使い方");
    again.click();
    expect(text()).toBe(strings["station.tour1"]);
  });

  it("not on other radios, and not while the send modal is open", () => {
    mount({ send: false, stationKey: "world" });
    expect(bubble()).toBeNull();
    expect(document.querySelector(".tour-again")).toBeNull();
    station!.unmount();
    mount({}, `${SIGNIN}<dialog class="send-modal" open></dialog>`);
    expect(bubble()).toBeNull();
  });

  it("unmounting the radio takes the tour away without marking it done", () => {
    mount();
    station!.unmount();
    station = null;
    expect(document.querySelector(".tour")).toBeNull();
    expect(tourDone()).toBe(false);
  });
});
