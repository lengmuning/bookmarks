// Safari Bookmarks Sync — Chrome service worker. The sync logic is in
// lib/sync-core.js, copied from extensions-shared/ (edit it there).
importScripts("lib/canonical.js", "lib/sync-core.js");

self.SyncCore.createSyncCore({ ext: chrome, platform: "chrome", deviceName: "Chrome" }).install();
