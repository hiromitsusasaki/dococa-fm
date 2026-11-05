import { accessToken, parseServiceAccount, type ServiceAccount } from "../../src/worker/tts/google-auth";

const pem = (der: ArrayBuffer): string => {
  const b64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  return `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
};

/** A throwaway RSA key and the service account that holds it. */
export async function makeServiceAccount(email = "tts@test-project.iam.gserviceaccount.com") {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const privateKey = pem((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  const sa: ServiceAccount = { client_email: email, private_key: privateKey, project_id: "test-project" };
  return { sa, json: JSON.stringify(sa), publicKey: pair.publicKey };
}

/** Puts a token in the isolate cache so route tests need not stub the token endpoint. */
export async function primeToken(saJson: string, token = "tok-test"): Promise<void> {
  const stub = (async () => new Response(JSON.stringify({ access_token: token, expires_in: 3600 }))) as typeof fetch;
  await accessToken(parseServiceAccount(saJson), stub);
}
