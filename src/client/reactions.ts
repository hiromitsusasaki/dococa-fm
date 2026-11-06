/** Listener reactions sent from a player: 私も / 一言 as letters, and the dial kept in this browser. */

const FORM = { "content-type": "application/x-www-form-urlencoded" };

/** Posts a reaction letter. True when it was taken (a redirect, or 409 for a 私も already said). */
export async function postLetter(fields: Record<string, string>): Promise<boolean> {
  try {
    const res = await fetch("/letters", { method: "POST", headers: FORM, body: new URLSearchParams(fields).toString(), redirect: "manual" });
    // A successful post answers with a redirect; 409 means this person already said watashimo.
    return res.ok || res.type === "opaqueredirect" || res.status === 409 || (res.status >= 300 && res.status < 400);
  } catch {
    return false;
  }
}

/** The form fields and the `sent` key of a 私も or a 一言 on the letter being read; null for an empty reply. */
export function reactionOf(kind: "watashimo" | "reply", itemId: string | undefined, letterId: string | undefined, body = ""): { fields: Record<string, string>; key: string } | null {
  if (!itemId || !letterId) return null;
  if (kind === "watashimo") return { fields: { kind, itemId, parentLetterId: letterId }, key: `w:${letterId}` };
  return body.trim() === "" ? null : { fields: { kind, body, itemId, parentLetterId: letterId }, key: `r:${letterId}` };
}

const DIAL_KEY = "dfm.dial";
const DEFAULT_DIAL = 0.3;

const dialOf = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : Number.parseFloat(String(v ?? ""));
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
};

/** The dial lives in the browser and goes out with every request: the stored value, else the page's, else 0.3. */
export function loadDial(fallback?: number): number {
  try {
    const stored = dialOf(localStorage.getItem(DIAL_KEY));
    if (stored !== null) return stored;
  } catch {}
  return dialOf(fallback) ?? DEFAULT_DIAL;
}

/** Keeps a dial value; anything outside 0..1 is ignored. Returns the value kept, or null. */
export function storeDial(value: string | number): number | null {
  const v = dialOf(value);
  if (v === null) return null;
  try {
    localStorage.setItem(DIAL_KEY, String(v));
  } catch {}
  return v;
}

/** Hono maps onChange to the `input` event, which fires all through a drag; the dial is saved once, on release. */
export const onReleased = (save: (value: string) => void) => (el: HTMLInputElement | null) => {
  if (el) el.onchange = () => save(el.value);
};
