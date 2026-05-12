import { hashCode } from "./crypto";

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
  return row.token_hash === await hashCode(deviceToken);
}
