import { IRequest } from "itty-router";
import { validateRequest } from "../utils/auth";
import { canonicalUrl, normalizeFolderPath } from "../utils/url";

interface SyncBody {
  pair_id?: string;
  device_id?: string;
  device_token?: string;
  action?: "create" | "update" | "remove";
  bookmark?: {
    id?: string;
    title?: string;
    url?: string;
    parentId?: string;
    folderPath?: unknown;
    folder_path?: unknown;
    index?: number;
  };
}

interface StateRow {
  url: string;
  folder_path: string;
}

interface BroadcastEvent {
  type: "bookmark_change";
  action: "create" | "update" | "remove";
  bookmark: {
    url: string;
    title: string | null;
    folderPath: string[];
    index: number | null;
    updated_at: number;
  };
}

async function broadcast(env: Env, pairId: string, events: BroadcastEvent[]): Promise<void> {
  if (events.length === 0) return;
  const doId = env.SYNC_CHANNEL.idFromName(pairId);
  const stub = env.SYNC_CHANNEL.get(doId);
  for (const event of events) {
    await stub.broadcast(event);
  }
}

export async function handleSync(request: IRequest, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const body = await request.json().catch(() => null) as SyncBody | null;
  if (!body || !body.action || !body.bookmark) {
    return Response.json({ error: "Missing required fields" }, { status: 400 });
  }

  // Auth: prefer Bearer header, fall back to body fields for backwards compat.
  const queryAuthUrl = new URL(url.toString());
  if (body.pair_id) queryAuthUrl.searchParams.set("pair_id", body.pair_id);
  if (body.device_id) queryAuthUrl.searchParams.set("device_id", body.device_id);
  if (body.device_token) queryAuthUrl.searchParams.set("device_token", body.device_token);

  const auth = await validateRequest(env, request, queryAuthUrl);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { pairId, deviceId } = auth;

  const action = body.action;
  if (action !== "create" && action !== "update" && action !== "remove") {
    return Response.json({ error: "Invalid action" }, { status: 400 });
  }

  const rawUrl = body.bookmark.url ?? "";
  const normalizedUrl = canonicalUrl(rawUrl);
  if (!normalizedUrl) {
    return Response.json({ error: "Invalid or unsupported URL" }, { status: 400 });
  }

  const folderPath = normalizeFolderPath(body.bookmark.folderPath ?? body.bookmark.folder_path);
  const folderPathJson = JSON.stringify(folderPath);
  const title = typeof body.bookmark.title === "string" ? body.bookmark.title : null;
  const idx = Number.isInteger(body.bookmark.index) ? body.bookmark.index! : null;
  const now = Date.now();
  const removed = action === "remove" ? 1 : 0;

  const events: BroadcastEvent[] = [];

  if (action === "remove") {
    // Tombstone any matching URL in this pair (across all folders).
    const matches = await env.DB.prepare(
      "SELECT url, folder_path FROM bookmark_state WHERE pair_id = ? AND url = ? AND removed = 0"
    ).bind(pairId, normalizedUrl).all<StateRow>();

    for (const row of matches.results) {
      await env.DB.prepare(`
        UPDATE bookmark_state
        SET removed = 1, last_actor = ?, updated_at = ?
        WHERE pair_id = ? AND url = ?
      `).bind(deviceId, now, pairId, row.url).run();

      let folder: string[] = [];
      try {
        const parsed = JSON.parse(row.folder_path);
        if (Array.isArray(parsed)) folder = parsed.filter((p): p is string => typeof p === "string");
      } catch { /* ignore */ }

      events.push({
        type: "bookmark_change",
        action: "remove",
        bookmark: { url: row.url, title: null, folderPath: folder, index: null, updated_at: now },
      });
    }
  } else {
    // UPSERT, with guard against out-of-order writes (last-write-wins by timestamp).
    await env.DB.prepare(`
      INSERT INTO bookmark_state
        (pair_id, url, title, folder_path, idx, removed, last_actor, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
      ON CONFLICT(pair_id, url) DO UPDATE SET
        title       = excluded.title,
        folder_path = excluded.folder_path,
        idx         = excluded.idx,
        removed     = 0,
        last_actor  = excluded.last_actor,
        updated_at  = excluded.updated_at
      WHERE excluded.updated_at >= bookmark_state.updated_at
    `).bind(pairId, normalizedUrl, title, folderPathJson, idx, deviceId, now, now).run();

    events.push({
      type: "bookmark_change",
      action,
      bookmark: { url: normalizedUrl, title, folderPath, index: idx, updated_at: now },
    });
  }

  await broadcast(env, pairId, events);

  return Response.json({
    status: "ok",
    url: normalizedUrl,
    folder_path: folderPath,
    server_now: now,
    affected: events.length,
  });
}
