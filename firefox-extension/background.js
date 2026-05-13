const STORAGE_KEY = "sync_config";
const SAFARI_ROOT_FOLDER = "Safari Bookmarks";
let ws = null;
let pingTimer = null;
let reconnectTimer = null;
let applyingRemoteChange = false;

async function getConfig() {
  const result = await browser.storage.local.get(STORAGE_KEY);
  return result[STORAGE_KEY] || {
    pair_id: null, device_id: null, api_url: "",
    last_sync: 0, pair_code: null
  };
}

async function saveConfig(config) {
  await browser.storage.local.set({ [STORAGE_KEY]: config });
}

function authQuery(config) {
  return new URLSearchParams({
    pair_id: config.pair_id,
    device_id: config.device_id,
    device_token: config.device_token,
  }).toString();
}

function normalizeApiUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function apiEndpoint(config, path) {
  const base = normalizeApiUrl(config.api_url);
  if (!base) throw new Error("Worker URL is missing");
  return `${base}${path}`;
}

// --- Bookmark operations ---

function normalizeFolderPath(bookmark) {
  const path = Array.isArray(bookmark.folderPath) ? bookmark.folderPath : parseFolderPath(bookmark.folder_path);
  return path
    .map(part => String(part || "").trim())
    .filter(Boolean)
    .filter((part, index, parts) => index === 0 || part !== parts[index - 1]);
}

function parseFolderPath(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function ensureFolderPath(pathParts, parentId) {
  let currentParent = parentId;
  for (const part of pathParts) {
    if (!part) continue;
    const existing = await browser.bookmarks.search({ title: part });
    const folder = existing.find(b => !b.url && b.parentId === currentParent);
    if (folder) {
      currentParent = folder.id;
    } else {
      const created = await browser.bookmarks.create({
        parentId: currentParent,
        title: part,
      });
      currentParent = created.id;
    }
  }
  return currentParent;
}

async function targetParentIdFor(bookmark) {
  return ensureFolderPath([SAFARI_ROOT_FOLDER, ...normalizeFolderPath(bookmark)], "unfiled_____");
}

async function findBookmarkInParent(url, parentId) {
  const existing = await browser.bookmarks.search({ url });
  return existing.find(b => b.parentId === parentId);
}

async function withRemoteChange(fn) {
  applyingRemoteChange = true;
  try {
    return await fn();
  } finally {
    applyingRemoteChange = false;
  }
}

async function folderPathForParent(parentId) {
  const parts = [];
  let currentId = parentId;

  while (currentId) {
    const nodes = await browser.bookmarks.get(currentId).catch(() => []);
    const node = nodes[0];
    if (!node) break;
    if (node.title === SAFARI_ROOT_FOLDER) return parts.reverse();
    if (!node.parentId) break;
    parts.push(node.title);
    currentId = node.parentId;
  }

  return null;
}

async function localBookmarkPayload(node, parentId = node.parentId) {
  if (!node || !node.url || !parentId) return null;
  const folderPath = await folderPathForParent(parentId);
  if (!folderPath) return null;

  return {
    id: `firefox-${node.id}`,
    title: node.title || node.url,
    url: node.url,
    parentId: `firefox-${parentId}`,
    folderPath,
    index: Number.isInteger(node.index) ? node.index : 0,
  };
}

async function sendLocalBookmarkChange(action, bookmark) {
  const config = await getConfig();
  if (!config.pair_id || !config.api_url || !config.device_id || !config.device_token || !bookmark) return;

  const res = await fetch(apiEndpoint(config, "/api/sync"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pair_id: config.pair_id,
      device_id: config.device_id,
      device_token: config.device_token,
      action,
      bookmark,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
}

async function collectLocalBookmarksUnder(node, out) {
  if (node.url) {
    const bookmark = await localBookmarkPayload(node);
    if (bookmark) out.push(bookmark);
    return;
  }

  const children = await browser.bookmarks.getChildren(node.id).catch(() => []);
  for (const child of children) {
    await collectLocalBookmarksUnder(child, out);
  }
}

async function collectLocalSafariBookmarks() {
  const roots = await browser.bookmarks.search({ title: SAFARI_ROOT_FOLDER });
  const bookmarks = [];
  for (const root of roots.filter(node => !node.url)) {
    await collectLocalBookmarksUnder(root, bookmarks);
  }
  return bookmarks;
}

async function pushMissingLocalBookmarks(remoteBookmarks) {
  const remoteUrls = new Set(
    (remoteBookmarks || [])
      .map(bookmark => bookmark.url)
      .filter(Boolean)
  );
  const localBookmarks = await collectLocalSafariBookmarks();
  let pushed = 0;

  for (const bookmark of localBookmarks) {
    if (remoteUrls.has(bookmark.url)) continue;
    await sendLocalBookmarkChange("create", bookmark);
    remoteUrls.add(bookmark.url);
    pushed += 1;
  }

  return pushed;
}

async function applyBookmarkChange(event) {
  const { action, bookmark } = event;
  try {
    if (action === "create") {
      const parentId = await targetParentIdFor(bookmark);

      if (bookmark.url) {
        const existing = await findBookmarkInParent(bookmark.url, parentId);
        if (existing) {
          if (bookmark.title && existing.title !== bookmark.title) {
            await withRemoteChange(() => browser.bookmarks.update(existing.id, { title: bookmark.title }));
          }
          console.log("[Sync] Bookmark already exists in target folder:", bookmark.url);
          return;
        }
      }
      await withRemoteChange(() => browser.bookmarks.create({
          parentId,
          title: bookmark.title || "Untitled",
          url: bookmark.url,
      }));
      console.log("[Sync] Created bookmark:", bookmark.title);
    } else if (action === "update") {
      const parentId = await targetParentIdFor(bookmark);
      if (bookmark.url) {
        const existing = await findBookmarkInParent(bookmark.url, parentId);
        if (existing) {
          const changes = {};
          if (bookmark.title) changes.title = bookmark.title;
          if (bookmark.url) changes.url = bookmark.url;
          await withRemoteChange(() => browser.bookmarks.update(existing.id, changes));
          console.log("[Sync] Updated bookmark:", bookmark.title);
        }
      }
    } else if (action === "remove") {
      if (bookmark.url) {
        const existing = await browser.bookmarks.search({ url: bookmark.url });
        for (const b of existing) {
          await withRemoteChange(() => browser.bookmarks.remove(b.id));
          console.log("[Sync] Removed bookmark:", bookmark.url);
        }
      }
    }
  } catch (err) {
    console.error("[Sync] Error applying change:", err);
  }
}

browser.bookmarks.onCreated.addListener(async (_id, node) => {
  if (applyingRemoteChange) return;
  try {
    await sendLocalBookmarkChange("create", await localBookmarkPayload(node));
  } catch (err) {
    console.error("[Sync] Failed to upload created bookmark:", err);
  }
});

browser.bookmarks.onChanged.addListener(async (id) => {
  if (applyingRemoteChange) return;
  try {
    const nodes = await browser.bookmarks.get(id);
    await sendLocalBookmarkChange("update", await localBookmarkPayload(nodes[0]));
  } catch (err) {
    console.error("[Sync] Failed to upload changed bookmark:", err);
  }
});

browser.bookmarks.onMoved.addListener(async (id) => {
  if (applyingRemoteChange) return;
  try {
    const nodes = await browser.bookmarks.get(id);
    await sendLocalBookmarkChange("update", await localBookmarkPayload(nodes[0]));
  } catch (err) {
    console.error("[Sync] Failed to upload moved bookmark:", err);
  }
});

browser.bookmarks.onRemoved.addListener(async (id, removeInfo) => {
  if (applyingRemoteChange) return;
  try {
    const node = removeInfo.node;
    await sendLocalBookmarkChange("remove", await localBookmarkPayload({ ...node, id }, removeInfo.parentId));
  } catch (err) {
    console.error("[Sync] Failed to upload removed bookmark:", err);
  }
});

// --- WebSocket ---

async function connectWebSocket() {
  const config = await getConfig();
  if (!config.pair_id || !config.api_url || !config.device_id || !config.device_token) {
    console.log("[Sync] Not configured, scheduling reconnect...");
    scheduleReconnect(10000);
    return;
  }

  const wsUrl = normalizeApiUrl(config.api_url).replace("https://", "wss://").replace("http://", "ws://");
  const params = new URLSearchParams({
    pair_id: config.pair_id,
    device_id: config.device_id,
    device_token: config.device_token,
    browser: "firefox",
  });
  const url = `${wsUrl}/ws?${params.toString()}`;

  try {
    ws = new WebSocket(url);

    ws.onopen = () => {
      console.log("[Sync] WebSocket connected");
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "ping" }));
        }
      }, 30000);
    };

    ws.onmessage = async (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "bookmark_change") {
          await applyBookmarkChange(data);
          const cfg = await getConfig();
          cfg.last_sync = Date.now();
          await saveConfig(cfg);
        }
      } catch (err) {
        console.error("[Sync] Failed to process WS message:", err);
      }
    };

    ws.onclose = () => {
      console.log("[Sync] WebSocket disconnected");
      if (pingTimer) clearInterval(pingTimer);
      ws = null;
      scheduleReconnect(5000);
    };

    ws.onerror = (err) => {
      console.error("[Sync] WebSocket error:", err);
    };
  } catch (err) {
    console.error("[Sync] Failed to create WebSocket:", err);
    scheduleReconnect(5000);
  }
}

function scheduleReconnect(ms) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connectWebSocket, ms);
}

// --- Polling fallback ---

async function checkForChanges() {
  const config = await getConfig();
  if (!config.pair_id || !config.api_url) return;

  try {
    const since = config.last_sync || 0;
    const res = await fetch(`${apiEndpoint(config, "/api/bookmarks/since")}?${authQuery(config)}&since=${since}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    if (data.changes) {
      for (const change of data.changes) {
        await applyBookmarkChange({
          type: "bookmark_change",
          action: change.action,
          bookmark: {
            id: change.bookmark_id,
            title: change.title,
            url: change.url,
            parentId: change.parent_id,
            folderPath: change.folderPath,
            folder_path: change.folder_path,
            index: change.idx,
          }
        });
      }
    }

    config.last_sync = Date.now();
    await saveConfig(config);
  } catch (err) {
    console.error("[Sync] Poll check failed:", err);
  }
}

// --- Full sync ---

async function fullSync() {
  const config = await getConfig();
  if (!config.pair_id || !config.api_url) {
    return { ok: false, error: "Pairing or Worker URL is missing" };
  }

  try {
    const normalizedUrl = normalizeApiUrl(config.api_url);
    if (normalizedUrl !== config.api_url) {
      config.api_url = normalizedUrl;
      await saveConfig(config);
    }

    let res = await fetch(`${apiEndpoint(config, "/api/bookmarks")}?${authQuery(config)}`);
    let data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    const pushed = await pushMissingLocalBookmarks(data.bookmarks);
    if (pushed > 0) {
      res = await fetch(`${apiEndpoint(config, "/api/bookmarks")}?${authQuery(config)}`);
      data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    }

    let created = 0;
    let skipped = 0;
    if (data.bookmarks) {
      for (const bm of data.bookmarks) {
        const parentId = await targetParentIdFor(bm);
        if (bm.url) {
          const existing = await findBookmarkInParent(bm.url, parentId);
          if (existing) {
            skipped += 1;
            continue;
          }
        }
        await withRemoteChange(() => browser.bookmarks.create({
            parentId,
            title: bm.title || "Untitled",
            url: bm.url || undefined,
        }));
        created += 1;
      }
      config.last_sync = Date.now();
      await saveConfig(config);
    }
    return { ok: true, total: data.count ?? data.bookmarks?.length ?? 0, created, skipped, pushed };
  } catch (err) {
    console.error("Full sync failed:", err);
    return { ok: false, error: err.message || String(err) };
  }
}

// --- Lifecycle ---

browser.runtime.onInstalled.addListener(() => {
  console.log("[Sync] Extension installed");
  connectWebSocket();
  browser.alarms.create("sync-check", { periodInMinutes: 1 });
  browser.alarms.create("full-sync", { periodInMinutes: 30 });
});

browser.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "sync-check") {
    await checkForChanges();
  } else if (alarm.name === "full-sync") {
    await fullSync();
  }
});

browser.runtime.onStartup.addListener(() => {
  connectWebSocket();
});

browser.runtime.onMessage.addListener((message) => {
  if (message.type === "reconnect_ws") {
    return (async () => {
      if (ws) {
        ws.close();
        ws = null;
      }
      if (reconnectTimer) clearTimeout(reconnectTimer);
      await connectWebSocket();
      return { ok: true };
    })();
  } else if (message.type === "full_sync") {
    return fullSync();
  }
});

// Storage change listener
browser.storage.onChanged.addListener((changes) => {
  if (changes[STORAGE_KEY]) {
    if (ws) {
      ws.close();
      ws = null;
    }
    if (reconnectTimer) clearTimeout(reconnectTimer);
    connectWebSocket();
  }
});

connectWebSocket();
console.log("[Sync] Firefox extension background loaded");
