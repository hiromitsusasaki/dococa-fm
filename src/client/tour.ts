/**
 * The home's first-visit tour: a dim overlay with a cut-out around one part of the page and a bubble with a title and one sentence.
 * 「次へ」 (or Enter) goes on, 「とばす」 (or Escape) ends it; either way it ends with `dfm.tour = "done"`. It only points: it never
 * presses anything, so it never starts the radio. Nothing in it moves under reduced motion (the CSS drops the transition).
 */
export type TourStep = { at: string; title: string; text: string };
export type TourLabels = { next: string; end: string; skip: string; label: string };

export const TOUR_KEY = "dfm.tour";

export const tourDone = (): boolean => {
  try {
    return localStorage.getItem(TOUR_KEY) === "done";
  } catch {
    return false;
  }
};

/** Space between a part and the edge of its cut-out, and between the cut-out and the bubble. */
const PAD = 6;
const GAP = 12;
const EDGE = 16;

let close: (() => void) | null = null;

/** Opens the tour, or keeps the one already open. The returned function takes it away without marking it done (the radio was unmounted). */
export function startTour(steps: TourStep[], labels: TourLabels, doc: Document = document): () => void {
  if (close) return close;
  if (steps.length === 0) return () => {};
  const back = doc.activeElement as HTMLElement | null;
  const box = doc.createElement("div");
  box.className = "tour";
  // Fixed markup only; every text goes in through textContent.
  box.innerHTML = '<div class="tour-hole"></div><div class="tour-bubble" role="dialog" aria-modal="true"><h2></h2><p></p><div class="tour-actions"><button type="button" class="quiet" data-tour-skip></button><button type="button" class="pill hot" data-tour-next></button></div></div>';
  const hole = box.firstElementChild as HTMLElement;
  const bubble = box.lastElementChild as HTMLElement;
  const [skip, next] = bubble.querySelectorAll("button");
  bubble.setAttribute("aria-label", labels.label);
  skip!.textContent = labels.skip;
  let i = 0;

  /** The cut-out around the step's part, and the bubble below it (above when there is no room below), kept inside the viewport. */
  const place = () => {
    const r = doc.querySelector(steps[i]!.at)?.getBoundingClientRect();
    const [vw, vh, bw, bh] = [innerWidth, innerHeight, bubble.offsetWidth, bubble.offsetHeight];
    // No part on the page (the card shows only while a letter plays): the whole page dims and the bubble sits in the middle.
    const [t, l, w, h] = r ? [r.top - PAD, r.left - PAD, r.width + 2 * PAD, r.height + 2 * PAD] : [vh / 3, vw / 2, 0, 0];
    Object.assign(hole.style, { top: `${t}px`, left: `${l}px`, width: `${w}px`, height: `${h}px` });
    hole.classList.toggle("none", !r);
    const below = t + h + GAP;
    const top = below + bh <= vh || t - GAP - bh < 0 ? below : t - GAP - bh;
    bubble.style.top = `${Math.max(EDGE, Math.min(top, vh - bh - EDGE))}px`;
    bubble.style.left = `${Math.max(EDGE, Math.min(r ? l : (vw - bw) / 2, vw - bw - EDGE))}px`;
  };

  /** The part goes to the upper quarter of the window, so the bubble fits below it (also on a phone). Instant: nothing slides. */
  const reach = () => {
    const top = doc.querySelector(steps[i]!.at)?.getBoundingClientRect().top;
    if (top !== undefined) scrollBy({ top: top - innerHeight / 4, behavior: "instant" });
    place();
  };

  const show = () => {
    const s = steps[i]!;
    bubble.querySelector("h2")!.textContent = s.title;
    bubble.querySelector("p")!.textContent = s.text;
    next!.textContent = i === steps.length - 1 ? labels.end : labels.next;
    reach();
    next!.focus();
  };

  const end = (done: boolean) => {
    close = null;
    if (done)
      try {
        localStorage.setItem(TOUR_KEY, "done");
      } catch {}
    box.remove();
    removeEventListener("resize", place);
    removeEventListener("load", reach);
    removeEventListener("scroll", place, true);
    doc.removeEventListener("keydown", key, true);
    back?.focus?.();
  };
  const step = () => (++i < steps.length ? show() : end(true));

  function key(e: KeyboardEvent) {
    if (e.key === "Escape") end(true);
    else if (e.key === "Enter" && e.target !== skip) step();
    else if (e.key === "Tab") (doc.activeElement === next ? skip : next)!.focus();
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  next!.addEventListener("click", step);
  skip!.addEventListener("click", () => end(true));
  // The page may still move under it (pictures, fonts, a restored scroll): reach the part again once they are in.
  addEventListener("resize", place);
  addEventListener("load", reach);
  addEventListener("scroll", place, true);
  doc.addEventListener("keydown", key, true);
  doc.body.append(box);
  show();
  close = () => end(false);
  return close;
}
