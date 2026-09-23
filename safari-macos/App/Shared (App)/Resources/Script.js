const els = {};

function send(action, data = {}) {
    webkit.messageHandlers.controller.postMessage({ action, ...data });
}

function setStatus(message) {
    els.status.textContent = message;
}

function updateState(state) {
    els.apiUrl.value = state.api_url || "";
    els.autoCheck.checked = Boolean(state.auto_check_enabled);
    els.extensionState.textContent = state.extension_enabled
        ? "Safari extension is enabled."
        : "Safari extension is not enabled.";

    if (state.pair_id) {
        els.pairState.textContent = `Paired: ${state.pair_id.slice(0, 8)}...`;
    } else {
        els.pairState.textContent = "Not paired";
    }

    if (state.code) {
        els.pairCode.textContent = state.code;
        els.pairCode.classList.remove("hidden");
    } else {
        els.pairCode.classList.add("hidden");
    }

    if (state.bookmarks_file) {
        els.bookmarksState.textContent = state.bookmarks_file;
    }

    if (state.last_sync) {
        const date = new Date(state.last_sync);
        setStatus(`Last sync: ${date.toLocaleString()}`);
    }

    if (state.last_remote_check) {
        const date = new Date(state.last_remote_check);
        els.remoteState.textContent = `${state.pending_remote_count || 0} remote changes pending. Last checked: ${date.toLocaleString()}`;
    } else {
        els.remoteState.textContent = `${state.pending_remote_count || 0} remote changes pending.`;
    }
}

window.nativeResult = function nativeResult(action, payload) {
    if (payload && payload.error) {
        setStatus(payload.error);
        return;
    }

    if (action === "state" || action === "generatePair" || action === "chooseBookmarksFile" || action === "saveUrl" || action === "setAutoCheck") {
        updateState(payload);
        if (action === "saveUrl") setStatus("Worker URL saved.");
        if (action === "setAutoCheck") setStatus(`Auto check ${payload.auto_check_enabled ? "enabled" : "disabled"}.`);
        return;
    }

    if (action === "syncNow") {
        updateState(payload.state);
        setStatus(`Synced ${payload.synced} Safari bookmarks.`);
        return;
    }

    if (action === "pullRemoteChanges") {
        updateState(payload.state);
        setStatus(`Pulled ${payload.added} new Safari bookmarks from ${payload.remote} remote records. Restart Safari if changes are not visible.`);
        return;
    }

    if (action === "checkRemoteChanges" || action === "autoCheckRemoteChanges") {
        updateState(payload.state);
        if (payload.error) {
            setStatus(payload.error);
            return;
        }
        const message = payload.pending === 1
            ? "1 remote change is ready to apply."
            : `${payload.pending} remote changes are ready to apply.`;
        setStatus(action === "autoCheckRemoteChanges" ? `Auto check: ${message}` : message);
    }
};

window.addEventListener("DOMContentLoaded", () => {
    els.apiUrl = document.getElementById("api-url");
    els.saveUrl = document.getElementById("save-url");
    els.generateCode = document.getElementById("generate-code");
    els.chooseBookmarks = document.getElementById("choose-bookmarks");
    els.syncNow = document.getElementById("sync-now");
    els.pullRemote = document.getElementById("pull-remote");
    els.checkRemote = document.getElementById("check-remote");
    els.autoCheck = document.getElementById("auto-check");
    els.openSettings = document.getElementById("open-settings");
    els.extensionState = document.getElementById("extension-state");
    els.pairState = document.getElementById("pair-state");
    els.pairCode = document.getElementById("pair-code");
    els.bookmarksState = document.getElementById("bookmarks-state");
    els.remoteState = document.getElementById("remote-state");
    els.status = document.getElementById("status");

    els.saveUrl.addEventListener("click", () => send("saveUrl", { api_url: els.apiUrl.value.trim() }));
    els.generateCode.addEventListener("click", () => send("generatePair", { api_url: els.apiUrl.value.trim() }));
    els.chooseBookmarks.addEventListener("click", () => send("chooseBookmarksFile"));
    els.syncNow.addEventListener("click", () => send("syncNow", { api_url: els.apiUrl.value.trim() }));
    els.pullRemote.addEventListener("click", () => send("pullRemoteChanges", { api_url: els.apiUrl.value.trim() }));
    els.checkRemote.addEventListener("click", () => send("checkRemoteChanges", { api_url: els.apiUrl.value.trim() }));
    els.autoCheck.addEventListener("change", () => send("setAutoCheck", { enabled: els.autoCheck.checked, api_url: els.apiUrl.value.trim() }));
    els.openSettings.addEventListener("click", () => send("open-preferences"));

    send("getState");
});
