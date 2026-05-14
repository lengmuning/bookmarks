import { IRequest } from "itty-router";
import { validateRequest } from "../utils/auth";

interface StateRow {
  url: string;
  title: string | null;
  folder_path: string;
  idx: number | null;
  removed: number;
  updated_at: number;
}

function decodeFolderPath(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is string => typeof p === "string");
  } catch {
    return [];
  }
}

function rowToBookmark(row: StateRow) {
  return {
    url: row.url,
    title: row.title,
    folderPath: decodeFolderPath(row.folder_path),
    index: row.idx,
    updated_at: row.updated_at,
    removed: row.removed === 1,
  };
}

export async function handleGetBookmarks(request: IRequest, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const auth = await validateRequest(env, request, url);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const result = await env.DB.prepare(`
    SELECT url, title, folder_path, idx, removed, updated_at
    FROM bookmark_state
    WHERE pair_id = ? AND removed = 0
    ORDER BY folder_path, idx, url
  `).bind(auth.pairId).all<StateRow>();

  const bookmarks = result.results.map(rowToBookmark);

  return Response.json({
    pair_id: auth.pairId,
    bookmarks,
    count: bookmarks.length,
    server_now: Date.now(),
  });
}

export async function handleGetBookmarksSince(request: IRequest, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const auth = await validateRequest(env, request, url);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const since = parseInt(url.searchParams.get("since") ?? "0", 10) || 0;

  const result = await env.DB.prepare(`
    SELECT url, title, folder_path, idx, removed, updated_at
    FROM bookmark_state
    WHERE pair_id = ? AND updated_at > ?
    ORDER BY updated_at ASC
  `).bind(auth.pairId, since).all<StateRow>();

  const changes = result.results.map(row => ({
    action: row.removed === 1 ? ("remove" as const) : ("upsert" as const),
    ...rowToBookmark(row),
  }));

  return Response.json({
    pair_id: auth.pairId,
    changes,
    count: changes.length,
    server_now: Date.now(),
  });
}
