import { IRequest } from "itty-router";
import { newId } from "../utils/crypto";
import { validateDevice } from "../utils/auth";

interface SyncBody {
  pair_id: string;
  device_id: string;
  device_token: string;
  action: "create" | "update" | "remove";
  bookmark: {
    id: string;
    title?: string;
    url?: string;
    parentId?: string;
    folderPath?: string[];
    index?: number;
  };
}

export async function handleSync(request: IRequest, env: Env): Promise<Response> {
  const body = await request.json() as SyncBody;

  if (!body.pair_id || !body.device_id || !body.device_token || !body.action || !body.bookmark?.id) {
    return Response.json({ error: "Missing required fields" }, { status: 400 });
  }

  const { pair_id, device_id, device_token, action, bookmark } = body;
  if (!await validateDevice(env, pair_id, device_id, device_token)) {
    return Response.json({ error: "Unauthorized device" }, { status: 401 });
  }

  const id = newId();
  const now = Date.now();

  // Write to D1
  const folderPath = Array.isArray(bookmark.folderPath)
    ? JSON.stringify(bookmark.folderPath.filter(part => typeof part === "string" && part.trim()))
    : null;

  await env.DB.prepare(
    `INSERT INTO bookmarks (id, pair_id, bookmark_id, title, url, parent_id, folder_path, idx, action, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id, pair_id, bookmark.id, bookmark.title ?? null, bookmark.url ?? null,
    bookmark.parentId ?? null, folderPath, bookmark.index ?? null, action, now
  ).run();

  // Broadcast via Durable Object
  const doId = env.SYNC_CHANNEL.idFromName(pair_id);
  const stub = env.SYNC_CHANNEL.get(doId);
  await stub.broadcast({
    type: "bookmark_change",
    action,
    bookmark: {
      id: bookmark.id,
      title: bookmark.title,
      url: bookmark.url,
      parentId: bookmark.parentId,
      folderPath: bookmark.folderPath,
      index: bookmark.index,
    },
  });

  return Response.json({ status: "ok", id });
}
