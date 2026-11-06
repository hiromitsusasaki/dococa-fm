/** A whole number from an env value; `0` means paused, and a missing or invalid value falls back to the default. */
export function limitFrom(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
