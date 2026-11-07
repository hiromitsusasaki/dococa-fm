import { t } from "../i18n/t";
import type { Lang } from "../i18n/t";
import type { ScriptLine } from "../types";
import type { Slot } from "./select";
import type { StationKey } from "./station";

/** `sameWork` (a second letter about the same work) is gone: each letter airs in its own segment. Episodes stored before still carry its text. */
export type BridgeKey = "bridge.open" | "bridge.near" | "bridge.neighbor" | "bridge.far" | "bridge.next" | "bridge.close";

export const BRIDGE_KEYS: readonly BridgeKey[] = ["bridge.open", "bridge.near", "bridge.neighbor", "bridge.far", "bridge.next", "bridge.close"];

/**
 * The bridge before a segment: `open` when it is the first the listener hears on this visit; on a public station the
 * neutral `next` (every work there is the owner's favourite, not the visitor's); else by slot. `close` is no longer
 * said (a programme has no end the DJ can know); the key stays so stored episodes still render.
 */
export function bridgeBefore(first: boolean, slot: Slot, station: StationKey["kind"]): BridgeKey {
  if (first) return "bridge.open";
  if (station === "public") return "bridge.next";
  return `bridge.${slot}`;
}

/** A transition made from a template alone, never from the model. */
export const bridgeLine = (key: BridgeKey, lang: Lang): ScriptLine => ({ type: "dj", text: t(key, undefined, lang), fixed: true, bridge: key });
