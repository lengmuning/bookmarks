const STORAGE_KEY = "sync_config";
const ALARM_NAME = "sync-check";
const WS_ALARM = "ws-keepalive";
const SAFARI_ROOT_FOLDER = "Safari Bookmarks";

let wsPort = null;
let applyingRemoteChange = false;

async function getConfig() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return result[STORAGE_KEY] || {
    pair_id: null, device_id: null, api_url: "",
    last_sync: 0, pair_code: null
  };
}

async function saveConfig(config) {
  await chrome.storage.local.set({ [STORAGE_KEY]: config });
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

// --- Bookmark sync operations ---

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
    const existing = await chrome.bookmarks.search({ title: part });
    const folder = existing.find(b => !b.url && b.parentId === currentParent);
    if (folder) {
      currentParent = folder.id;
    } else {
      const created = await chrome.bookmarks.create({
        parentId: currentParent,
        title: part,
      });
      currentParent = created.id;
    }
  }
  return currentParent;
}

async function targetParentIdFor(bookmark) {
  return ensureFolderPath([SAFARI_ROOT_FOLDER, ...normalizeFolderPath(bookmark)], "1");
}

async function findBookmarkInParent(url, parentId) {
  const existing = await chrome.bookmarks.search({ url });
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
    const nodes = await chrome.bookmarks.get(currentId).catch(() => []);
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
    id: `chrome-${node.id}`,
    title: node.title || node.url,
    url: node.url,
    parentId: `chrome-${parentId}`,
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

  const children = await chrome.bookmarks.getChildren(node.id).catch(() => []);
  for (const child of children) {
    await collectLocalBookmarksUnder(child, out);
  }
}

async function collectLocalSafariBookmarks() {
  const roots = await chrome.bookmarks.search({ title: SAFARI_ROOT_FOLDER });
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
            await withRemoteChange(() => chrome.bookmarks.update(existing.id, { title: bookmark.title }));
          }
          console.log("[Sync] Bookmark already exists in target folder:", bookmark.url);
          return;
        }
      }

      await withRemoteChange(() => chrome.bookmarks.create({
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
          await withRemoteChange(() => chrome.bookmarks.update(existing.id, changes));
          console.log("[Sync] Updated bookmark:", bookmark.title);
        }
      }
    } else if (action === "remove") {
      if (bookmark.url) {
        const existing = await chrome.bookmarks.search({ url: bookmark.url });
        for (const b of existing) {
          await withRemoteChange(() => chrome.bookmarks.remove(b.id));
          console.log("[Sync] Removed bookmark:", bookmark.url);
        }
      }
    }
  } catch (err) {
    console.error("[Sync] Error applying change:", err);
  }
}

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
        await withRemoteChange(() => chrome.bookmarks.create({
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

chrome.bookmarks.onCreated.addListener(async (_id, node) => {
  if (applyingRemoteChange) return;
  try {
    await sendLocalBookmarkChange("create", await localBookmarkPayload(node));
  } catch (err) {
    console.error("[Sync] Failed to upload created bookmark:", err);
  }
});

chrome.bookmarks.onChanged.addListener(async (id) => {
  if (applyingRemoteChange) return;
  try {
    const nodes = await chrome.bookmarks.get(id);
    await sendLocalBookmarkChange("update", await localBookmarkPayload(nodes[0]));
  } catch (err) {
    console.error("[Sync] Failed to upload changed bookmark:", err);
  }
});

chrome.bookmarks.onMoved.addListener(async (id) => {
  if (applyingRemoteChange) return;
  try {
    const nodes = await chrome.bookmarks.get(id);
    await sendLocalBookmarkChange("update", await localBookmarkPayload(nodes[0]));
  } catch (err) {
    console.error("[Sync] Failed to upload moved bookmark:", err);
  }
});

chrome.bookmarks.onRemoved.addListener(async (id, removeInfo) => {
  if (applyingRemoteChange) return;
  try {
    const node = removeInfo.node;
    await sendLocalBookmarkChange("remove", await localBookmarkPayload({ ...node, id }, removeInfo.parentId));
  } catch (err) {
    console.error("[Sync] Failed to upload removed bookmark:", err);
  }
});

// --- Offscreen WebSocket management ---

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"]
  });
  if (contexts.length === 0) {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["BLOBS"],
      justification: "Maintain WebSocket connection for bookmark sync"
    });
  }
}

async function closeOffscreen() {
  await chrome.offscreen.closeDocument();
}

// --- Sync check via REST ---

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

// --- Message handling from offscreen document ---

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "ws_message") {
    (async () => {
      await applyBookmarkChange(message.event);
      const config = await getConfig();
      config.last_sync = Date.now();
      await saveConfig(config);
      sendResponse({ ok: true });
    })().catch(err => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  } else if (message.type === "ws_status") {
    console.log("[Sync] WebSocket status:", message.status);
  } else if (message.type === "full_sync") {
    fullSync().then(sendResponse);
    return true;
  }
});

// --- Lifecycle ---

chrome.runtime.onInstalled.addListener(async () => {
  console.log("[Sync] Extension installed");
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
  await ensureOffscreen();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureOffscreen();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) {
    // Polling fallback and keep service worker alive for offscreen messages
    await checkForChanges();
    // Ensure offscreen document stays alive
    await ensureOffscreen();
  }
});

// Keep offscreen document alive
ensureOffscreen();
console.log("[Sync] Chrome extension background loaded");
