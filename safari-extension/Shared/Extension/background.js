const STORAGE_KEY = "sync_config";

async function getConfig() {
  const result = await browser.storage.local.get(STORAGE_KEY);
  return result[STORAGE_KEY] || {
    pair_id: null, device_id: null, device_token: null, api_url: "", last_sync: 0
  };
}

async function saveConfig(config) {
  await browser.storage.local.set({ [STORAGE_KEY]: config });
}

async function syncToWorker(bookmark, action) {
  const config = await getConfig();
  if (!config.pair_id) {
    console.log("[Sync] Not paired yet, skipping bookmark sync");
    return;
  }

  try {
    const res = await fetch(`${config.api_url}/api/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pair_id: config.pair_id,
        device_id: config.device_id,
        device_token: config.device_token,
        action,
        bookmark: {
          id: bookmark.id,
          title: bookmark.title,
          url: bookmark.url,
          parentId: bookmark.parentId,
          index: bookmark.index,
        },
      }),
    });

    if (res.ok) {
      config.last_sync = Date.now();
      await saveConfig(config);
      console.log(`[Sync] ${action} bookmark: ${bookmark.title || bookmark.url}`);
    } else {
      console.error(`[Sync] Failed to ${action} bookmark:`, await res.text());
    }
  } catch (err) {
    console.error(`[Sync] Error ${action} bookmark:`, err);
  }
}

// Listen for bookmark changes
browser.bookmarks.onCreated.addListener(async (id, bookmark) => {
  await syncToWorker(bookmark, "create");
});

browser.bookmarks.onChanged.addListener(async (id, changeInfo) => {
  const [bookmark] = await browser.bookmarks.get(id);
  const merged = { ...bookmark, ...changeInfo };
  await syncToWorker(merged, "update");
});

browser.bookmarks.onRemoved.addListener(async (id, removeInfo) => {
  await syncToWorker({ id, ...removeInfo.node }, "remove");
});

// Periodic config cleanup
browser.alarms.create("keepalive", { periodInMinutes: 15 });
browser.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "keepalive") {
    console.log("[Sync] Background keepalive");
  }
});

console.log("[Sync] Safari extension background loaded");
