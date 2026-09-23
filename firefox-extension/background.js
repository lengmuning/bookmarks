// Safari Bookmarks Sync — Firefox background script. lib/canonical.js and
// lib/sync-core.js (copied from extensions-shared/) are loaded first, see
// manifest.json.
globalThis.SyncCore.createSyncCore({ ext: browser, platform: "firefox", deviceName: "Firefox" }).install();
