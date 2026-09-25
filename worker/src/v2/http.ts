import type { RpcResult } from "./SyncGroup";

const SMALL_BODY_BYTES = 64 * 1024;

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

export const fromRpc = (result: RpcResult): Response =>
  new Response(result.json, {
    status: result.status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

export const bodyOf = (result: RpcResult): Record<string, unknown> => JSON.parse(result.json);

export async function readText(request: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > maxBytes) return null;
  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > maxBytes) return null;
  return new TextDecoder().decode(buffer);
}

export async function readSmallJson(request: Request): Promise<Record<string, unknown> | null> {
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

export function parseCount(value: string | null, fallback: number): number {
  if (value === null || !/^\d{1,15}$/.test(value)) return fallback;
  return Number(value);
}

export function boundedInt(value: unknown, fallback: number, min: number, max: number): number | null {
  if (value === undefined || value === null) return fallback;
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : null;
}

export const group = (env: Env, pairId: string) => env.SYNC_GROUP.get(env.SYNC_GROUP.idFromName(pairId));
export const registry = (env: Env) => env.REGISTRY.get(env.REGISTRY.idFromName("global"));
export const clientIp = (request: Request) => request.headers.get("CF-Connecting-IP") ?? "unknown";
