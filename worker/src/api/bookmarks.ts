import { IRequest } from "itty-router";
import { validateDevice } from "../utils/auth";

export async function handleGetBookmarks(request: IRequest, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const pairId = url.searchParams.get("pair_id");
  if (!pairId) {
    return Response.json({ error: "Missing pair_id" }, { status: 400 });
  }
  if (!await validateDevice(
    env,
    pairId,
    url.searchParams.get("device_id"),
    url.searchParams.get("device_token"),
  )) {
    return Response.json({ error: "Unauthorized device" }, { status: 401 });
  }

  // Build a snapshot: for each bookmark_id, get the latest non-remove entry
  const result = await env.DB.prepare(`
    SELECT b.bookmark_id, b.title, b.url, b.parent_id, b.idx, b.action, b.timestamp
    FROM bookmarks b
    INNER JOIN (
      SELECT bookmark_id, MAX(timestamp) AS max_ts
      FROM bookmarks
      WHERE pair_id = ?
      GROUP BY bookmark_id
    ) latest ON b.bookmark_id = latest.bookmark_id AND b.timestamp = latest.max_ts
    WHERE b.pair_id = ?
    ORDER BY b.parent_id, b.idx
  `).bind(pairId, pairId).all();

  // Filter out removed bookmarks, build tree
  const active = result.results.filter((r: any) => r.action !== "remove");

  return Response.json({
    pair_id: pairId,
    bookmarks: active,
    count: active.length,
  });
}

export async function handleGetBookmarksSince(request: IRequest, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const pairId = url.searchParams.get("pair_id");
  const since = parseInt(url.searchParams.get("since") ?? "0");

  if (!pairId) {
    return Response.json({ error: "Missing pair_id" }, { status: 400 });
  }
  if (!await validateDevice(
    env,
    pairId,
    url.searchParams.get("device_id"),
    url.searchParams.get("device_token"),
  )) {
    return Response.json({ error: "Unauthorized device" }, { status: 401 });
  }

  const result = await env.DB.prepare(
    "SELECT * FROM bookmarks WHERE pair_id = ? AND timestamp > ? ORDER BY timestamp ASC"
  ).bind(pairId, since).all();

  return Response.json({
    pair_id: pairId,
    changes: result.results,
    count: result.results.length,
  });
}
