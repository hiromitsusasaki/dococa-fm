/** Listener reactions sent from a player: 私も / 一言 as letters, and the dial setting. */

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

export function saveDial(value: string): void {
  void fetch("/settings/dial", { method: "POST", headers: FORM, body: new URLSearchParams({ dial: value }).toString() }).catch(() => {});
}

/** Hono maps onChange to the `input` event, which fires all through a drag; the dial is saved once, on release. */
export const onReleased = (save: (value: string) => void) => (el: HTMLInputElement | null) => {
  if (el) el.onchange = () => save(el.value);
};
