import { ja } from "./ja";

type Key = keyof typeof ja;

/** `{name}` placeholders are replaced from params; nothing else is interpolated. */
export function t(key: Key, params?: Record<string, string>): string {
  const text: string = ja[key];
  return params ? text.replace(/\{(\w+)\}/g, (m, k: string) => params[k] ?? m) : text;
}
