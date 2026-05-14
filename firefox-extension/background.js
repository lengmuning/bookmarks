// Safari Bookmarks Sync — Firefox background event page.
// Mirrors chrome-extension/background.js with Firefox API + inline WebSocket.

/* global SyncCanonical */
const { canonicalUrl, normalizeFolderPath } = self.SyncCanonical;

const STORAGE_KEY = "sync_config";
const URL_MAP_KEY = "local_url_map";
const ALARM_POLL = "sync-poll";
const ALARM_FULL = "sync-full";
const SAFARI_ROOT_FOLDER = "Safari Bookmarks";
const FIREFOX_OTHER_BOOKMARKS_ID = "unfiled_____";
const PENDING_REMOTE_TTL_MS = 5000;
const PING_INTERVAL_MS = 30000;
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 60000;

const pendingRemoteUrls = new Map();
let ws = null;
let pingTimer = null;
let reconnectTimer = null;
let reconnectAttempt = 0;

function markRemote(url) {
  if (!url) return;
  pendingRemoteUrls.set(url, Date.now() + PENDING_REMOTE_TTL_MS);
}
function isRemote(url) {
  if (!url) return false;
  const expiry = pendingRemoteUrls.get(url);
  if (!expiry) return false;
  if (Date.now() > expiry) { pendingRemoteUrls.delete(url); return false; }
  return true;
}

// ---------- config ----------

async function getConfig() {
  const result = await browser.storage.local.get(STORAGE_KEY);
  return result[STORAGE_KEY] || {
    pair_id: null, device_id: null, device_token: null,
    api_url: "", last_sync: 0, pair_code: null,
  };
}
async function saveConfig(config) {
  await browser.storage.local.set({ [STORAGE_KEY]: config });
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

// ---------- URL map ----------

async function getUrlMap() {
  const r = await browser.storage.local.get(URL_MAP_KEY);
  return r[URL_MAP_KEY] || {};
}
async function setUrlMap(map) {
  await browser.storage.local.set({ [URL_MAP_KEY]: map });
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

// ---------- tree helpers ----------

async function safariRootIds() {
  const roots = await browser.bookmarks.search({ title: SAFARI_ROOT_FOLDER });
  return roots.filter(n => !n.url).map(n => n.id);
}

async function folderPathForParent(parentId) {
  if (!parentId) return null;
  const parts = [];
  let currentId = parentId;
  let depth = 0;
  while (currentId && depth < 100) {
    const nodes = await browser.bookmarks.get(currentId).catch(() => []);
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
    const children = await browser.bookmarks.getChildren(currentParent).catch(() => []);
    const folder = children.find(c => !c.url && c.title === part);
    if (folder) {
      currentParent = folder.id;
    } else {
      const created = await browser.bookmarks.create({ parentId: currentParent, title: part });
      currentParent = created.id;
    }
  }
  return currentParent;
}

async function ensureSafariRoot() {
  const ids = await safariRootIds();
  if (ids.length > 0) return ids[0];
  const created = await browser.bookmarks.create({
    parentId: FIREFOX_OTHER_BOOKMARKS_ID,
    title: SAFARI_ROOT_FOLDER,
  });
  return created.id;
}

async function targetParentIdFor(folderPath) {
  const rootId = await ensureSafariRoot();
  return ensureFolderPath(folderPath, rootId);
}

async function findUnderSafari(canonical) {
  const hits = await browser.bookmarks.search({ url: canonical }).catch(() => []);
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
  const children = await browser.bookmarks.getChildren(parentId).catch(() => []);
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
    device_token: config.device_token,
    action,
    bookmark: payload,
  };
  await postJson(config, "/api/sync", body);
}

// ---------- local → remote ----------

async function uploadBookmarkAt(node, parentId) {
  if (!node || !node.url) return;
  const canonical = canonicalUrl(node.url);
  if (!canonical || isRemote(canonical)) return;
  const folderPath = await folderPathForParent(parentId || node.parentId);
  if (folderPath === null) return;
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
  if (!canonical || isRemote(canonical)) return;
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
  const children = await browser.bookmarks.getChildren(folderId).catch(() => []);
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
    const children = await browser.bookmarks.getChildren(node.id).catch(() => []);
    for (const child of children) {
      await walk(child, child.url ? folderPath : [...folderPath, child.title]);
    }
  }

  for (const rootId of rootIds) {
    const children = await browser.bookmarks.getChildren(rootId).catch(() => []);
    for (const child of children) {
      await walk(child, child.url ? [] : [child.title]);
    }
  }
  return pushed;
}

// ---------- remote → local ----------

async function moveOrCreate(canonical, payload) {
  const targetFolder = normalizeFolderPath(payload.folderPath);
  const targetParent = await targetParentIdFor(targetFolder);

  const inTarget = await findInFolder(canonical, targetParent);
  if (inTarget) {
    if (payload.title && inTarget.title !== payload.title) {
      markRemote(canonical);
      await browser.bookmarks.update(inTarget.id, { title: payload.title });
    }
    await rememberUrl(inTarget.id, canonical);
    return;
  }

  const existing = await findUnderSafari(canonical);
  if (existing.length > 0) {
    const first = existing[0];
    markRemote(canonical);
    await browser.bookmarks.move(first.node.id, { parentId: targetParent });
    if (payload.title && first.node.title !== payload.title) {
      markRemote(canonical);
      await browser.bookmarks.update(first.node.id, { title: payload.title });
    }
    await rememberUrl(first.node.id, canonical);
    for (let i = 1; i < existing.length; i++) {
      markRemote(canonical);
      await browser.bookmarks.remove(existing[i].node.id).catch(() => {});
      await forgetUrl(existing[i].node.id);
    }
    return;
  }

  markRemote(canonical);
  const created = await browser.bookmarks.create({
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
    await browser.bookmarks.remove(entry.node.id).catch(() => {});
    await forgetUrl(entry.node.id);
  }
}

async function applyServerEvent(event) {
  const action = event.action;
  const bm = event.bookmark || {};
  const canonical = canonicalUrl(bm.url);
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
    let created = 0, updated = 0, skipped = 0;
    for (const bm of data.bookmarks || []) {
      if (!bm.url) { skipped += 1; continue; }
      const before = await findUnderSafari(bm.url);
      await moveOrCreate(bm.url, { title: bm.title, folderPath: bm.folderPath || [] });
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
        bookmark: { url: change.url, title: change.title, folderPath: change.folderPath },
      });
    }
    config.last_sync = data.server_now ?? config.last_sync;
    await saveConfig(config);
  } catch (err) {
    console.error("[Sync] poll failed:", err);
  }
}

// ---------- WebSocket (inline, no offscreen on Firefox) ----------

function clearTimers() {
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectAttempt += 1;
  const backoff = Math.min(RECONNECT_BASE_MS * (2 ** Math.min(reconnectAttempt - 1, 5)), RECONNECT_MAX_MS);
  const jitter = Math.floor(Math.random() * 1000);
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connectWS(); }, backoff + jitter);
}

async function connectWS() {
  clearTimers();
  const config = await getConfig();
  if (!config.pair_id || !config.api_url || !config.device_id || !config.device_token) {
    scheduleReconnect();
    return;
  }

  const wsUrl = normalizeApiUrl(config.api_url).replace(/^http/, "ws");
  const params = new URLSearchParams({
    pair_id: config.pair_id,
    device_id: config.device_id,
    device_token: config.device_token,
    browser: "firefox",
  });

  try {
    ws = new WebSocket(`${wsUrl}/ws?${params.toString()}`);
  } catch (err) {
    console.error("[Sync] WS create failed:", err);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    reconnectAttempt = 0;
    pingTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "ping" }));
      }
    }, PING_INTERVAL_MS);
  };

  ws.onmessage = async (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data?.type === "bookmark_change") {
        await applyServerEvent(data);
        if (data.server_now) {
          const cfg = await getConfig();
          cfg.last_sync = data.server_now;
          await saveConfig(cfg);
        }
      }
    } catch (err) {
      console.error("[Sync] WS message failed:", err);
    }
  };

  ws.onclose = () => {
    clearTimers();
    ws = null;
    scheduleReconnect();
  };

  ws.onerror = () => { /* close handler will fire */ };
}

// ---------- listeners ----------

browser.bookmarks.onCreated.addListener(async (id, node) => {
  try {
    if (!node?.url) return;
    const canonical = canonicalUrl(node.url);
    if (!canonical || isRemote(canonical)) return;
    await uploadCreate(node);
  } catch (err) {
    console.error("[Sync] onCreated failed:", err);
  }
});

browser.bookmarks.onChanged.addListener(async (id) => {
  try {
    const nodes = await browser.bookmarks.get(id).catch(() => []);
    const node = nodes[0];
    if (!node?.url) return;
    const canonical = canonicalUrl(node.url);
    if (!canonical) return;
    if (isRemote(canonical)) return;

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

browser.bookmarks.onMoved.addListener(async (id, moveInfo) => {
  try {
    const nodes = await browser.bookmarks.get(id).catch(() => []);
    const node = nodes[0];
    if (!node) return;

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
      await uploadChange("remove", { url: canonical, folderPath: oldFolder });
      await forgetUrl(id);
      return;
    }
    if (newFolder !== null && oldFolder === null) {
      await uploadChange("create", {
        url: canonical,
        title: node.title || canonical,
        folderPath: newFolder,
        index: Number.isInteger(node.index) ? node.index : 0,
      });
      await rememberUrl(id, canonical);
      return;
    }
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

browser.bookmarks.onRemoved.addListener(async (id, removeInfo) => {
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

// ---------- lifecycle ----------

browser.runtime.onInstalled.addListener(async () => {
  console.log("[Sync] Extension installed");
  browser.alarms.create(ALARM_POLL, { periodInMinutes: 1 });
  browser.alarms.create(ALARM_FULL, { periodInMinutes: 30 });
  await connectWS();
});

browser.runtime.onStartup.addListener(async () => {
  await connectWS();
});

browser.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_POLL) {
    await pollChanges();
    if (!ws || ws.readyState !== WebSocket.OPEN) await connectWS();
  } else if (alarm.name === ALARM_FULL) {
    await fullSync();
  }
});

browser.storage.onChanged.addListener((changes) => {
  if (changes[STORAGE_KEY]) {
    reconnectAttempt = 0;
    if (ws) { try { ws.close(); } catch { /* ignore */ } ws = null; }
    clearTimers();
    connectWS();
  }
});

browser.runtime.onMessage.addListener((message) => {
  if (message?.type === "full_sync") return fullSync();
  if (message?.type === "reconnect_ws") {
    return (async () => {
      reconnectAttempt = 0;
      if (ws) { try { ws.close(); } catch { /* ignore */ } ws = null; }
      clearTimers();
      await connectWS();
      return { ok: true };
    })();
  }
  return undefined;
});

connectWS();
console.log("[Sync] Firefox extension background loaded");
