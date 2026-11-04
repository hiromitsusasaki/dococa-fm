export type Env = {
  DB: D1Database;
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
  ANTHROPIC_API_KEY: string;
  SPOTIFY_CLIENT_ID: string;
  GOOGLE_TTS_API_KEY: string;
  TMDB_API_KEY: string;
  YOUTUBE_API_KEY: string;
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
