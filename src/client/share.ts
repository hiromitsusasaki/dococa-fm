/** The device's own share sheet, where the browser has one; elsewhere its button stays hidden and X and the copy button remain. */
export const canShare = (): boolean => typeof navigator !== "undefined" && typeof navigator.share === "function";

const TOAST_MS = 2500;
let toastEl: HTMLElement | null = null;
let toastTimer: ReturnType<typeof setTimeout> | undefined;

/** One `div.toast` at a time: a new message replaces the last, and it goes away after 2.5 s. */
export function toast(text: string) {
  clearToast();
  toastEl = document.createElement("div");
  toastEl.className = "toast";
  toastEl.setAttribute("role", "status");
  toastEl.textContent = text;
  document.body.append(toastEl);
  toastTimer = setTimeout(clearToast, TOAST_MS);
}

export function clearToast() {
  clearTimeout(toastTimer);
  toastEl?.remove();
  toastEl = null;
}

/** The link to the clipboard and a toast; where there is no clipboard, shown to copy by hand. */
function copy(url: string, done: string, label: string) {
  const ask = () => void prompt(label, url);
  if (!navigator.clipboard?.writeText) return ask();
  navigator.clipboard.writeText(url).then(() => toast(done), ask);
}

/**
 * `div.share` anywhere on the page: `[data-share]` (the URL; `data-text` the short text) opens the share sheet and is shown only
 * where it exists; `[data-copy]` (the URL; `data-copied` the toast) copies. A share sheet closed without sharing is no error.
 */
export function wireShare(doc: Document = document): () => void {
  if (canShare()) doc.querySelectorAll<HTMLElement>("[data-share][hidden]").forEach((b) => (b.hidden = false));
  const click = (e: MouseEvent) => {
    const b = (e.target as Element | null)?.closest?.<HTMLElement>("[data-share], [data-copy]");
    if (!b) return;
    const { share: url, text, copy: link, copied } = b.dataset;
    if (url !== undefined && canShare()) navigator.share({ title: "Dococa FM", text: text ?? "", url }).catch(() => {});
    else if (link !== undefined) copy(link, copied ?? "", b.textContent ?? "");
  };
  doc.addEventListener("click", click);
  return () => doc.removeEventListener("click", click);
}
