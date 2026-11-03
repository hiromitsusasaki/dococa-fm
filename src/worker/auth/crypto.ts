const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}

async function aesKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** AES-GCM with a fresh 12-byte IV per call, stored as base64url `iv.ciphertext`. */
export async function encryptSecret(plain: string, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(secret), encoder.encode(plain));
  return `${toBase64Url(iv)}.${toBase64Url(new Uint8Array(cipher))}`;
}

/** Throws when the text is malformed or the secret is not the one it was encrypted with. */
export async function decryptSecret(cipher: string, secret: string): Promise<string> {
  const [iv, body, ...rest] = cipher.split(".");
  if (!iv || !body || rest.length > 0) throw new Error("malformed ciphertext");
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64Url(iv) }, await aesKey(secret), fromBase64Url(body));
  return decoder.decode(plain);
}
