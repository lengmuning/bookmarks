import { IRequest } from "itty-router";
import { generatePairingCode, hashCode, newDeviceToken, newId } from "../utils/crypto";
import { bumpRateLimit, checkRateLimit, clientKey, resetRateLimit } from "../utils/rateLimit";
import { validateRequest } from "../utils/auth";
import { configuredSecret, secretMatches } from "../v2/access";

const PAIR_CODE_TTL_SEC = 3600;
const JOIN_RATE_LIMIT = 5;
const JOIN_RATE_WINDOW_SEC = 3600;

// v1 is kept for devices paired before v2. New groups need the master
// ACCESS_KEY here; per-user keys only work with /v2/pairs.
export async function handleGeneratePair(request: IRequest, env: Env): Promise<Response> {
  const master = configuredSecret(env.ACCESS_KEY);
  const presented = request.headers.get("X-Access-Key");
  if (!master || !presented || !(await secretMatches(presented, master))) {
    return Response.json(
      { error: "Creating sync groups with the v1 API needs the access key. Update to the v2 apps." },
      { status: 403 },
    );
  }

  const ip = clientKey(request as unknown as Request);
  const gate = await checkRateLimit(env, `gen:${ip}`, 20, 3600);
  if (!gate.ok) {
    return Response.json({ error: "Too many pairing codes generated. Try again later." }, { status: 429 });
  }
  await bumpRateLimit(env, `gen:${ip}`, 3600);

  const body = await request.json().catch(() => ({})) as { device_name?: string; browser?: string };
  const code = generatePairingCode();
  const codeHash = await hashCode(code);
  const pairId = newId();
  const deviceId = newId();
  const deviceToken = newDeviceToken();
  const tokenHash = await hashCode(deviceToken);
  const now = Date.now();

  await env.BOOKMARKS_KV.put(`pair:${codeHash}`, pairId, { expirationTtl: PAIR_CODE_TTL_SEC });

  await env.DB.prepare(
    "INSERT INTO pairs (id, code_hash, created_at) VALUES (?, ?, ?)"
  ).bind(pairId, codeHash, now).run();

  await env.DB.prepare(
    "INSERT INTO devices (id, pair_id, browser, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(deviceId, pairId, body.browser ?? "unknown", body.device_name ?? null, tokenHash, now).run();

  return Response.json({
    code,
    pair_id: pairId,
    device_id: deviceId,
    device_token: deviceToken,
    server_now: now,
    expires_in: PAIR_CODE_TTL_SEC,
  });
}

export async function handleJoinPair(request: IRequest, env: Env): Promise<Response> {
  const ip = clientKey(request as unknown as Request);
  const rateKey = `join:${ip}`;
  const gate = await checkRateLimit(env, rateKey, JOIN_RATE_LIMIT, JOIN_RATE_WINDOW_SEC);
  if (!gate.ok) {
    return Response.json(
      { error: "Too many attempts. Try again later." },
      { status: 429, headers: { "Retry-After": String(gate.retryAfterSec ?? JOIN_RATE_WINDOW_SEC) } }
    );
  }

  const body = await request.json().catch(() => ({})) as { code?: string; device_name?: string; browser?: string };
  const rawCode = (body.code ?? "").trim();
  if (!rawCode || rawCode.length !== 6 || !/^\d{6}$/.test(rawCode)) {
    await bumpRateLimit(env, rateKey, JOIN_RATE_WINDOW_SEC);
    return Response.json({ error: "Invalid pairing code" }, { status: 400 });
  }

  const codeHash = await hashCode(rawCode);
  const pairId = await env.BOOKMARKS_KV.get(`pair:${codeHash}`);

  if (!pairId) {
    await bumpRateLimit(env, rateKey, JOIN_RATE_WINDOW_SEC);
    return Response.json({ error: "Pairing code not found or expired" }, { status: 404 });
  }

  // Single-use: invalidate code immediately after successful join.
  await env.BOOKMARKS_KV.delete(`pair:${codeHash}`);
  await resetRateLimit(env, rateKey);

  const deviceId = newId();
  const deviceToken = newDeviceToken();
  const tokenHash = await hashCode(deviceToken);
  const now = Date.now();

  await env.DB.prepare(
    "INSERT INTO devices (id, pair_id, browser, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(deviceId, pairId, body.browser ?? "unknown", body.device_name ?? null, tokenHash, now).run();

  return Response.json({
    pair_id: pairId,
    device_id: deviceId,
    device_token: deviceToken,
    code: rawCode,
    server_now: now,
  });
}

export async function handleGetPairInfo(request: IRequest, env: Env): Promise<Response> {
  const auth = await validateRequest(env, request, new URL(request.url));
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const devices = await env.DB.prepare(
    "SELECT id, browser, name, created_at FROM devices WHERE pair_id = ?"
  ).bind(auth.pairId).all();

  return Response.json({ pair_id: auth.pairId, devices: devices.results, server_now: Date.now() });
}
