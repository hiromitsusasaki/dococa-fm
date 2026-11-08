const NONE_MS = 3000;

/**
 * The send page's "ask the DJ back" button: the draft in the textarea goes to `POST /put/ask` and the one question that
 * comes back shows in `p.put-askback` above it. A failure or no question shows the page's `data-none` text for 3 seconds.
 * The draft is only sent, never kept (no storage, no log). Works the same inside the home's `embed=1` frame.
 */
export function wirePut(doc: Document = document): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const click = async (e: MouseEvent) => {
    const button = (e.target as Element | null)?.closest?.<HTMLButtonElement>("button.put-ask");
    const form = button?.closest("form");
    if (!button || !form || button.disabled) return;
    const out = form.querySelector<HTMLElement>(".put-askback");
    const itemId = form.querySelector<HTMLInputElement>('input[name="itemId"]')?.value ?? "";
    const draft = form.querySelector<HTMLTextAreaElement>('textarea[name="body"]')?.value.trim() ?? "";
    if (!out) return;
    clearTimeout(timer);
    const show = (text: string, temporary: boolean) => {
      out.textContent = text;
      out.hidden = false;
      if (temporary) timer = setTimeout(() => (out.hidden = true), NONE_MS);
    };
    const none = () => show(out.dataset.none ?? "", true);
    if (!itemId || !draft) return none();
    button.disabled = true;
    try {
      const res = await fetch(button.dataset.askUrl ?? "/put/ask", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ itemId, draft }),
      });
      const question = res.ok ? ((await res.json()) as { question?: unknown }).question : null;
      if (typeof question === "string" && question !== "") show(question, false);
      else none();
    } catch {
      none();
    } finally {
      button.disabled = false;
    }
  };
  doc.addEventListener("click", click);
  return () => {
    clearTimeout(timer);
    doc.removeEventListener("click", click);
  };
}
