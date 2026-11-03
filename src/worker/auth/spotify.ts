import { upsertHistory } from "../db/history";
import { updateListener } from "../db/listeners";
import type { Env } from "../env";
import { type ItemDraft, resolveOrCreate, sameArtist, searchByText } from "../resolve";
import type { HistoryRow, Listener } from "../types";
import { decryptSecret, encryptSecret, toBase64Url } from "./crypto";

export const SPOTIFY_SCOPE = "user-top-read user-read-recently-played user-library-read";
const AUTHORIZE_URL = "https://accounts.spotify.com/authorize";
const TOKEN_URL = "https://accounts.spotify.com/api/token";
const API = "https://api.spotify.com/v1";
/** A Worker request may make only so many subrequests: 1 token + 3 reads + one iTunes search per track must fit. */
const MAX_TRACKS = 40;

export const redirectUri = (env: Env): string => `${env.PUBLIC_ORIGIN}/auth/spotify/callback`;

export type Pkce = { verifier: string; challenge: string; state: string };

const randomToken = (): string => toBase64Url(crypto.getRandomValues(new Uint8Array(32)));

export async function createPkce(): Promise<Pkce> {
  const verifier = randomToken();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: toBase64Url(new Uint8Array(digest)), state: randomToken() };
}

export function authorizeUrl(env: Env, challenge: string, state: string): string {
  const qs = new URLSearchParams({
    client_id: env.SPOTIFY_CLIENT_ID,
    response_type: "code",
    redirect_uri: redirectUri(env),
    scope: SPOTIFY_SCOPE,
    code_challenge_method: "S256",
    code_challenge: challenge,
    state,
  });
  return `${AUTHORIZE_URL}?${qs}`;
}

type TokenResponse = { access_token?: string; refresh_token?: string };

async function postToken(params: Record<string, string>): Promise<TokenResponse | null> {
  try {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    });
    return res.ok ? ((await res.json()) as TokenResponse) : null;
  } catch {
    return null;
  }
}

/** Trades the one-time code for tokens. Null when Spotify refuses or the reply has no refresh token. */
export async function exchangeCode(env: Env, code: string, verifier: string): Promise<{ refreshToken: string } | null> {
  const body = await postToken({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(env),
    client_id: env.SPOTIFY_CLIENT_ID,
    code_verifier: verifier,
  });
  return body?.refresh_token ? { refreshToken: body.refresh_token } : null;
}

type SpotifyTrack = {
  id?: string | null;
  name?: string;
  artists?: { name?: string }[];
  album?: { release_date?: string; images?: { url?: string; width?: number }[] };
  external_urls?: { spotify?: string };
};
type Entry = { track: SpotifyTrack; at: string | null };

async function readTracks(path: string, token: string, pick: (item: any) => Entry | null): Promise<Entry[]> {
  try {
    const res = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) {
      console.warn(`[dococa] spotify ${path.split("?")[0]} returned ${res.status}; skipping it`);
      return [];
    }
    const body = (await res.json()) as { items?: unknown[] };
    return (body.items ?? []).flatMap((item) => pick(item) ?? []);
  } catch {
    console.warn(`[dococa] spotify ${path.split("?")[0]} failed; skipping it`);
    return [];
  }
}

const isoOrNull = (s: unknown): string | null => {
  if (typeof s !== "string") return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/** Unique tracks by Spotify id, top first, then recently played, then saved. A later entry may only add a time. */
function uniqueTracks(lists: Entry[][]): Entry[] {
  const seen = new Map<string, Entry>();
  for (const e of lists.flat()) {
    const id = e.track.id;
    if (!id || !e.track.name) continue;
    const prior = seen.get(id);
    if (!prior) seen.set(id, { ...e });
    else if (prior.at === null) prior.at = e.at;
  }
  return [...seen.values()].slice(0, MAX_TRACKS);
}

function draftFromSpotify(t: SpotifyTrack): ItemDraft {
  const images = [...(t.album?.images ?? [])].sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
  const year = Number((t.album?.release_date ?? "").slice(0, 4));
  return {
    kind: "music",
    title: t.name ?? "",
    creator: (t.artists ?? []).map((a) => a.name ?? "").filter(Boolean).join(", "),
    year: Number.isInteger(year) && year > 0 ? year : null,
    imageUrl: images[0]?.url ?? null,
    previewUrl: null,
    outLinks: {},
    externalIds: {},
  };
}

/** Prefers iTunes' record (it has a preview) when it names the same artist, and always keeps the Spotify id first. */
async function draftFor(env: Env, t: SpotifyTrack): Promise<ItemDraft> {
  const first = t.artists?.[0]?.name ?? "";
  const hits = await searchByText(`${t.name} ${first}`.trim(), "music", env);
  const found = first ? hits.find((h) => sameArtist(h.creator, first)) : undefined;
  const base = found ?? draftFromSpotify(t);
  const link = t.external_urls?.spotify;
  return {
    ...base,
    outLinks: { ...base.outLinks, ...(link ? { spotify: link } : {}) },
    externalIds: { spotify: t.id as string, ...base.externalIds },
  };
}

/** Reads what the person plays on Spotify into their history. Returns how many rows were written; 0 when it cannot. */
export async function importSpotifyHistory(env: Env, db: D1Database, listener: Listener): Promise<number> {
  if (!listener.spotifyRefreshToken) return 0;
  let refresh: string;
  try {
    refresh = await decryptSecret(listener.spotifyRefreshToken, env.SESSION_SECRET);
  } catch {
    console.warn("[dococa] stored spotify token cannot be decrypted; skipping import");
    return 0;
  }
  const token = await postToken({ grant_type: "refresh_token", refresh_token: refresh, client_id: env.SPOTIFY_CLIENT_ID });
  if (!token?.access_token) {
    console.warn("[dococa] spotify token refresh failed; skipping import");
    return 0;
  }
  if (token.refresh_token && token.refresh_token !== refresh) {
    await updateListener(db, listener.id, { spotifyRefreshToken: await encryptSecret(token.refresh_token, env.SESSION_SECRET) });
  }

  const access = token.access_token;
  const lists = [
    await readTracks("/me/top/tracks?limit=50&time_range=long_term", access, (t) => ({ track: t, at: null })),
    await readTracks("/me/player/recently-played?limit=50", access, (i) => ({ track: i?.track, at: isoOrNull(i?.played_at) })),
    await readTracks("/me/tracks?limit=50", access, (i) => ({ track: i?.track, at: isoOrNull(i?.added_at) })),
  ].map((l) => l.filter((e) => e.track));
  const entries = uniqueTracks(lists);

  const drafts = await Promise.all(entries.map((e) => draftFor(env, e.track)));
  const rows: HistoryRow[] = [];
  for (const [i, draft] of drafts.entries()) {
    const item = await resolveOrCreate(db, draft);
    rows.push({ listenerId: listener.id, itemId: item.id, source: "spotify", occurredAt: entries[i]!.at });
  }
  // Two Spotify tracks can resolve to one stored item; the batch upsert must not see the same key twice.
  const byItem = new Map(rows.map((r) => [r.itemId, r]));
  await upsertHistory(db, [...byItem.values()]);
  return byItem.size;
}
