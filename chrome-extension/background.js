// Safari Bookmarks Sync — Chrome background service worker.
//
// Identity model:
//   - A logical bookmark is uniquely identified within a pair by its canonical URL.
//   - folder_path is just an attribute that can change without changing identity.
//   - All uploads use canonical URLs; the server UPSERTs by (pair_id, canonical_url).

importScripts("lib/canonical.js");
const { canonicalUrl, normalizeFolderPath } = self.SyncCanonical;

const STORAGE_KEY = "sync_config";
const URL_MAP_KEY = "local_url_map"; // local bookmark id → last known canonical URL
const ALARM_POLL = "sync-poll";
const ALARM_FULL = "sync-full";
const SAFARI_ROOT_FOLDER = "Safari Bookmarks";
const CHROME_OTHER_BOOKMARKS_ID = "2";
const PENDING_REMOTE_TTL_MS = 5000;

// Set of canonical URLs we are currently writing locally because of a remote
// event. Used to suppress the local bookmark listeners from re-uploading those
// changes. Entries auto-expire to avoid stuck flags on errors.
const pendingRemoteUrls = new Map(); // url → expireAt

function markRemote(url) {
  if (!url) return;
  pendingRemoteUrls.set(url, Date.now() + PENDING_REMOTE_TTL_MS);
}
function isRemote(url) {
  if (!url) return false;
  const expiry = pendingRemoteUrls.get(url);
  if (!expiry) return false;
  if (Date.now() > expiry) {
    pendingRemoteUrls.delete(url);
    return false;
  }
  return true;
}

// ---------- config ----------

async function getConfig() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return result[STORAGE_KEY] || {
    pair_id: null, device_id: null, device_token: null,
    api_url: "", last_sync: 0, pair_code: null,
  };
}

async function saveConfig(config) {
  await chrome.storage.local.set({ [STORAGE_KEY]: config });
}

function normalizeApiUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function apiEndpoint(config, path) {
  const base = normalizeApiUrl(config.api_url);
  if (!base) throw new Error("Worker URL is missing");
  return `${base}${path}`;
}

function authHeaders(config) {
  if (!config.device_token) return {};
  return { Authorization: `Bearer ${config.device_token}` };
}

function authQuery(config) {
  return new URLSearchParams({
    pair_id: config.pair_id || "",
    device_id: config.device_id || "",
  }).toString();
}

// ---------- local URL cache (so onChanged can detect URL edits) ----------

async function getUrlMap() {
  const r = await chrome.storage.local.get(URL_MAP_KEY);
  return r[URL_MAP_KEY] || {};
}
async function setUrlMap(map) {
  await chrome.storage.local.set({ [URL_MAP_KEY]: map });
}
async function rememberUrl(localId, url) {
  const map = await getUrlMap();
  if (url) map[localId] = url; else delete map[localId];
  await setUrlMap(map);
}
async function forgetUrl(localId) {
  const map = await getUrlMap();
  delete map[localId];
  await setUrlMap(map);
}

// ---------- bookmark tree helpers ----------

async function safariRootIds() {
  const roots = await chrome.bookmarks.search({ title: SAFARI_ROOT_FOLDER });
  return roots.filter(n => !n.url).map(n => n.id);
}

async function folderPathForParent(parentId) {
  if (!parentId) return null;
  const parts = [];
  let currentId = parentId;
  let depth = 0;
  while (currentId && depth < 100) {
    const nodes = await chrome.bookmarks.get(currentId).catch(() => []);
    const node = nodes[0];
    if (!node) break;
    if (node.title === SAFARI_ROOT_FOLDER && !node.url) return parts.reverse();
    if (!node.parentId) break;
    parts.push(node.title);
    currentId = node.parentId;
    depth += 1;
  }
  return null;
}

async function ensureFolderPath(pathParts, parentId) {
  let currentParent = parentId;
  for (const rawPart of pathParts) {
    const part = String(rawPart || "").trim();
    if (!part) continue;
    const children = await chrome.bookmarks.getChildren(currentParent).catch(() => []);
    const folder = children.find(c => !c.url && c.title === part);
    if (folder) {
      currentParent = folder.id;
    } else {
      const created = await chrome.bookmarks.create({ parentId: currentParent, title: part });
      currentParent = created.id;
    }
  }
  return currentParent;
}

async function ensureSafariRoot() {
  const ids = await safariRootIds();
  if (ids.length > 0) return ids[0];
  const created = await chrome.bookmarks.create({
    parentId: CHROME_OTHER_BOOKMARKS_ID,
    title: SAFARI_ROOT_FOLDER,
  });
  return created.id;
}

async function targetParentIdFor(folderPath) {
  const rootId = await ensureSafariRoot();
  return ensureFolderPath(folderPath, rootId);
}

async function findUnderSafari(canonical) {
  // Search by URL is fast but global; scope down to nodes under any Safari root.
  const hits = await chrome.bookmarks.search({ url: canonical }).catch(() => []);
  if (hits.length === 0) return [];
  const rootIds = new Set(await safariRootIds());
  if (rootIds.size === 0) return [];

  const result = [];
  for (const hit of hits) {
    if (!hit.url) continue;
    if (canonicalUrl(hit.url) !== canonical) continue;
    const path = await folderPathForParent(hit.parentId);
    if (path === null) continue;
    result.push({ node: hit, folderPath: path });
  }
  return result;
}

async function findInFolder(canonical, parentId) {
  const children = await chrome.bookmarks.getChildren(parentId).catch(() => []);
  for (const child of children) {
    if (!child.url) continue;
    if (canonicalUrl(child.url) === canonical) return child;
  }
  return null;
}

// ---------- HTTP ----------

async function postJson(config, path, payload) {
  const res = await fetch(apiEndpoint(config, path), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(config) },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function getJson(config, path) {
  const sep = path.includes("?") ? "&" : "?";
  const url = apiEndpoint(config, path) + sep + authQuery(config);
  const res = await fetch(url, { headers: authHeaders(config) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function uploadChange(action, payload) {
  const config = await getConfig();
  if (!config.pair_id || !config.device_id || !config.device_token || !config.api_url) return;
  const body = {
    pair_id: config.pair_id,
    device_id: config.device_id,
    device_token: config.device_token, // backwards-compat; header is authoritative
    action,
    bookmark: payload,
  };
  await postJson(config, "/api/sync", body);
}

// ---------- local → remote ----------

async function uploadBookmarkAt(node, parentId) {
  if (!node || !node.url) return;
  const canonical = canonicalUrl(node.url);
  if (!canonical) return;
  if (isRemote(canonical)) return;

  const folderPath = await folderPathForParent(parentId || node.parentId);
  if (folderPath === null) return; // not under Safari root → ignore

  await uploadChange("update", {
    title: node.title || canonical,
    url: canonical,
    folderPath,
    index: Number.isInteger(node.index) ? node.index : 0,
  });
  await rememberUrl(node.id, canonical);
}

async function uploadCreate(node) {
  if (!node || !node.url) return;
  const canonical = canonicalUrl(node.url);
  if (!canonical) return;
  if (isRemote(canonical)) return;

  const folderPath = await folderPathForParent(node.parentId);
  if (folderPath === null) return;

  await uploadChange("create", {
    title: node.title || canonical,
    url: canonical,
    folderPath,
    index: Number.isInteger(node.index) ? node.index : 0,
  });
  await rememberUrl(node.id, canonical);
}

async function reuploadSubtree(folderId, folderPath) {
  const children = await chrome.bookmarks.getChildren(folderId).catch(() => []);
  for (const child of children) {
    if (child.url) {
      const canonical = canonicalUrl(child.url);
      if (!canonical || isRemote(canonical)) continue;
      await uploadChange("update", {
        title: child.title || canonical,
        url: canonical,
        folderPath,
        index: Number.isInteger(child.index) ? child.index : 0,
      });
      await rememberUrl(child.id, canonical);
    } else {
      await reuploadSubtree(child.id, [...folderPath, child.title]);
    }
  }
}

async function uploadRemovalRecursive(node, folderPath) {
  if (!node) return;
  if (node.url) {
    const canonical = canonicalUrl(node.url);
    if (!canonical || isRemote(canonical)) return;
    await uploadChange("remove", { url: canonical, folderPath });
    return;
  }
  const subPath = [...folderPath, node.title];
  for (const child of node.children || []) {
    await uploadRemovalRecursive(child, subPath);
  }
}

async function pushMissingLocalBookmarks(remoteBookmarks) {
  const remoteUrls = new Set((remoteBookmarks || []).map(b => b.url).filter(Boolean));
  const rootIds = await safariRootIds();
  let pushed = 0;

  async function walk(node, folderPath) {
    if (node.url) {
      const canonical = canonicalUrl(node.url);
      if (!canonical) return;
      if (remoteUrls.has(canonical)) return;
      await uploadChange("create", {
        title: node.title || canonical,
        url: canonical,
        folderPath,
        index: Number.isInteger(node.index) ? node.index : 0,
      });
      remoteUrls.add(canonical);
      pushed += 1;
      return;
    }
    const children = await chrome.bookmarks.getChildren(node.id).catch(() => []);
    for (const child of children) {
      await walk(child, [...folderPath, child.title]);
    }
  }

  for (const rootId of rootIds) {
    const children = await chrome.bookmarks.getChildren(rootId).catch(() => []);
    for (const child of children) {
      const startPath = child.url ? [] : [child.title];
      await walk(child, child.url ? [] : startPath);
    }
  }
  return pushed;
}

// ---------- remote → local ----------

async function moveOrCreate(canonical, payload) {
  const targetFolder = normalizeFolderPath(payload.folderPath);
  const targetParent = await targetParentIdFor(targetFolder);

  // First check: is there an exact-folder match? If so just title-update.
  const inTarget = await findInFolder(canonical, targetParent);
  if (inTarget) {
    if (payload.title && inTarget.title !== payload.title) {
      markRemote(canonical);
      await chrome.bookmarks.update(inTarget.id, { title: payload.title });
    }
    await rememberUrl(inTarget.id, canonical);
    return;
  }

  // Otherwise, find any existing copy under Safari tree and move it.
  const existing = await findUnderSafari(canonical);
  if (existing.length > 0) {
    const first = existing[0];
    markRemote(canonical);
    await chrome.bookmarks.move(first.node.id, { parentId: targetParent });
    if (payload.title && first.node.title !== payload.title) {
      markRemote(canonical);
      await chrome.bookmarks.update(first.node.id, { title: payload.title });
    }
    await rememberUrl(first.node.id, canonical);

    // Clean up additional copies (shouldn't exist, defensive).
    for (let i = 1; i < existing.length; i++) {
      markRemote(canonical);
      await chrome.bookmarks.remove(existing[i].node.id).catch(() => {});
      await forgetUrl(existing[i].node.id);
    }
    return;
  }

  // Nothing locally — create.
  markRemote(canonical);
  const created = await chrome.bookmarks.create({
    parentId: targetParent,
    title: payload.title || canonical,
    url: canonical,
  });
  await rememberUrl(created.id, canonical);
}

async function applyRemove(canonical) {
  const existing = await findUnderSafari(canonical);
  for (const entry of existing) {
    markRemote(canonical);
    await chrome.bookmarks.remove(entry.node.id).catch(() => {});
    await forgetUrl(entry.node.id);
  }
}

async function applyServerEvent(event) {
  // Accept both new ("upsert" / "remove") and legacy ("create" / "update" / "remove") shapes.
  const action = event.action;
  const bm = event.bookmark || {};
  const rawUrl = bm.url;
  const canonical = canonicalUrl(rawUrl);
  if (!canonical) return;

  try {
    if (action === "remove") {
      await applyRemove(canonical);
    } else {
      await moveOrCreate(canonical, {
        title: bm.title,
        folderPath: bm.folderPath || bm.folder_path || [],
      });
    }
  } catch (err) {
    console.error("[Sync] applyServerEvent failed:", err);
  }
}

// ---------- full sync + polling ----------

async function fullSync() {
  const config = await getConfig();
  if (!config.pair_id || !config.api_url) {
    return { ok: false, error: "Pairing or Worker URL is missing" };
  }

  try {
    const normalized = normalizeApiUrl(config.api_url);
    if (normalized !== config.api_url) {
      config.api_url = normalized;
      await saveConfig(config);
    }

    let data = await getJson(config, "/api/bookmarks");
    const pushed = await pushMissingLocalBookmarks(data.bookmarks);
    if (pushed > 0) {
      data = await getJson(config, "/api/bookmarks");
    }

    let created = 0;
    let updated = 0;
    let skipped = 0;
    for (const bm of data.bookmarks || []) {
      const canonical = bm.url;
      if (!canonical) { skipped += 1; continue; }
      const before = await findUnderSafari(canonical);
      await moveOrCreate(canonical, { title: bm.title, folderPath: bm.folderPath || [] });
      if (before.length === 0) created += 1; else updated += 1;
    }

    config.last_sync = data.server_now ?? config.last_sync;
    await saveConfig(config);
    return { ok: true, total: data.count ?? 0, created, updated, skipped, pushed };
  } catch (err) {
    console.error("[Sync] fullSync failed:", err);
    return { ok: false, error: err.message || String(err) };
  }
}

async function pollChanges() {
  const config = await getConfig();
  if (!config.pair_id || !config.api_url) return;
  try {
    const since = config.last_sync || 0;
    const data = await getJson(config, `/api/bookmarks/since?since=${since}`);
    for (const change of data.changes || []) {
      await applyServerEvent({
        action: change.action,
        bookmark: {
          url: change.url,
          title: change.title,
          folderPath: change.folderPath,
        },
      });
    }
    config.last_sync = data.server_now ?? config.last_sync;
    await saveConfig(config);
  } catch (err) {
    console.error("[Sync] poll failed:", err);
  }
}

// ---------- listeners on local bookmark tree ----------

chrome.bookmarks.onCreated.addListener(async (id, node) => {
  try {
    if (!node?.url) {
      // Folder creation under Safari root — nothing to upload until a leaf appears.
      return;
    }
    const canonical = canonicalUrl(node.url);
    if (!canonical || isRemote(canonical)) return;
    await uploadCreate(node);
  } catch (err) {
    console.error("[Sync] onCreated failed:", err);
  }
});

chrome.bookmarks.onChanged.addListener(async (id, changeInfo) => {
  try {
    const nodes = await chrome.bookmarks.get(id).catch(() => []);
    const node = nodes[0];
    if (!node?.url) return;
    const canonical = canonicalUrl(node.url);
    if (!canonical) return;
    if (isRemote(canonical)) return;

    // Detect URL change: send remove(old) + create(new).
    const map = await getUrlMap();
    const oldUrl = map[id];
    if (oldUrl && oldUrl !== canonical) {
      const folderPath = await folderPathForParent(node.parentId);
      if (folderPath !== null) {
        await uploadChange("remove", { url: oldUrl, folderPath });
        await uploadChange("create", {
          url: canonical,
          title: node.title || canonical,
          folderPath,
          index: Number.isInteger(node.index) ? node.index : 0,
        });
      }
      await rememberUrl(id, canonical);
      return;
    }

    await uploadBookmarkAt(node, node.parentId);
  } catch (err) {
    console.error("[Sync] onChanged failed:", err);
  }
});

chrome.bookmarks.onMoved.addListener(async (id, moveInfo) => {
  try {
    const nodes = await chrome.bookmarks.get(id).catch(() => []);
    const node = nodes[0];
    if (!node) return;

    // Folder moved → walk subtree and re-upload each leaf at its new folder path.
    if (!node.url) {
      const folderPath = await folderPathForParent(node.id);
      if (folderPath === null) return;
      await reuploadSubtree(node.id, folderPath);
      return;
    }

    const canonical = canonicalUrl(node.url);
    if (!canonical || isRemote(canonical)) return;

    const newFolder = await folderPathForParent(node.parentId);
    const oldFolder = await folderPathForParent(moveInfo.oldParentId);

    if (newFolder === null && oldFolder === null) return;
    if (newFolder === null && oldFolder !== null) {
      // Moved OUT of Safari tree → treat as remove.
      await uploadChange("remove", { url: canonical, folderPath: oldFolder });
      await forgetUrl(id);
      return;
    }
    if (newFolder !== null && oldFolder === null) {
      // Moved INTO Safari tree → treat as create.
      await uploadChange("create", {
        url: canonical,
        title: node.title || canonical,
        folderPath: newFolder,
        index: Number.isInteger(node.index) ? node.index : 0,
      });
      await rememberUrl(id, canonical);
      return;
    }
    // Moved WITHIN Safari tree → update.
    await uploadChange("update", {
      url: canonical,
      title: node.title || canonical,
      folderPath: newFolder,
      index: Number.isInteger(node.index) ? node.index : 0,
    });
    await rememberUrl(id, canonical);
  } catch (err) {
    console.error("[Sync] onMoved failed:", err);
  }
});

chrome.bookmarks.onRemoved.addListener(async (id, removeInfo) => {
  try {
    const oldFolder = await folderPathForParent(removeInfo.parentId);
    if (oldFolder === null) {
      await forgetUrl(id);
      return;
    }
    await uploadRemovalRecursive(removeInfo.node, oldFolder);
    await forgetUrl(id);
  } catch (err) {
    console.error("[Sync] onRemoved failed:", err);
  }
});

// ---------- offscreen WS ----------

async function ensureOffscreen() {
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    if (contexts.length === 0) {
      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: ["BLOBS"],
        justification: "Maintain WebSocket connection for bookmark sync",
      });
    }
  } catch (err) {
    console.error("[Sync] ensureOffscreen failed:", err);
  }
}

// ---------- message routing ----------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "ws_message") {
    (async () => {
      const config = await getConfig();
      await applyServerEvent(message.event);
      if (message.event?.server_now) {
        config.last_sync = message.event.server_now;
        await saveConfig(config);
      }
      sendResponse({ ok: true });
    })().catch(err => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }
  if (message?.type === "ws_status") {
    console.log("[Sync] WS status:", message.status);
    return false;
  }
  if (message?.type === "full_sync") {
    fullSync().then(sendResponse);
    return true;
  }
  if (message?.type === "reconnect_ws") {
    chrome.runtime.sendMessage({ type: "offscreen_reconnect" }).catch(() => {});
    sendResponse({ ok: true });
    return true;
  }
  return false;
});

// ---------- lifecycle ----------

chrome.runtime.onInstalled.addListener(async () => {
  console.log("[Sync] Extension installed");
  chrome.alarms.create(ALARM_POLL, { periodInMinutes: 1 });
  chrome.alarms.create(ALARM_FULL, { periodInMinutes: 30 });
  await ensureOffscreen();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureOffscreen();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_POLL) {
    await pollChanges();
    await ensureOffscreen();
  } else if (alarm.name === ALARM_FULL) {
    await fullSync();
  }
});

ensureOffscreen();
console.log("[Sync] Chrome extension background loaded");
