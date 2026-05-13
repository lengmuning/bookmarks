const STORAGE_KEY = "sync_config";

const el = {
  statusPaired: document.getElementById("status-paired"),
  statusUnpaired: document.getElementById("status-unpaired"),
  pairIdDisplay: document.getElementById("pair-id-display"),
  lastSync: document.getElementById("last-sync"),
  pairCode: document.getElementById("pair-code"),
  apiUrl: document.getElementById("api-url"),
};

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
    const syncResult = await chrome.runtime.sendMessage({ type: "full_sync" });
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

async function getConfig() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return result[STORAGE_KEY] || {};
}

document.getElementById("btn-sync-now").addEventListener("click", async () => {
  const syncResult = await chrome.runtime.sendMessage({ type: "full_sync" });
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
