/**
 * The English counterparts of the Japanese rules in `verify.ts` and `topical-words.ts`, for English DJ lines.
 * Checked after titles and creators are masked, so a title such as "Tonight, Tonight" is not talk.
 */

/** Words that tie a line to the day it was said, the season, the news or what is out right now. */
export const TOPICAL_EN =
  /\b(today|tonight|this (morning|evening|week|month|year)|yesterday|tomorrow|recently|lately|these days|right now|currently|christmas|new year['’]?s?|halloween|summer vacation|news|trending|viral|out now|now streaming|just released|new release)\b/i;

/** A year said aloud; the work's and the letters' years are masked first (`maskDataYearsEn`). */
export const YEAR_EN = /\b(?:1[89]|20)\d{2}\b/;

/**
 * Counting people, letters, ranks, plays or works. One work does not count ("1 song", "one song"), and word
 * numerals are left alone ("two people falling in love"), as the Japanese rule leaves 「二人で」.
 */
export const MEASURE_EN =
  /\b\d+\s*(people|persons|listeners|letters|messages|fans)\b|\bnumber one\b|#\s?1\b|\btop\s+\d+\b|\branking\b|\b\d+\s*(songs|tracks|films|movies|books|albums)\b|\b\d[\d,]*\s*(plays|streams|views)\b|\b(\d[\d,]*|a|one)\s+(hundred|thousand|million|billion)\s+(people|listeners|fans|plays|streams|views|copies)\b|\b(hundreds|thousands|millions|billions) of (people|listeners|fans|plays|streams|views)\b/i;

/** Nothing is played on this radio: the DJ introduces and reads, never invites the listener to listen or watch. */
export const PLAYBACK_EN =
  /\b(let['’]?s (play|listen|hear|watch)|here it is|here['’]?s the (song|track|film|movie|book)|have a listen|take a listen|give it a (listen|watch|spin)|check it out|enjoy(!|\b)|play(ing)? it now|coming up next|without further ado)\b/i;

/** A non-fixed line that hands over to a letter's reader. */
export const ANNOUNCE_EN = /\bletter from\b|\bhere['’]?s a letter\b|\breads? (the|a) letter\b/i;

/** Masks the years that come from the data (the work's, a letter's) so they pass `YEAR_EN`. */
export function maskDataYearsEn(text: string, years: Iterable<number>): string {
  let out = text;
  for (const y of years) out = out.replace(new RegExp(`\\b${y}\\b`, "g"), "〇");
  return out;
}
