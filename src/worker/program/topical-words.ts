/** Words that tie a line to the day it was written. The DJ never says them, and neither do the questions. */
export const TOPICAL = new RegExp(
  [
    // the day, the week, the year it was said
    "今日|今朝|今夜|昨日|明日|今週|先週|来週|今月|先月|来月|今年|去年|昨年|来年|最近|近頃|このところ",
    // news and fashion
    "ニュース|速報|流行|トレンド|バズ|話題の|話題に",
    // dates and eras
    "20[0-9]{2}年|令和|平成[0-9]",
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
