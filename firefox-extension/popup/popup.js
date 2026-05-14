const STORAGE_KEY = "sync_config";

const el = {
  statusPaired: document.getElementById("status-paired"),
  statusUnpaired: document.getElementById("status-unpaired"),
  pairIdDisplay: document.getElementById("pair-id-display"),
  lastSync: document.getElementById("last-sync"),
  pairCode: document.getElementById("pair-code"),
  apiUrl: document.getElementById("api-url"),
};

async function getConfig() {
  const result = await browser.storage.local.get(STORAGE_KEY);
  return result[STORAGE_KEY] || {};
}

function normalizeApiUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function showPaired(config) {
  el.statusPaired.classList.remove("hidden");
  el.statusUnpaired.classList.add("hidden");
  el.pairIdDisplay.textContent = (config.pair_id || "").slice(0, 8) + "...";
  el.lastSync.textContent = config.last_sync
    ? new Date(config.last_sync).toLocaleString()
    : "Never";
}

function showUnpaired() {
  el.statusPaired.classList.add("hidden");
  el.statusUnpaired.classList.remove("hidden");
}

async function init() {
  const config = await getConfig();
  if (config.api_url) el.apiUrl.value = config.api_url;
  if (config.pair_id) showPaired(config); else showUnpaired();
}

document.getElementById("btn-join").addEventListener("click", async () => {
  const code = el.pairCode.value.trim();
  const apiUrl = normalizeApiUrl(el.apiUrl.value);

  if (!/^\d{6}$/.test(code)) {
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
      body: JSON.stringify({ code, browser: "firefox", device_name: "Firefox" }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      alert("Failed to connect: " + (data.error || `HTTP ${res.status}`));
      return;
    }

    const config = {
      pair_id: data.pair_id,
      device_id: data.device_id,
      device_token: data.device_token,
      api_url: apiUrl,
      pair_code: code,
      last_sync: data.server_now || 0,
    };
    await browser.storage.local.set({ [STORAGE_KEY]: config });
    el.apiUrl.value = apiUrl;

    const syncResult = await browser.runtime.sendMessage({ type: "full_sync" });
    if (!syncResult?.ok) {
      alert("Connected, but initial sync failed: " + (syncResult?.error || "unknown error"));
    }
    showPaired(config);
    browser.runtime.sendMessage({ type: "reconnect_ws" }).catch(() => {});
  } catch (err) {
    alert("Connection failed: " + (err?.message || String(err)));
  }
});

document.getElementById("btn-sync-now").addEventListener("click", async () => {
  const syncResult = await browser.runtime.sendMessage({ type: "full_sync" });
  if (!syncResult?.ok) {
    alert("Sync failed: " + (syncResult?.error || "unknown error"));
    return;
  }
  const updated = await getConfig();
  el.lastSync.textContent = updated.last_sync
    ? new Date(updated.last_sync).toLocaleString()
    : "Never";
});

document.getElementById("btn-unpair").addEventListener("click", async () => {
  await browser.storage.local.remove(STORAGE_KEY);
  await browser.storage.local.remove("local_url_map");
  showUnpaired();
});

init();
