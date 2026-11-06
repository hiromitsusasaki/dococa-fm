import { t } from "../i18n/t";
import type { Lang } from "../i18n/t";
import type { ScriptLine } from "../types";
import type { Slot } from "./select";

export type BridgeKey = "bridge.open" | "bridge.near" | "bridge.neighbor" | "bridge.far" | "bridge.sameWork" | "bridge.close";

export const BRIDGE_KEYS: readonly BridgeKey[] = ["bridge.open", "bridge.near", "bridge.neighbor", "bridge.far", "bridge.sameWork", "bridge.close"];

/** The bridge before segment `index` of a programme: `open` for the first, else by slot. */
export function bridgeBefore(index: number, slot: Slot): BridgeKey {
  if (index === 0) return "bridge.open";
  return `bridge.${slot}`;
}

/** A transition made from a template alone, never from the model. */
export const bridgeLine = (key: BridgeKey, lang: Lang): ScriptLine => ({ type: "dj", text: t(key, undefined, lang), fixed: true });
