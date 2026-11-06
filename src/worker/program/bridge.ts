import { t } from "../i18n/t";
import type { Lang } from "../i18n/t";
import type { ScriptLine } from "../types";
import type { Slot } from "./select";
import type { StationKey } from "./station";

export type BridgeKey = "bridge.open" | "bridge.near" | "bridge.neighbor" | "bridge.far" | "bridge.next" | "bridge.sameWork" | "bridge.close";

export const BRIDGE_KEYS: readonly BridgeKey[] = ["bridge.open", "bridge.near", "bridge.neighbor", "bridge.far", "bridge.next", "bridge.sameWork", "bridge.close"];

/**
 * The bridge before segment `index` of a programme: `open` for the first; on a public station the neutral
 * `next` (every work there is the owner's favourite, not the visitor's); else by slot.
 */
export function bridgeBefore(index: number, slot: Slot, station: StationKey["kind"]): BridgeKey {
  if (index === 0) return "bridge.open";
  if (station === "public") return "bridge.next";
  return `bridge.${slot}`;
}

/** A transition made from a template alone, never from the model. */
export const bridgeLine = (key: BridgeKey, lang: Lang): ScriptLine => ({ type: "dj", text: t(key, undefined, lang), fixed: true, bridge: key });
