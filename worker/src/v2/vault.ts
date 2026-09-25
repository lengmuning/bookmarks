// Issued access keys are kept encrypted so the admin page can show them
// again. The AES-GCM key is derived from ADMIN_KEY: whoever can decrypt could
// sign in as admin anyway, and changing ADMIN_KEY makes old copies unreadable
// (those keys still work; they can only be reset to be shown again).

const encoder = new TextEncoder();

async function vaultKey(secret: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: encoder.encode("safari-bookmarks-sync/access-keys"), info: encoder.encode("v1") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text: string) => Uint8Array.from(atob(text), c => c.charCodeAt(0));

export async function sealKey(key: string, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await vaultKey(secret), encoder.encode(key));
  return `v1.${toBase64(iv)}.${toBase64(new Uint8Array(cipher))}`;
}

export async function openKey(sealed: string, secret: string): Promise<string | null> {
  const [version, iv, cipher] = sealed.split(".");
  if (version !== "v1" || !iv || !cipher) return null;
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(iv) }, await vaultKey(secret), fromBase64(cipher));
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

// "sbk_1a2b…9f0e": enough to tell keys apart, far too little to guess one
// (40 of the 48 hex digits stay hidden).
export const keyHint = (key: string) => `${key.slice(0, 8)}…${key.slice(-4)}`;
