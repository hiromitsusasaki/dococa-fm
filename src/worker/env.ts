export type Env = {
  DB: D1Database;
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
  ANTHROPIC_API_KEY: string;
  SPOTIFY_CLIENT_ID: string;
  /** Gemini-TTS を呼ぶサービスアカウントの JSON を 1 行で。空ならクラウド TTS は無効 */
  GOOGLE_TTS_SA_JSON: string;
  TMDB_API_KEY: string;
  YOUTUBE_API_KEY: string;
  /** 任意: Google Books API のキー。無いと共有の無料枠で 429 になりやすい */
  GOOGLE_BOOKS_API_KEY?: string;
  ADMIN_TOKEN: string;
  SESSION_SECRET: string;
  EPISODE_DAILY_LIMIT?: string;
  EPISODE_GLOBAL_DAILY_LIMIT?: string;
  CLOUD_TTS_GLOBAL_DAILY_LIMIT?: string;
  RATE_LIMIT_PER_MINUTE?: string;
  CLAUDE_MODEL?: string;
  GEMINI_TTS_MODEL?: string;
  GEMINI_TTS_VOICE?: string;
  /** Where the app is served, e.g. https://dococa.example. Empty refuses every request (see `requirePublicOrigin`). */
  PUBLIC_ORIGIN: string;
  /** "1" lets letters through unjudged and untranslated when ANTHROPIC_API_KEY is empty. Local dev only. */
  DEV_SKIP_CLAUDE?: string;
};
