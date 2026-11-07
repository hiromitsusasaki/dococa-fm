import { z } from "zod";
import { COUNTRIES } from "./geo/places";
import { isValidRegion, placeLabel } from "./geo/place-label";
import { looksLikeContact } from "./program/pii-patterns";
import type { Listener } from "./types";

/**
 * A listener's radio name and place, as `/settings` and a reply's optional name take them. The DJ says them aloud, so the name may not
 * be an address, a phone number or a url; an empty country means no place, and the region has to belong to the country.
 */
export const profileFields = {
  radioName: z.string().trim().max(20).refine((s) => !looksLikeContact(s)),
  placeCountry: z.string().trim().refine((v) => v === "" || COUNTRIES.some((c) => c.code === v)).default(""),
  placeRegion: z.string().trim().default(""),
};

export type Profile = { radioName: string; placeCountry: string; placeRegion: string };

export const isValidPlace = (v: { placeCountry: string; placeRegion: string }) => isValidRegion(v.placeCountry, v.placeRegion);

const placeColumns = (placeCountry: string, placeRegion: string): Partial<Listener> => ({ placeCountry: placeCountry || null, placeRegion: placeRegion || null, place: placeLabel(placeCountry || null, placeRegion || null, "ja") });

/** `/settings`, whose selects show the current place: an old free-text place stays until a country is chosen; choosing "none" afterwards clears it. */
export function profilePatch(listener: Pick<Listener, "placeCountry">, { placeCountry, placeRegion, radioName }: Profile): Partial<Listener> {
  return { radioName, ...(placeCountry === "" && listener.placeCountry === null ? {} : placeColumns(placeCountry, placeRegion)) };
}

/** A reply's optional line, which starts empty: the place is written only when a country is sent, so adding a name keeps a place set before. */
export function replyProfilePatch({ placeCountry, placeRegion, radioName }: Profile): Partial<Listener> {
  return { radioName, ...(placeCountry ? placeColumns(placeCountry, placeRegion) : {}) };
}
