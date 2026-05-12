import { IRequest } from "itty-router";
import { generatePairingCode, hashCode, newDeviceToken, newId } from "../utils/crypto";

export async function handleGeneratePair(request: IRequest, env: Env): Promise<Response> {
  const body = await request.json() as { device_name?: string; browser?: string };
  const code = generatePairingCode();
  const codeHash = await hashCode(code);
  const pairId = newId();
  const deviceId = newId();
  const deviceToken = newDeviceToken();
  const tokenHash = await hashCode(deviceToken);
  const now = Date.now();

  const pairTTL = 3600; // 1 hour TTL for pairing code
  await env.BOOKMARKS_KV.put(`pair:${codeHash}`, pairId, { expirationTtl: pairTTL });

  await env.DB.prepare(
    "INSERT INTO pairs (id, code_hash, created_at) VALUES (?, ?, ?)"
  ).bind(pairId, codeHash, now).run();

  await env.DB.prepare(
    "INSERT INTO devices (id, pair_id, browser, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(deviceId, pairId, body.browser ?? "unknown", body.device_name ?? null, tokenHash, now).run();

  return Response.json({ code, pair_id: pairId, device_id: deviceId, device_token: deviceToken });
}

export async function handleJoinPair(request: IRequest, env: Env): Promise<Response> {
  const body = await request.json() as { code: string; device_name?: string; browser?: string };
  if (!body.code || body.code.length !== 6) {
    return Response.json({ error: "Invalid pairing code" }, { status: 400 });
  }

  const codeHash = await hashCode(body.code);
  const pairId = await env.BOOKMARKS_KV.get(`pair:${codeHash}`);

  if (!pairId) {
    return Response.json({ error: "Pairing code not found or expired" }, { status: 404 });
  }

  const deviceId = newId();
  const deviceToken = newDeviceToken();
  const tokenHash = await hashCode(deviceToken);
  const now = Date.now();

  await env.DB.prepare(
    "INSERT INTO devices (id, pair_id, browser, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(deviceId, pairId, body.browser ?? "unknown", body.device_name ?? null, tokenHash, now).run();

  return Response.json({ pair_id: pairId, device_id: deviceId, device_token: deviceToken, code: body.code });
}

export async function handleGetPairInfo(request: IRequest, env: Env): Promise<Response> {
  const pairId = request.query.pair_id as string;
  if (!pairId) {
    return Response.json({ error: "Missing pair_id" }, { status: 400 });
  }

  const devices = await env.DB.prepare(
    "SELECT id, browser, name, created_at FROM devices WHERE pair_id = ?"
  ).bind(pairId).all();

  return Response.json({ pair_id: pairId, devices: devices.results });
}
