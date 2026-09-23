import { ACCESS } from "./limits";
import { sha256Hex, timingSafeEqual } from "./token";

// Worker secrets (set with `wrangler secret put`):
//   ACCESS_KEY  shared key; anyone holding it can create sync groups
//   ADMIN_KEY   enables /v2/admin, which issues per-user access keys
// With neither configured, no sync group can be created.

export function configuredSecret(value: string | undefined): string | null {
  return typeof value === "string" && value.length >= ACCESS.minSecretLength ? value : null;
}

export async function secretMatches(candidate: string, secret: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256Hex(candidate), sha256Hex(secret)]);
  return timingSafeEqual(a, b);
}

export type AccessDecision =
  | { kind: "master" }
  | { kind: "issued"; keyHash: string }
  | { kind: "denied"; status: number; error: string };

export async function decideAccess(env: Env, presented: unknown): Promise<AccessDecision> {
  const master = configuredSecret(env.ACCESS_KEY);
  const admin = configuredSecret(env.ADMIN_KEY);
  if (!master && !admin) return { kind: "denied", status: 403, error: "access_key_not_configured" };
  if (typeof presented !== "string" || !presented.trim()) {
    return { kind: "denied", status: 401, error: "access_key_required" };
  }
  const key = presented.trim();
  if (master && (await secretMatches(key, master))) return { kind: "master" };
  if (admin && key.startsWith(ACCESS.keyPrefix)) return { kind: "issued", keyHash: await sha256Hex(key) };
  return { kind: "denied", status: 403, error: "invalid_access_key" };
}

export async function isAdmin(env: Env, request: Request): Promise<boolean | null> {
  const admin = configuredSecret(env.ADMIN_KEY);
  if (!admin) return null;
  const header = request.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) return false;
  return secretMatches(header.slice(7).trim(), admin);
}
