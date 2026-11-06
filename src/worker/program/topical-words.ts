/** Words that tie a line to the day it was written. The DJ never says them, and neither do the questions. */
export const TOPICAL = new RegExp(
  [
    // the day, the week, the year it was said
    "今日|今朝|今夜|昨夜|昨晩|昨日|明日|先日|今週|先週|来週|今月|先月|来月|今年|去年|昨年|来年|最近|近頃|このところ",
    // news and fashion
    "ニュース|速報|流行|トレンド|バズ|話題の|話題に",
    // what is on sale or on air right now
    "公開中|上映中|発売中|配信中|放送中|配信開始|発売開始|新作|最新作|ただいま|只今",
    // dates and eras
    "[0-9０-９]{4}年|(?:昭和|平成|令和)[0-9０-９元]+年|令和|平成[0-9]",
    // seasons and calendar events
    "新年|正月|年末|年始|年の瀬|お盆|ゴールデンウィーク|夏休み|冬休み|春休み|クリスマス|ハロウィン|バレンタイン|この(?:春|夏|秋|冬)|今(?:春|夏|秋|冬)|今季|今シーズン",
    // events
    "選挙|オリンピック|ワールドカップ",
  ].join("|"),
  "u",
);

export function containsTopical(text: string): boolean {
  return TOPICAL.test(text);
}

/**
 * Masks the digits of years that come from the data (the work's, a letter's) so they pass `TOPICAL`;
 * only the digits, so 「2016年末」 still reads as 年末, and 「12016年」 is left alone.
 */
export function maskDataYears(text: string, years: Iterable<number>): string {
  let out = text;
  for (const y of years) out = out.replace(new RegExp(`(?<![0-9０-９])${y}(?=年)`, "gu"), "〇");
  return out;
}
