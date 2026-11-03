import { ja } from "./ja";

export function t(key: keyof typeof ja): string {
  return ja[key];
}
