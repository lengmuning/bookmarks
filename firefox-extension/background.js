const STORAGE_KEY = "sync_config";
let ws = null;
let pingTimer = null;
let reconnectTimer = null;

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

// --- Bookmark operations ---

async function applyBookmarkChange(event) {
  const { action, bookmark } = event;
  try {
    if (action === "create") {
      if (bookmark.url) {
        const existing = await browser.bookmarks.search({ url: bookmark.url });
        if (existing.length > 0) {
          console.log("[Sync] Bookmark already exists:", bookmark.url);
          return;
        }
      }
      await browser.bookmarks.create({
        parentId: "unfiled_____",
        title: bookmark.title || "Untitled",
        url: bookmark.url,
      });
      console.log("[Sync] Created bookmark:", bookmark.title);
    } else if (action === "update") {
      if (bookmark.url) {
        const existing = await browser.bookmarks.search({ url: bookmark.url });
        if (existing.length > 0) {
          const changes = {};
          if (bookmark.title) changes.title = bookmark.title;
          if (bookmark.url) changes.url = bookmark.url;
          await browser.bookmarks.update(existing[0].id, changes);
          console.log("[Sync] Updated bookmark:", bookmark.title);
        }
      }
    } else if (action === "remove") {
      if (bookmark.url) {
        const existing = await browser.bookmarks.search({ url: bookmark.url });
        for (const b of existing) {
          await browser.bookmarks.remove(b.id);
          console.log("[Sync] Removed bookmark:", bookmark.url);
        }
      }
    }
  } catch (err) {
    console.error("[Sync] Error applying change:", err);
  }
}

// --- WebSocket ---

async function connectWebSocket() {
  const config = await getConfig();
  if (!config.pair_id || !config.api_url || !config.device_id || !config.device_token) {
    console.log("[Sync] Not configured, scheduling reconnect...");
    scheduleReconnect(10000);
    return;
  }

  const wsUrl = config.api_url.replace("https://", "wss://");
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

// --- Full sync ---

async function fullSync() {
  const config = await getConfig();
  if (!config.pair_id || !config.api_url) return;

  try {
    const res = await fetch(`${config.api_url}/api/bookmarks?${authQuery(config)}`);
    const data = await res.json();

    if (data.bookmarks) {
      for (const bm of data.bookmarks) {
        if (bm.url) {
          const existing = await browser.bookmarks.search({ url: bm.url });
          if (existing.length > 0) continue;
        }
        await browser.bookmarks.create({
          parentId: "unfiled_____",
          title: bm.title || "Untitled",
          url: bm.url || undefined,
        });
      }
      config.last_sync = Date.now();
      await saveConfig(config);
    }
  } catch (err) {
    console.error("Full sync failed:", err);
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

browser.runtime.onMessage.addListener(async (message) => {
  if (message.type === "reconnect_ws") {
    if (ws) {
      ws.close();
      ws = null;
    }
    if (reconnectTimer) clearTimeout(reconnectTimer);
    await connectWebSocket();
  } else if (message.type === "full_sync") {
    await fullSync();
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
