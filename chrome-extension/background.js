const STORAGE_KEY = "sync_config";
const ALARM_NAME = "sync-check";
const WS_ALARM = "ws-keepalive";
const SAFARI_ROOT_FOLDER = "Safari Bookmarks";

let wsPort = null;

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

async function applyBookmarkChange(event) {
  const { action, bookmark } = event;
  try {
    if (action === "create") {
      const parentId = await targetParentIdFor(bookmark);

      if (bookmark.url) {
        const existing = await findBookmarkInParent(bookmark.url, parentId);
        if (existing) {
          if (bookmark.title && existing.title !== bookmark.title) {
            await chrome.bookmarks.update(existing.id, { title: bookmark.title });
          }
          console.log("[Sync] Bookmark already exists in target folder:", bookmark.url);
          return;
        }
      }

      await chrome.bookmarks.create({
        parentId,
        title: bookmark.title || "Untitled",
        url: bookmark.url,
      });
      console.log("[Sync] Created bookmark:", bookmark.title);
    } else if (action === "update") {
      const parentId = await targetParentIdFor(bookmark);
      if (bookmark.url) {
        const existing = await findBookmarkInParent(bookmark.url, parentId);
        if (existing) {
          const changes = {};
          if (bookmark.title) changes.title = bookmark.title;
          if (bookmark.url) changes.url = bookmark.url;
          await chrome.bookmarks.update(existing.id, changes);
          console.log("[Sync] Updated bookmark:", bookmark.title);
        }
      }
    } else if (action === "remove") {
      if (bookmark.url) {
        const existing = await chrome.bookmarks.search({ url: bookmark.url });
        for (const b of existing) {
          await chrome.bookmarks.remove(b.id);
          console.log("[Sync] Removed bookmark:", bookmark.url);
        }
      }
    }
  } catch (err) {
    console.error("[Sync] Error applying change:", err);
  }
}

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

chrome.runtime.onMessage.addListener(async (message) => {
  if (message.type === "ws_message") {
    // Received a bookmark change from the WebSocket
    await applyBookmarkChange(message.event);
    // Update last_sync timestamp
    const config = await getConfig();
    config.last_sync = Date.now();
    await saveConfig(config);
  } else if (message.type === "ws_status") {
    console.log("[Sync] WebSocket status:", message.status);
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
