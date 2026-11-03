/** Words that tie a line to the day it was written. The DJ never says them, and neither do the questions. */
export const TOPICAL =
  /今日|今年|今週|今月|最近|ニュース|速報|流行|トレンド|バズ|20[0-9]{2}年|令和|平成[0-9]|新年|クリスマス|ハロウィン|正月|夏休み|選挙|オリンピック|ワールドカップ|今朝|今夜|昨日|明日/u;

export function containsTopical(text: string): boolean {
  return TOPICAL.test(text);
}
