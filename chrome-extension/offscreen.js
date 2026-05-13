const STORAGE_KEY = "sync_config";
let ws = null;
let reconnectTimer = null;
let pingTimer = null;

function normalizeApiUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

async function connect() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const config = result[STORAGE_KEY] || {};
  if (!config.pair_id || !config.api_url || !config.device_id || !config.device_token) {
    console.log("[Offscreen] Not configured, skipping WebSocket");
    scheduleReconnect(5000);
    return;
  }

  const wsUrl = normalizeApiUrl(config.api_url).replace("https://", "wss://").replace("http://", "ws://");
  const params = new URLSearchParams({
    pair_id: config.pair_id,
    device_id: config.device_id,
    device_token: config.device_token,
    browser: "chrome",
  });
  const url = `${wsUrl}/ws?${params.toString()}`;

  try {
    ws = new WebSocket(url);

    ws.onopen = () => {
      console.log("[Offscreen] WebSocket connected");
      chrome.runtime.sendMessage({ type: "ws_status", status: "connected" });
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "ping" }));
        }
      }, 30000);
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "bookmark_change") {
          chrome.runtime.sendMessage({ type: "ws_message", event: data });
        }
      } catch (err) {
        console.error("[Offscreen] Failed to parse WS message:", err);
      }
    };

    ws.onclose = () => {
      console.log("[Offscreen] WebSocket disconnected");
      chrome.runtime.sendMessage({ type: "ws_status", status: "disconnected" });
      if (pingTimer) clearInterval(pingTimer);
      ws = null;
      scheduleReconnect(5000);
    };

    ws.onerror = (err) => {
      console.error("[Offscreen] WebSocket error:", err);
    };
  } catch (err) {
    console.error("[Offscreen] Failed to create WebSocket:", err);
    scheduleReconnect(5000);
  }
}

function scheduleReconnect(ms) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, ms);
}

// Listen for config updates from popup/background
chrome.storage.onChanged.addListener((changes) => {
  if (changes[STORAGE_KEY]) {
    console.log("[Offscreen] Config changed, reconnecting...");
    if (ws) {
      ws.close();
      ws = null;
    }
    if (reconnectTimer) clearTimeout(reconnectTimer);
    connect();
  }
});

connect();
console.log("[Offscreen] Offscreen document loaded");
