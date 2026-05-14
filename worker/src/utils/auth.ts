import { IRequest } from "itty-router";
import { hashCode } from "./crypto";

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function readDeviceToken(request: IRequest, url: URL): string | null {
  const auth = request.headers.get("Authorization");
  if (auth?.startsWith("Bearer ")) {
    const value = auth.slice(7).trim();
    if (value) return value;
  }
  return url.searchParams.get("device_token");
}

export async function validateDevice(
  env: Env,
  pairId: string | null,
  deviceId: string | null,
  deviceToken: string | null,
): Promise<boolean> {
  if (!pairId || !deviceId || !deviceToken) return false;

  const row = await env.DB.prepare(
    "SELECT token_hash FROM devices WHERE id = ? AND pair_id = ?"
  ).bind(deviceId, pairId).first<{ token_hash: string | null }>();

  if (!row?.token_hash) return false;
  const candidate = await hashCode(deviceToken);
  return timingSafeEqual(row.token_hash, candidate);
}

export async function validateRequest(
  env: Env,
  request: IRequest,
  url: URL,
): Promise<{ ok: true; pairId: string; deviceId: string } | { ok: false; status: number; error: string }> {
  const pairId = url.searchParams.get("pair_id");
  const deviceId = url.searchParams.get("device_id");
  const token = readDeviceToken(request, url);

  if (!pairId) return { ok: false, status: 400, error: "Missing pair_id" };
  if (!deviceId) return { ok: false, status: 400, error: "Missing device_id" };
  if (!token) return { ok: false, status: 401, error: "Missing device token" };

  const valid = await validateDevice(env, pairId, deviceId, token);
  if (!valid) return { ok: false, status: 401, error: "Unauthorized device" };

  return { ok: true, pairId, deviceId };
}
