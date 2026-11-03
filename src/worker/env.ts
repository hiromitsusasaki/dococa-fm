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
  CLAUDE_MODEL?: string;
  GEMINI_TTS_MODEL?: string;
  GEMINI_TTS_VOICE?: string;
  PUBLIC_ORIGIN: string;
};
