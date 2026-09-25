import { adminFingerprint, configuredSecret, secretMatches } from "./access";
import { bodyOf, boundedInt, clientIp, fromRpc, group, json, readSmallJson, registry } from "./http";
import { ADMIN, LIMITS } from "./limits";
import type { GroupInfo } from "./Registry";
import { isUuid, sha256Hex } from "./token";

// ADMIN_KEY opens two doors to the same operations: scripts send it as a
// Bearer token to /v2/admin/*, and the /admin page trades it once for a
// session cookie used on /admin/api/*. Without ADMIN_KEY both answer 404.

const notFound = () => json(404, { error: "not_found" });

function refused(result: "invalid" | "rate_limited"): Response {
  return result === "rate_limited"
    ? json(429, { error: "rate_limited" }, { "Retry-After": "3600" })
    : json(401, { error: "unauthorized" });
}

async function checkAdminKey(request: Request, env: Env, admin: string, presented: unknown) {
  const matched = typeof presented === "string" && presented.trim() !== "" && (await secretMatches(presented.trim(), admin));
  return registry(env).adminAuthAttempt(clientIp(request), matched);
}

export async function handleAdminBearer(request: Request, env: Env, url: URL): Promise<Response> {
  const admin = configuredSecret(env.ADMIN_KEY);
  if (!admin) return notFound();
  const header = request.headers.get("Authorization");
  const attempt = await checkAdminKey(request, env, admin, header?.startsWith("Bearer ") ? header.slice(7) : null);
  if (attempt !== "ok") return refused(attempt);
  return adminApi(request, env, url.pathname.slice("/v2/admin".length));
}

// ------------------------------------------------------------------ operations

interface Usage {
  bookmarks: number;
  tombstones: number;
  devices: number;
  last_seen_at: number | null;
  storage_bytes: number;
  max_bookmarks: number;
}

async function usageOf(env: Env, info: GroupInfo | null): Promise<Usage | null> {
  if (!info) return null;
  const result = await group(env, info.pair_id).stats();
  if (result.status !== 200) return null;
  const stats = bodyOf(result);
  const devices = Array.isArray(stats.devices) ? (stats.devices as Record<string, unknown>[]) : [];
  const seen = devices.map(d => Number(d.last_seen_at)).filter(t => t > 0);
  return {
    bookmarks: Number(stats.bookmarks),
    tombstones: Number(stats.tombstones),
    devices: devices.length,
    last_seen_at: seen.length ? Math.max(...seen) : null,
    storage_bytes: Number(stats.storage_bytes),
    max_bookmarks: Number(stats.max_bookmarks),
  };
}

async function listWithUsage(env: Env) {
  const { keys, master_group } = await registry(env).listKeys();
  const [master, ...usage] = await Promise.all([usageOf(env, master_group), ...keys.map(k => usageOf(env, k.group))]);
  return {
    keys: keys.map((key, i) => ({ ...key, usage: usage[i] })),
    master_group: master_group && { ...master_group, usage: master },
  };
}

const cleanLabel = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, ADMIN.labelLength) : null;

async function updateKey(request: Request, env: Env, id: string): Promise<Response> {
  const body = await readSmallJson(request);
  if (!body) return json(400, { error: "invalid_body" });
  const patch: { label?: string | null; maxBookmarks?: number } = {};
  if ("label" in body) {
    if (body.label !== null && typeof body.label !== "string") return json(400, { error: "invalid_label" });
    patch.label = cleanLabel(body.label);
  }
  if ("max_bookmarks" in body) {
    const max = boundedInt(body.max_bookmarks, 0, 1, LIMITS.activeBookmarks);
    if (!max) return json(400, { error: "invalid_limits" });
    patch.maxBookmarks = max;
  }
  if (!Object.keys(patch).length) return json(400, { error: "invalid_body" });
  const updated = await registry(env).updateKey(id, patch);
  if (!updated) return json(404, { error: "key_not_found" });
  if (patch.maxBookmarks !== undefined && updated.group) {
    await group(env, updated.group.pair_id).setMaxBookmarks(patch.maxBookmarks);
  }
  return json(200, updated);
}

async function adminApi(request: Request, env: Env, rawPath: string): Promise<Response> {
  const path = rawPath.replace(/\/+$/, "");
  const method = request.method;
  const reg = registry(env);

  if (path === "/keys") {
    if (method === "GET") return json(200, await listWithUsage(env));
    if (method === "POST") {
      const body = await readSmallJson(request);
      if (!body) return json(400, { error: "invalid_body" });
      const maxBookmarks = boundedInt(body.max_bookmarks, LIMITS.activeBookmarks, 1, LIMITS.activeBookmarks);
      if (maxBookmarks === null) return json(400, { error: "invalid_limits" });
      const label = cleanLabel(body.label);
      const created = await reg.createKey({ label, maxBookmarks });
      return json(200, { ...created, label, max_bookmarks: maxBookmarks });
    }
  }

  if (path.startsWith("/keys/")) {
    const [id, action] = path.slice("/keys/".length).split("/");
    if (!isUuid(id)) return json(400, { error: "invalid_key_id" });
    if (method === "PATCH" && action === undefined) return updateKey(request, env, id);
    if (method === "POST" && action === "reset") {
      const reset = await reg.resetKey(id);
      if (!reset.ok) return reset.reason === "not_found" ? json(404, { error: "key_not_found" }) : json(409, { error: "key_revoked" });
      return json(200, { id: reset.id, key: reset.key });
    }
    if (method === "DELETE" && action === undefined) {
      const revoked = await reg.revokeKey(id);
      if (!revoked.found) return json(404, { error: "key_not_found" });
      await Promise.all(revoked.pairIds.map(pairId => group(env, pairId).disable()));
      return json(200, { revoked: id, disabled_groups: revoked.pairIds });
    }
  }

  const groupMatch = path.match(/^\/groups\/([0-9a-f-]{36})(\/disable)?$/);
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

  return notFound();
}

// ------------------------------------------------------------------ the page

const PAGE_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
    "form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cache-Control": "no-store",
};

function withPageHeaders(response: Response): Response {
  const copy = new Response(response.body, response);
  for (const [name, value] of Object.entries(PAGE_HEADERS)) copy.headers.set(name, value);
  return copy;
}

const sessionCookie = (value: string, maxAgeSec: number) =>
  `${ADMIN.cookie}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}`;

function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

async function pageApi(request: Request, env: Env, url: URL, admin: string): Promise<Response> {
  const path = url.pathname.slice("/admin/api".length).replace(/\/+$/, "");
  const method = request.method;
  // SameSite=Strict already keeps the cookie off cross-site requests; the
  // Origin check covers browsers that do not enforce it.
  if (method !== "GET" && method !== "HEAD" && request.headers.get("Origin") !== url.origin) {
    return json(403, { error: "bad_origin" });
  }
  const reg = registry(env);
  const fingerprint = await adminFingerprint(admin);
  const cookie = readCookie(request, ADMIN.cookie);
  const tokenHash = cookie && /^[0-9a-f]{64}$/.test(cookie) ? await sha256Hex(cookie) : null;

  if (path === "/login" && method === "POST") {
    const body = await readSmallJson(request);
    const attempt = await checkAdminKey(request, env, admin, body?.key);
    if (attempt !== "ok") return refused(attempt);
    const session = await reg.adminCreateSession(fingerprint);
    return json(
      200,
      { signed_in: true, expires_at: session.expiresAt },
      { "Set-Cookie": sessionCookie(session.token, ADMIN.sessionTtlMs / 1000) },
    );
  }
  if (path === "/logout" && method === "POST") {
    if (tokenHash) await reg.adminEndSession(tokenHash);
    return json(200, { signed_in: false }, { "Set-Cookie": sessionCookie("", 0) });
  }

  const signedIn = tokenHash !== null && (await reg.adminSessionValid(tokenHash, fingerprint));
  if (path === "/session" && method === "GET") return json(200, { signed_in: signedIn });
  if (!signedIn) return json(401, { error: "session_expired" });
  return adminApi(request, env, path);
}

// Serves /admin (static files from public/admin) and its API.
export async function handleAdminPage(request: Request, env: Env): Promise<Response> {
  const admin = configuredSecret(env.ADMIN_KEY);
  if (!admin) return notFound();
  try {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/admin/api/")) return withPageHeaders(await pageApi(request, env, url, admin));
    if (request.method !== "GET" && request.method !== "HEAD") return withPageHeaders(json(405, { error: "method_not_allowed" }));
    return withPageHeaders(await env.ASSETS.fetch(request));
  } catch (err) {
    console.error("admin request failed", err);
    return withPageHeaders(json(500, { error: "internal_error" }));
  }
}
