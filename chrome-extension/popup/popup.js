const STORAGE_KEY = "sync_config";

const el = {
  statusPaired: document.getElementById("status-paired"),
  statusUnpaired: document.getElementById("status-unpaired"),
  pairIdDisplay: document.getElementById("pair-id-display"),
  lastSync: document.getElementById("last-sync"),
  pairCode: document.getElementById("pair-code"),
  apiUrl: document.getElementById("api-url"),
};

const SAFARI_ROOT_FOLDER = "Safari Bookmarks";

async function init() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const config = result[STORAGE_KEY] || {};

  if (config.api_url) el.apiUrl.value = config.api_url;

  if (config.pair_id) {
    showPaired(config);
  } else {
    showUnpaired();
  }
}

function showPaired(config) {
  el.statusPaired.classList.remove("hidden");
  el.statusUnpaired.classList.add("hidden");
  el.pairIdDisplay.textContent = config.pair_id.slice(0, 8) + "...";
  if (config.last_sync) {
    el.lastSync.textContent = new Date(config.last_sync).toLocaleString();
  }
}

function showUnpaired() {
  el.statusPaired.classList.add("hidden");
  el.statusUnpaired.classList.remove("hidden");
}

function normalizeApiUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

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

document.getElementById("btn-join").addEventListener("click", async () => {
  const code = el.pairCode.value.trim();
  const apiUrl = normalizeApiUrl(el.apiUrl.value);

  if (!code || code.length !== 6) {
    alert("Please enter a valid 6-digit pairing code");
    return;
  }
  if (!apiUrl) {
    alert("Please enter the Worker URL");
    return;
  }

  try {
    const res = await fetch(`${apiUrl}/api/pair/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, browser: "chrome", device_name: "Chrome" }),
    });
    const data = await res.json();

    if (data.error) {
      alert("Failed to connect: " + data.error);
      return;
    }

    const config = {
      pair_id: data.pair_id,
      device_id: data.device_id,
      device_token: data.device_token,
      api_url: apiUrl,
      pair_code: code,
      last_sync: 0
    };
    await chrome.storage.local.set({ [STORAGE_KEY]: config });
    el.apiUrl.value = apiUrl;

    // Trigger full sync
    const syncResult = await fullSync(apiUrl, data.pair_id);
    if (!syncResult.ok) {
      alert("Connected, but initial sync failed: " + syncResult.error);
    }
    showPaired(config);

    // Notify offscreen document to connect WebSocket
    chrome.runtime.sendMessage({ type: "reconnect_ws" });
  } catch (err) {
    alert("Connection failed: " + err.message);
  }
});

async function fullSync(apiUrl, pairId) {
  try {
    const config = await getConfig();
    const normalizedUrl = normalizeApiUrl(apiUrl);
    if (normalizedUrl !== config.api_url) {
      await chrome.storage.local.set({ [STORAGE_KEY]: { ...config, api_url: normalizedUrl } });
    }
    const params = new URLSearchParams({
      pair_id: pairId,
      device_id: config.device_id,
      device_token: config.device_token,
    });
    const res = await fetch(`${normalizedUrl}/api/bookmarks?${params.toString()}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

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
        await chrome.bookmarks.create({
          parentId,
          title: bm.title || "Untitled",
          url: bm.url || undefined,
        });
        created += 1;
      }

      await chrome.storage.local.set({
        [STORAGE_KEY]: { ...await getConfig(), last_sync: Date.now() }
      });
    }
    return { ok: true, total: data.count ?? data.bookmarks?.length ?? 0, created, skipped };
  } catch (err) {
    console.error("Full sync failed:", err);
    return { ok: false, error: err.message || String(err) };
  }
}

async function getConfig() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return result[STORAGE_KEY] || {};
}

document.getElementById("btn-sync-now").addEventListener("click", async () => {
  const config = await getConfig();
  const syncResult = await fullSync(config.api_url, config.pair_id);
  if (!syncResult.ok) {
    alert("Sync failed: " + syncResult.error);
    return;
  }
  const updated = await getConfig();
  el.lastSync.textContent = new Date(updated.last_sync).toLocaleString();
});

document.getElementById("btn-unpair").addEventListener("click", async () => {
  await chrome.storage.local.remove(STORAGE_KEY);
  showUnpaired();
});

init();
