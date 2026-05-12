const STORAGE_KEY = "sync_config";

const el = {
  statusPaired: document.getElementById("status-paired"),
  statusUnpaired: document.getElementById("status-unpaired"),
  pairIdDisplay: document.getElementById("pair-id-display"),
  lastSync: document.getElementById("last-sync"),
  codeDisplay: document.getElementById("code-display"),
  apiUrl: document.getElementById("api-url"),
};

async function init() {
  const result = await browser.storage.local.get(STORAGE_KEY);
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

document.getElementById("btn-generate").addEventListener("click", async () => {
  const result = await browser.storage.local.get(STORAGE_KEY);
  const config = result[STORAGE_KEY] || {};
  const apiUrl = el.apiUrl.value.trim() || config.api_url;

  if (!apiUrl) {
    alert("Please enter your Worker URL first");
    return;
  }

  try {
    const res = await fetch(`${apiUrl}/api/pair/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ browser: "safari", device_name: "Safari" }),
    });
    const data = await res.json();

    config.pair_id = data.pair_id;
    config.device_id = data.device_id;
    config.device_token = data.device_token;
    config.api_url = apiUrl;
    config.code = data.code;
    await browser.storage.local.set({ [STORAGE_KEY]: config });

    const codeDiv = document.getElementById("code-display");
    codeDiv.classList.remove("hidden");
    codeDiv.querySelector(".code").textContent = data.code;

    showPaired(config);
  } catch (err) {
    alert("Failed to generate pairing code: " + err.message);
  }
});

document.getElementById("btn-unpair").addEventListener("click", async () => {
  await browser.storage.local.remove(STORAGE_KEY);
  el.codeDisplay.classList.add("hidden");
  showUnpaired();
});

document.getElementById("btn-save-url").addEventListener("click", async () => {
  const result = await browser.storage.local.get(STORAGE_KEY);
  const config = result[STORAGE_KEY] || {};
  config.api_url = el.apiUrl.value.trim();
  await browser.storage.local.set({ [STORAGE_KEY]: config });
});

init();
