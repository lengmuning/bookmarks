// Simple KV-backed sliding-window rate limiter.
// Keep keys short — Cloudflare KV has per-key write cost.

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  retryAfterSec?: number;
}

export async function checkRateLimit(
  env: Env,
  key: string,
  limit: number,
  windowSec: number,
): Promise<RateLimitResult> {
  const kvKey = `rl:${key}`;
  const current = await env.BOOKMARKS_KV.get(kvKey);
  const used = current ? parseInt(current, 10) || 0 : 0;

  if (used >= limit) {
    return { ok: false, remaining: 0, retryAfterSec: windowSec };
  }
  return { ok: true, remaining: limit - used };
}

export async function bumpRateLimit(
  env: Env,
  key: string,
  windowSec: number,
): Promise<void> {
  const kvKey = `rl:${key}`;
  const current = await env.BOOKMARKS_KV.get(kvKey);
  const used = current ? parseInt(current, 10) || 0 : 0;
  await env.BOOKMARKS_KV.put(kvKey, String(used + 1), { expirationTtl: windowSec });
}

export async function resetRateLimit(env: Env, key: string): Promise<void> {
  await env.BOOKMARKS_KV.delete(`rl:${key}`);
}

export function clientKey(request: Request): string {
  return request.headers.get("CF-Connecting-IP")
    ?? request.headers.get("X-Forwarded-For")
    ?? "unknown";
}
