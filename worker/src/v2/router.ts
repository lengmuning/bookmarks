import { applyCors } from "../utils/cors";
import { decideAccess, isAdmin } from "./access";
import { LIMITS } from "./limits";
import { formatPairingCode, normalizeDeviceName, normalizePlatform } from "./normalize";
import type { DeviceAuth, RpcResult } from "./SyncGroup";
import { bearerToken, isUuid, makeToken } from "./token";

const SMALL_BODY_BYTES = 64 * 1024;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

const fromRpc = (result: RpcResult): Response =>
  new Response(result.json, {
    status: result.status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

const bodyOf = (result: RpcResult): Record<string, unknown> => JSON.parse(result.json);

async function readText(request: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > maxBytes) return null;
  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > maxBytes) return null;
  return new TextDecoder().decode(buffer);
}

async function readSmallJson(request: Request): Promise<Record<string, unknown> | null> {
  const text = await readText(request, SMALL_BODY_BYTES);
  if (text === null) return null;
  if (!text.trim()) return {};
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function parseCount(value: string | null, fallback: number): number {
  if (value === null || !/^\d{1,15}$/.test(value)) return fallback;
  return Number(value);
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number | null {
  if (value === undefined || value === null) return fallback;
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : null;
}

const group = (env: Env, pairId: string) => env.SYNC_GROUP.get(env.SYNC_GROUP.idFromName(pairId));
const registry = (env: Env) => env.REGISTRY.get(env.REGISTRY.idFromName("global"));
const clientIp = (request: Request) => request.headers.get("CF-Connecting-IP") ?? "unknown";

export async function handleV2(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") return applyCors(request, new Response(null, { status: 204 }));
  try {
    const url = new URL(request.url);
    if (url.pathname === "/v2/ws") {
      const pairId = url.searchParams.get("pair");
      if (request.method !== "GET" || !isUuid(pairId)) return new Response("Unauthorized", { status: 401 });
      return await group(env, pairId).fetch(request);
    }
    if (url.pathname.startsWith("/v2/admin/")) return await admin(request, env, url);
    return applyCors(request, await route(request, env));
  } catch (err) {
    console.error("v2 request failed", err);
    return applyCors(request, json(500, { error: "internal_error" }));
  }
}

// One access key belongs to one user and one group: the first call creates
// the group, later calls (a reinstalled or new Mac, another browser) join it.
async function connect(request: Request, env: Env): Promise<Response> {
  const body = await readSmallJson(request);
  const platform = normalizePlatform(body?.platform);
  if (!body || !platform) return json(400, { error: "invalid_body" });

  const access = await decideAccess(env, body.access_key ?? request.headers.get("X-Access-Key"));
  if (access.kind === "denied") return json(access.status, { error: access.error });

  const candidate = crypto.randomUUID();
  const found = await registry(env).connectKey(access.kind === "issued" ? access.keyHash : null, candidate, clientIp(request));
  if (!found.ok) {
    return found.reason === "rate_limited"
      ? json(429, { error: "rate_limited" }, { "Retry-After": "3600" })
      : json(403, { error: found.reason });
  }
  const name = normalizeDeviceName(body.name);

  if (!found.created) {
    const added = await group(env, found.pairId).addDevice({ platform, name, replaceSafari: body.replace_safari === true });
    if (added.status !== 200) return fromRpc(added);
    const device = bodyOf(added);
    return json(200, {
      pair_id: found.pairId,
      device_id: String(device.device_id),
      token: makeToken(found.pairId, String(device.device_id), String(device.secret)),
      created: false,
      replaced_device: device.replaced,
      cursor: device.cursor,
    });
  }

  const init = await group(env, found.pairId).init({ pairId: found.pairId, platform, name, maxBookmarks: found.maxBookmarks });
  if (init.status !== 200) {
    await registry(env).releaseGroup(found.pairId);
    return fromRpc(init);
  }
  const created = bodyOf(init);
  const deviceId = String(created.device_id);
  const { code, expiresAt } = await registry(env).issueCode(found.pairId);
  return json(200, {
    pair_id: found.pairId,
    device_id: deviceId,
    token: makeToken(found.pairId, deviceId, String(created.secret)),
    created: true,
    code: formatPairingCode(code),
    code_expires_at: expiresAt,
    cursor: 0,
  });
}

async function joinPair(request: Request, env: Env): Promise<Response> {
  const body = await readSmallJson(request);
  const platform = normalizePlatform(body?.platform);
  if (!body || !platform || typeof body.code !== "string") return json(400, { error: "invalid_body" });

  const redeemed = await registry(env).redeem(body.code, clientIp(request));
  if (!redeemed.ok) {
    if (redeemed.reason === "rate_limited") {
      return json(429, { error: "rate_limited" }, { "Retry-After": String(redeemed.retryAfterSec ?? 3600) });
    }
    if (redeemed.reason === "group_disabled") return json(403, { error: "group_disabled" });
    return json(404, { error: "invalid_or_expired_code" });
  }

  const added = await group(env, redeemed.pairId).addDevice({ platform, name: normalizeDeviceName(body.name) });
  if (added.status !== 200) return fromRpc(added);
  const device = bodyOf(added);
  const deviceId = String(device.device_id);

  return json(200, {
    pair_id: redeemed.pairId,
    device_id: deviceId,
    token: makeToken(redeemed.pairId, deviceId, String(device.secret)),
    cursor: device.cursor,
  });
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  const method = request.method;

  if (method === "GET" && path === "/v2/health") return json(200, { status: "ok", version: 2, server_now: Date.now() });
  if (method === "POST" && path === "/v2/connect") return connect(request, env);
  if (method === "POST" && path === "/v2/join") return joinPair(request, env);

  const token = bearerToken(request);
  if (!token) return json(401, { error: "unauthorized" });
  const stub = group(env, token.pairId);
  const auth: DeviceAuth = { deviceId: token.deviceId, secret: token.secret };

  if (method === "GET" && path === "/v2/snapshot") return fromRpc(await stub.snapshot(auth));

  if (method === "GET" && path === "/v2/changes") {
    const since = parseCount(url.searchParams.get("since"), 0);
    const limit = Math.min(Math.max(parseCount(url.searchParams.get("limit"), LIMITS.changesPageDefault), 1), LIMITS.changesPageMax);
    return fromRpc(await stub.changes(auth, since, limit));
  }

  if (method === "POST" && path === "/v2/changes") {
    const text = await readText(request, LIMITS.bodyBytes);
    if (text === null) return json(413, { error: "body_too_large" });
    return fromRpc(await stub.browserChanges(auth, text));
  }

  if (method === "POST" && path === "/v2/safari/snapshot") {
    const text = await readText(request, LIMITS.bodyBytes);
    if (text === null) return json(413, { error: "body_too_large" });
    return fromRpc(await stub.safariSnapshot(auth, text));
  }

  if (method === "GET" && path === "/v2/safari/pending") return fromRpc(await stub.safariPending(auth));
  if (method === "GET" && path === "/v2/devices") return fromRpc(await stub.devices(auth));

  if (method === "DELETE" && path.startsWith("/v2/devices/")) {
    const target = decodeURIComponent(path.slice("/v2/devices/".length));
    if (target !== "self" && !isUuid(target)) return json(400, { error: "invalid_device_id" });
    return fromRpc(await stub.revokeDevice(auth, target));
  }

  if (method === "POST" && path === "/v2/pair-code") {
    const who = await stub.whoami(auth);
    if (who.status !== 200) return fromRpc(who);
    const { code, expiresAt } = await registry(env).issueCode(token.pairId);
    return json(200, { code: formatPairingCode(code), code_expires_at: expiresAt });
  }

  if (method === "POST" && path === "/v2/ws-ticket") {
    const result = await stub.wsTicket(auth);
    if (result.status !== 200) return fromRpc(result);
    const issued = bodyOf(result);
    return json(200, { ...issued, path: `/v2/ws?pair=${token.pairId}&ticket=${String(issued.ticket)}` });
  }

  return json(404, { error: "not_found" });
}

// Administration with the ADMIN_KEY secret. Returns 404 when it is not set.
async function admin(request: Request, env: Env, url: URL): Promise<Response> {
  const allowed = await isAdmin(env, request);
  if (allowed === null) return json(404, { error: "not_found" });
  if (!allowed) return json(401, { error: "unauthorized" });

  const path = url.pathname.replace(/\/+$/, "");
  const method = request.method;
  const reg = registry(env);

  if (method === "POST" && path === "/v2/admin/keys") {
    const body = await readSmallJson(request);
    if (!body) return json(400, { error: "invalid_body" });
    const maxBookmarks = boundedInt(body.max_bookmarks, LIMITS.activeBookmarks, 1, LIMITS.activeBookmarks);
    if (maxBookmarks === null) return json(400, { error: "invalid_limits" });
    const label = typeof body.label === "string" && body.label.trim() ? body.label.trim().slice(0, 100) : null;
    const created = await reg.createKey({ label, maxBookmarks });
    return json(200, { ...created, label, max_bookmarks: maxBookmarks });
  }

  if (method === "GET" && path === "/v2/admin/keys") return json(200, await reg.listKeys());

  if (method === "DELETE" && path.startsWith("/v2/admin/keys/")) {
    const id = path.slice("/v2/admin/keys/".length);
    if (!isUuid(id)) return json(400, { error: "invalid_key_id" });
    const revoked = await reg.revokeKey(id);
    if (!revoked.found) return json(404, { error: "key_not_found" });
    await Promise.all(revoked.pairIds.map(pairId => group(env, pairId).disable()));
    return json(200, { revoked: id, disabled_groups: revoked.pairIds });
  }

  const groupMatch = path.match(/^\/v2\/admin\/groups\/([0-9a-f-]{36})(\/disable)?$/);
  if (groupMatch && isUuid(groupMatch[1])) {
    const pairId = groupMatch[1];
    if (method === "GET" && !groupMatch[2]) return fromRpc(await group(env, pairId).stats());
    if (method === "POST" && groupMatch[2]) {
      await group(env, pairId).disable();
      await reg.markGroupDisabled(pairId);
      return json(200, { disabled: pairId });
    }
    if (method === "DELETE" && !groupMatch[2]) {
      await group(env, pairId).purge();
      await reg.forgetGroup(pairId);
      return json(200, { deleted: pairId });
    }
  }

  return json(404, { error: "not_found" });
}
