export const USER_AGENT = "DococaFM/0.1 (+https://dococa.fm)";
const TIMEOUT_MS = 8000;
const MAX_TEXT_BYTES = 512 * 1024;

/** Non-2xx is "not found" (null). Network errors and timeouts still throw; resolve/index.ts catches them. */
async function get(url: string, headers: Record<string, string> = {}): Promise<Response | null> {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, ...headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    await res.body?.cancel();
    return null;
  }
  return res;
}

export async function fetchJson<T>(url: string, headers?: Record<string, string>): Promise<T | null> {
  const res = await get(url, headers);
  if (!res) return null;
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** Reads at most the first 512 KB of the body, decoded as UTF-8. */
export async function fetchText(url: string): Promise<string | null> {
  const res = await get(url);
  if (!res) return null;
  const reader = res.body?.getReader();
  if (!reader) return (await res.text()).slice(0, MAX_TEXT_BYTES);
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (received < MAX_TEXT_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
  }
  await reader.cancel();
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(bytes.subarray(0, MAX_TEXT_BYTES));
}

export function yearOf(date: string | undefined | null): number | null {
  const m = /^(\d{4})/.exec(date ?? "");
  return m ? Number(m[1]) : null;
}
