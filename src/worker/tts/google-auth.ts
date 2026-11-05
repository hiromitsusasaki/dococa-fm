const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const TIMEOUT_MS = 10_000;
/** A token is replaced this long before it expires, so one never lapses in flight. */
const REFRESH_MARGIN_MS = 60_000;

export type ServiceAccount = { client_email: string; private_key: string; project_id: string };

const isFilled = (v: unknown): v is string => typeof v === "string" && v !== "";

/** Reads the service-account JSON. The message never carries the JSON: it holds the private key. */
export function parseServiceAccount(json: string): ServiceAccount {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("tts sa json invalid");
  }
  const { client_email, private_key, project_id } = (raw ?? {}) as Record<string, unknown>;
  if (!isFilled(client_email) || !isFilled(private_key) || !isFilled(project_id)) throw new Error("tts sa json invalid");
  return { client_email, private_key, project_id };
}

const base64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const encodeJson = (v: unknown): string => base64url(new TextEncoder().encode(JSON.stringify(v)));

function pemToDer(pem: string): Uint8Array {
  const b64 = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function signedAssertion(sa: ServiceAccount, iat: number): Promise<string> {
  const unsigned = `${encodeJson({ alg: "RS256", typ: "JWT" })}.${encodeJson({ iss: sa.client_email, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 })}`;
  const key = await crypto.subtle.importKey("pkcs8", pemToDer(sa.private_key), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${base64url(new Uint8Array(sig))}`;
}

const cache = new Map<string, { token: string; expiresAt: number }>();

export function resetTokenCache(): void {
  cache.clear();
}

/** An OAuth2 access token for `sa`, reused within this isolate until a minute before it expires. */
export async function accessToken(sa: ServiceAccount, fetchFn: typeof fetch = fetch, now: () => number = Date.now): Promise<string> {
  const hit = cache.get(sa.client_email);
  if (hit && now() < hit.expiresAt - REFRESH_MARGIN_MS) return hit.token;
  const issuedAt = now();
  const assertion = await signedAssertion(sa, Math.floor(issuedAt / 1000));
  const res = await fetchFn(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${assertion}`,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  // The status only: the body can echo the assertion.
  if (!res.ok) throw new Error(`tts token ${res.status}`);
  const { access_token, expires_in } = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!access_token) throw new Error("tts token empty");
  cache.set(sa.client_email, { token: access_token, expiresAt: issuedAt + (expires_in ?? 3600) * 1000 });
  return access_token;
}
