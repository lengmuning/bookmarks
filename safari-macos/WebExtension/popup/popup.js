const STORAGE_KEY = "sync_config";
const NATIVE_APP_ID = "com.yourCompany.Safari-Bookmarks-Sync";

const el = {
  statusPaired: document.getElementById("status-paired"),
  statusUnpaired: document.getElementById("status-unpaired"),
  pairIdDisplay: document.getElementById("pair-id-display"),
  lastSync: document.getElementById("last-sync"),
  codeDisplay: document.getElementById("code-display"),
  apiUrl: document.getElementById("api-url"),
  refresh: document.getElementById("btn-refresh"),
};

async function sendNative(action, payload = {}) {
  return browser.runtime.sendNativeMessage(NATIVE_APP_ID, { action, ...payload });
}

async function loadNativeConfig() {
  const response = await sendNative("getConfig");
  if (!response || response.ok === false) {
    throw new Error(response?.error || "Mac app did not return sync state");
  }

  const config = response.config || {};
  await browser.storage.local.set({ [STORAGE_KEY]: config });
  return config;
}

async function init() {
  let config = {};
  try {
    config = await loadNativeConfig();
  } catch (err) {
    const result = await browser.storage.local.get(STORAGE_KEY);
    config = result[STORAGE_KEY] || {};
  }

  render(config);
}

function render(config) {
  el.apiUrl.textContent = config.api_url || "Not configured";
  el.apiUrl.classList.toggle("empty", !config.api_url);

  if (config.pair_id) {
    showPaired(config);
  } else {
    showUnpaired();
  }

  if (config.code) {
    el.codeDisplay.classList.remove("hidden");
    el.codeDisplay.querySelector(".code").textContent = config.code;
  } else {
    el.codeDisplay.classList.add("hidden");
  }
}

function showPaired(config) {
  el.statusPaired.classList.remove("hidden");
  el.statusUnpaired.classList.add("hidden");
  el.pairIdDisplay.textContent = config.pair_id.slice(0, 8) + "...";
  if (config.last_sync) {
    el.lastSync.textContent = new Date(config.last_sync).toLocaleString();
  } else {
    el.lastSync.textContent = "Never";
  }
}

function showUnpaired() {
  el.statusPaired.classList.add("hidden");
  el.statusUnpaired.classList.remove("hidden");
}

el.refresh.addEventListener("click", async () => {
  try {
    render(await loadNativeConfig());
  } catch (err) {
    alert("Could not read Mac app state: " + err.message);
  }
});

init();
