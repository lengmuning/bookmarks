const STORAGE_KEY = "sync_config";
const ALARM_NAME = "sync-check";
const WS_ALARM = "ws-keepalive";

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

// --- Bookmark sync operations ---

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

async function applyBookmarkChange(event) {
  const { action, bookmark } = event;
  try {
    if (action === "create") {
      // Check if URL already exists
      if (bookmark.url) {
        const existing = await chrome.bookmarks.search({ url: bookmark.url });
        if (existing.length > 0) {
          console.log("[Sync] Bookmark already exists:", bookmark.url);
          return;
        }
      }

      await chrome.bookmarks.create({
        parentId: "1",
        title: bookmark.title || "Untitled",
        url: bookmark.url,
      });
      console.log("[Sync] Created bookmark:", bookmark.title);
    } else if (action === "update") {
      // Find by matching bookmark_id stored in our system
      if (bookmark.url) {
        const existing = await chrome.bookmarks.search({ url: bookmark.url });
        if (existing.length > 0) {
          const changes = {};
          if (bookmark.title) changes.title = bookmark.title;
          if (bookmark.url) changes.url = bookmark.url;
          await chrome.bookmarks.update(existing[0].id, changes);
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
    const res = await fetch(`${config.api_url}/api/bookmarks/since?${authQuery(config)}&since=${since}`);
    const data = await res.json();

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
