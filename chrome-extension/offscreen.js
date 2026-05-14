const STORAGE_KEY = "sync_config";
const PING_INTERVAL_MS = 30000;
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 60000;

let ws = null;
let pingTimer = null;
let reconnectTimer = null;
let reconnectAttempt = 0;

function normalizeApiUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function clearTimers() {
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectAttempt += 1;
  const backoff = Math.min(RECONNECT_BASE_MS * (2 ** Math.min(reconnectAttempt - 1, 5)), RECONNECT_MAX_MS);
  const jitter = Math.floor(Math.random() * 1000);
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, backoff + jitter);
}

async function connect() {
  clearTimers();
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const config = result[STORAGE_KEY] || {};
  if (!config.pair_id || !config.api_url || !config.device_id || !config.device_token) {
    scheduleReconnect();
    return;
  }

  const wsUrl = normalizeApiUrl(config.api_url).replace(/^http/, "ws");
  const params = new URLSearchParams({
    pair_id: config.pair_id,
    device_id: config.device_id,
    device_token: config.device_token, // WS cannot carry Authorization headers
    browser: "chrome",
  });

  try {
    ws = new WebSocket(`${wsUrl}/ws?${params.toString()}`);
  } catch (err) {
    console.error("[Offscreen] WS create failed:", err);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    reconnectAttempt = 0;
    chrome.runtime.sendMessage({ type: "ws_status", status: "connected" }).catch(() => {});
    pingTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "ping" }));
      }
    }, PING_INTERVAL_MS);
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data?.type === "bookmark_change") {
        chrome.runtime.sendMessage({ type: "ws_message", event: data }).catch(() => {});
      }
    } catch (err) {
      console.error("[Offscreen] WS parse failed:", err);
    }
  };

  ws.onclose = () => {
    clearTimers();
    ws = null;
    chrome.runtime.sendMessage({ type: "ws_status", status: "disconnected" }).catch(() => {});
    scheduleReconnect();
  };

  ws.onerror = () => {
    // close handler will fire and trigger reconnect
  };
}

chrome.storage.onChanged.addListener((changes) => {
  if (changes[STORAGE_KEY]) {
    reconnectAttempt = 0;
    if (ws) { try { ws.close(); } catch { /* ignore */ } ws = null; }
    clearTimers();
    connect();
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "offscreen_reconnect") {
    reconnectAttempt = 0;
    if (ws) { try { ws.close(); } catch { /* ignore */ } ws = null; }
    clearTimers();
    connect();
    sendResponse({ ok: true });
    return true;
  }
  return false;
});

connect();
