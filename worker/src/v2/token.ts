const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SECRET_RE = /^[0-9a-f]{64}$/;

export interface DeviceToken {
  pairId: string;
  deviceId: string;
  secret: string;
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export function makeToken(pairId: string, deviceId: string, secret: string): string {
  return `v2.${pairId}.${deviceId}.${secret}`;
}

export function parseToken(value: string | null | undefined): DeviceToken | null {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== "v2") return null;
  const [, pairId, deviceId, secret] = parts;
  if (!isUuid(pairId) || !isUuid(deviceId) || !SECRET_RE.test(secret)) return null;
  return { pairId, deviceId, secret };
}

export function bearerToken(request: Request): DeviceToken | null {
  const header = request.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return parseToken(header.slice(7).trim());
}

export function randomHex(bytes: number): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(buf, b => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
