// Popup shared by the Chrome and Firefox extensions. Source of truth:
// extensions-shared/popup/popup.js, copied by scripts/sync-extensions.sh.

const ext = globalThis.browser ?? globalThis.chrome;
const $ = id => document.getElementById(id);
const show = (id, visible) => $(id).classList.toggle("hidden", !visible);

function setError(text) {
  $("error").textContent = text || "";
  show("error", Boolean(text));
}

function describeResult(result) {
  if (!result) return "—";
  const parts = [
    [result.created, "added"],
    [result.moved, "moved into Safari's folders"],
    [result.duplicatesRemoved, "duplicates merged"],
    [result.removed, "removed"],
    [result.pushed, "uploaded"],
    [result.rejected, "put back"],
  ]
    .filter(([count]) => count > 0)
    .map(([count, label]) => `${count} ${label}`);
  return parts.length ? parts.join(", ") : "No changes";
}

async function send(message) {
  const response = await ext.runtime.sendMessage(message);
  return response || { ok: false, error: "No response from the extension." };
}

async function refresh() {
  const state = await send({ type: "status" });
  const status = state.status || {};
  show("legacy", state.legacyConfig && !state.paired);
  show("unpaired", !state.paired);
  show("paired", state.paired);
  show("backup", Boolean(state.backupCreatedAt));

  const badge = $("badge");
  badge.className = "badge";
  if (!state.paired) {
    badge.textContent = "Not connected";
  } else if (status.auth_failed) {
    badge.textContent = "Stopped";
    badge.classList.add("warn");
  } else {
    badge.textContent = state.connected ? "Live" : "Connected";
    badge.classList.add("ok");
  }

  if (state.paired) {
    $("worker").textContent = state.apiUrl;
    $("last-sync").textContent = status.last_sync_at ? new Date(status.last_sync_at).toLocaleString() : "Never";
    $("last-result").textContent = describeResult(status.last_result);
    $("queued").textContent = String(state.queued);
  }
  setError(status.last_error);
}

async function run(buttonId, busyText, message) {
  const button = $(buttonId);
  const label = button.textContent;
  button.disabled = true;
  button.textContent = busyText;
  try {
    const result = await send(message);
    if (!result.ok) setError(result.error);
    await refresh();
    if (!result.ok) setError(result.error);
  } catch (err) {
    setError(err.message || String(err));
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

$("connect").addEventListener("click", () => {
  const apiUrl = $("api-url").value.trim();
  const code = $("code").value.trim();
  if (!apiUrl || !code) {
    setError("Enter the Worker URL and the pairing code from the Mac app.");
    return;
  }
  run("connect", "Connecting…", { type: "join", apiUrl, code });
});

$("sync").addEventListener("click", () => run("sync", "Syncing…", { type: "sync" }));

$("disconnect").addEventListener("click", () => {
  if (!confirm("Disconnect this browser from the sync group? Your bookmarks stay where they are.")) return;
  run("disconnect", "Disconnecting…", { type: "unpair" });
});

$("backup").addEventListener("click", async () => {
  const { sync_v2_backup: backup } = await ext.storage.local.get("sync_v2_backup");
  if (!backup) return;
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `bookmarks-backup-${new Date(backup.created_at).toISOString().slice(0, 10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
});

refresh().catch(err => setError(err.message || String(err)));
