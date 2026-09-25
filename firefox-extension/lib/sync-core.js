// Shared sync engine for the Chrome and Firefox extensions (protocol v2, see
// docs/SYNC-V2.md). Source of truth: extensions-shared/sync-core.js, copied
// into each extension by scripts/sync-extensions.sh.
//
// Placement rule: Safari's folders are authoritative. A bookmark whose URL is
// in the sync group exists exactly once in the browser, under
// "Other Bookmarks / Safari Bookmarks / <Safari folder path>"; copies found
// anywhere else in the browser are moved there or removed.
//
// Deletes go both ways: removing a bookmark here deletes it everywhere,
// Safari included. A large delete is put back until the user confirms it in
// the popup (`pending_deletions` in the status).

(function (root) {
  "use strict";

  const KEYS = {
    config: "sync_v2_config",
    queue: "sync_v2_queue",
    ids: "sync_v2_ids",
    status: "sync_v2_status",
    backup: "sync_v2_backup",
  };
  const LEGACY_KEYS = ["sync_config", "local_url_map"];
  const ROOT_TITLE = "Safari Bookmarks";
  // A sync root found when joining is renamed to this and a fresh root is
  // created: bookmarks Safari has are moved out of it, what is left (for
  // example leftovers of the v1 extension, which never synced deletes) stays
  // for the user to review instead of being uploaded back into Safari.
  const PREVIOUS_ROOT_TITLE = "Safari Bookmarks (before sync v2)";
  const OTHER_FOLDER_IDS = ["2", "unfiled_____"];
  const MARK_TTL_MS = 10_000;
  const FLUSH_DELAY_MS = 1_500;
  const PULL_DELAY_MS = 1_000;
  const OPS_PER_REQUEST = 200;
  const CHANGES_PAGE = 500;
  const EMPTY_FOLDER_GRACE_MS = 10 * 60 * 1000;
  const WS_PING_MS = 20_000;
  const RECONNECT_BASE_MS = 2_000;
  const RECONNECT_MAX_MS = 60_000;
  const ALARMS = { poll: ["sync-poll", 1], full: ["sync-full", 30] };

  class ApiError extends Error {
    constructor(status, code) {
      super(code);
      this.status = status;
      this.code = code;
    }
  }

  function normalizeApiUrl(value) {
    const trimmed = String(value || "").trim().replace(/\/+$/, "");
    try {
      const parsed = new URL(trimmed);
      return parsed.protocol === "https:" || parsed.protocol === "http:" ? trimmed : null;
    } catch {
      return null;
    }
  }

  const isFolder = node => !node.url && node.type !== "separator";
  const isFatal = err => err instanceof ApiError && (err.status === 401 || err.code === "group_disabled");
  const isCursorExpired = err => err instanceof ApiError && err.code === "cursor_expired";
  const segment = title => String(title || "").trim();
  const message = err => (err && err.message) || String(err);

  function joinError(status, code) {
    if (status === 404) return "The pairing code is wrong, already used or expired. Generate a new one in the Mac app.";
    if (status === 429) return "Too many attempts from this network. Try again in an hour.";
    if (status === 400) return "Enter the 8-character pairing code shown in the Mac app.";
    return `The Worker refused the request (${status} ${code || ""}).`.trim();
  }

  function newStats() {
    return { created: 0, moved: 0, retitled: 0, duplicatesRemoved: 0, removed: 0, pushed: 0, rejected: 0 };
  }

  function createSyncCore(options) {
    const { ext, platform, deviceName } = options;
    const { canonicalUrl } = root.SyncCanonical;
    const fetchImpl = options.fetch || ((...args) => fetch(...args));
    const now = options.now || (() => Date.now());
    const setTimer = options.setTimeout || ((fn, ms) => setTimeout(fn, ms));
    const clearTimer = options.clearTimeout || (id => clearTimeout(id));
    const setRepeat = options.setInterval || ((fn, ms) => setInterval(fn, ms));
    const clearRepeat = options.clearInterval || (id => clearInterval(id));
    const WebSocketImpl = options.WebSocket === undefined ? globalThis.WebSocket : options.WebSocket;
    const log = options.log || console;

    // ---------------------------------------------------------------- locking
    // Everything that reads or writes bookmarks runs one at a time.
    let lock = Promise.resolve();
    function exclusive(fn) {
      const run = lock.then(fn, fn);
      lock = run.catch(() => {});
      return run;
    }

    // ------------------------------------------------------- echo suppression
    // Our own bookmark writes fire the same events as user edits. They are
    // marked before the write and the mark is checked when the event arrives.
    const urlMarks = new Map();
    const nodeMarks = new Map();
    const markUrl = url => url && urlMarks.set(url, now() + MARK_TTL_MS);
    const markNode = id => id && nodeMarks.set(id, now() + MARK_TTL_MS);
    function marked(map, key) {
      const expiry = key && map.get(key);
      if (!expiry) return false;
      if (expiry < now()) {
        map.delete(key);
        return false;
      }
      return true;
    }

    // ---------------------------------------------------------------- storage
    async function load(key, fallback) {
      const result = await ext.storage.local.get(key);
      return result[key] === undefined ? fallback : result[key];
    }
    const save = (key, value) => ext.storage.local.set({ [key]: value });
    const getConfig = () => load(KEYS.config, null);
    const saveConfig = config => save(KEYS.config, config);

    async function setStatus(patch) {
      const status = await load(KEYS.status, {});
      await save(KEYS.status, { ...status, ...patch });
    }

    // "!" on the toolbar icon while a large delete waits for confirmation.
    async function updateBadge() {
      const action = ext.action || ext.browserAction;
      if (!action || !action.setBadgeText) return;
      const status = await load(KEYS.status, {});
      const waiting = Boolean(status.pending_deletions && status.pending_deletions.urls.length);
      try {
        await action.setBadgeText({ text: waiting ? "!" : "" });
        if (waiting && action.setBadgeBackgroundColor) await action.setBadgeBackgroundColor({ color: "#d92d20" });
      } catch (err) {
        log.warn("[sync] could not update the badge", err);
      }
    }

    // id -> { u: canonical url, p: parent, s: 1 if the server had it at the
    // last full sync } for bookmarks and { f: 1, p } for folders inside the
    // sync root. Needed because a removed folder does not always report its
    // children (Firefox), onChanged does not report the previous URL, and a
    // bookmark missing from the server must be told apart from a new one.
    let ids = null;
    async function loadIds() {
      if (!ids) ids = await load(KEYS.ids, {});
      return ids;
    }
    const saveIds = () => save(KEYS.ids, ids || {});

    // -------------------------------------------------------------------- http
    async function api(config, method, path, body) {
      const headers = { Authorization: `Bearer ${config.token}` };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      const res = await fetchImpl(config.api_url + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      let data = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      if (!res.ok) {
        const code = (data && data.error) || `http_${res.status}`;
        if (res.status === 401) {
          await setStatus({ auth_failed: true, last_error: "This browser was removed from the sync group. Pair it again." });
        } else if (code === "group_disabled") {
          await setStatus({ auth_failed: true, last_error: "The Worker's administrator disabled this sync group." });
        }
        throw new ApiError(res.status, code);
      }
      return data;
    }

    // ------------------------------------------------------------ bookmark tree
    function pickOtherFolder(tree) {
      const children = tree.children || [];
      return (
        children.find(n => OTHER_FOLDER_IDS.includes(n.id)) ||
        children.find(n => /other/i.test(n.title || "")) ||
        children[children.length - 1]
      );
    }

    function containsFolder(node, id) {
      if (node.id === id) return isFolder(node);
      return (node.children || []).some(child => containsFolder(child, id));
    }

    async function buildIndex(config) {
      const [tree] = await ext.bookmarks.getTree();
      let rootId = config.root_id && containsFolder(tree, config.root_id) ? config.root_id : null;
      if (!rootId) {
        const other = pickOtherFolder(tree);
        const existing = (other.children || []).find(n => isFolder(n) && n.title === ROOT_TITLE);
        const created = existing ? null : await ext.bookmarks.create({ parentId: other.id, title: ROOT_TITLE });
        config.root_id = existing ? existing.id : created.id;
        await saveConfig(config);
        if (created) return buildIndex(config);
        rootId = config.root_id;
      }

      const index = {
        rootId,
        byUrl: new Map(), // canonical url -> [entry]
        entries: new Map(), // bookmark id -> entry
        childFolders: new Map([[rootId, new Map()]]), // folder id -> Map(name -> folder id), inside the root
        folderPaths: new Map([[rootId, []]]),
      };

      const visit = (node, relPath) => {
        for (const child of node.children || []) {
          if (child.url) {
            const url = canonicalUrl(child.url);
            if (!url || child.unmodifiable) continue;
            const entry = {
              id: child.id,
              parentId: node.id,
              title: child.title || "",
              url,
              dateAdded: child.dateAdded || 0,
              inRoot: relPath !== null,
            };
            index.entries.set(child.id, entry);
            if (!index.byUrl.has(url)) index.byUrl.set(url, []);
            index.byUrl.get(url).push(entry);
          } else if (isFolder(child)) {
            let childPath = null;
            if (child.id === rootId) {
              childPath = [];
            } else if (relPath !== null) {
              const name = segment(child.title);
              childPath = name ? [...relPath, name] : relPath;
              const siblings = index.childFolders.get(node.id);
              if (name && siblings && !siblings.has(name)) siblings.set(name, child.id);
              index.childFolders.set(child.id, new Map());
              index.folderPaths.set(child.id, childPath);
            }
            visit(child, childPath);
          }
        }
      };
      visit(tree, null);
      return index;
    }

    async function ensureFolder(index, path) {
      await loadIds();
      let parent = index.rootId;
      for (const raw of path) {
        const name = segment(raw);
        if (!name) continue;
        let children = index.childFolders.get(parent);
        if (!children) index.childFolders.set(parent, (children = new Map()));
        let id = children.get(name);
        if (!id) {
          const created = await ext.bookmarks.create({ parentId: parent, title: name });
          id = created.id;
          children.set(name, id);
          index.childFolders.set(id, new Map());
          index.folderPaths.set(id, [...(index.folderPaths.get(parent) || []), name]);
          ids[id] = { f: 1, p: parent };
        }
        parent = id;
      }
      return parent;
    }

    function removeEntry(index, entry) {
      index.entries.delete(entry.id);
      const list = (index.byUrl.get(entry.url) || []).filter(e => e !== entry);
      if (list.length) index.byUrl.set(entry.url, list);
      else index.byUrl.delete(entry.url);
      if (ids) delete ids[entry.id];
    }

    // Puts the bookmark for a server row in its Safari folder: reuses an
    // existing copy from anywhere in the browser, removes the other copies.
    async function placeRow(index, row, stats) {
      await loadIds();
      const target = await ensureFolder(index, row.folderPath || []);
      const title = row.title || "";
      const copies = (index.byUrl.get(row.url) || []).slice();

      if (!copies.length) {
        markUrl(row.url);
        const node = await ext.bookmarks.create({ parentId: target, title, url: row.url });
        const entry = { id: node.id, parentId: target, title, url: row.url, dateAdded: node.dateAdded || now(), inRoot: true };
        index.entries.set(node.id, entry);
        index.byUrl.set(row.url, [entry]);
        ids[node.id] = { u: row.url, p: target, s: 1 };
        stats.created += 1;
        return;
      }

      const keep =
        copies.find(c => c.parentId === target) ||
        copies.slice().sort((a, b) => a.dateAdded - b.dateAdded)[0];

      if (keep.parentId !== target) {
        markUrl(row.url);
        markNode(keep.id);
        await ext.bookmarks.move(keep.id, { parentId: target });
        keep.parentId = target;
        keep.inRoot = true;
        stats.moved += 1;
      }
      if (keep.title !== title) {
        markUrl(row.url);
        markNode(keep.id);
        await ext.bookmarks.update(keep.id, { title });
        keep.title = title;
        stats.retitled += 1;
      }
      ids[keep.id] = { u: row.url, p: target, s: 1 };

      for (const copy of copies) {
        if (copy === keep) continue;
        markUrl(row.url);
        markNode(copy.id);
        await ext.bookmarks.remove(copy.id).catch(err => log.warn("[sync] could not remove duplicate", err));
        removeEntry(index, copy);
        stats.duplicatesRemoved += 1;
      }
    }

    // A deleted row removes the copies inside the sync root only.
    async function removeRow(index, url, stats) {
      await loadIds();
      for (const entry of (index.byUrl.get(url) || []).slice()) {
        if (!entry.inRoot) continue;
        markUrl(url);
        markNode(entry.id);
        await ext.bookmarks.remove(entry.id).catch(err => log.warn("[sync] could not remove bookmark", err));
        removeEntry(index, entry);
        stats.removed += 1;
      }
    }

    const applyRow = (index, row, stats) => (row.removed ? removeRow(index, row.url, stats) : placeRow(index, row, stats));

    async function pathOf(folderId, rootId) {
      const parts = [];
      let current = folderId;
      for (let depth = 0; current && depth < 64; depth++) {
        if (current === rootId) return parts.reverse();
        const [node] = await ext.bookmarks.get(current).catch(() => []);
        if (!node || !node.parentId) return null;
        const name = segment(node.title);
        if (name) parts.push(name);
        current = node.parentId;
      }
      return null;
    }

    async function rebuildIds(rootId, syncedUrls) {
      const [sub] = await ext.bookmarks.getSubTree(rootId).catch(() => []);
      const next = {};
      const walk = node => {
        for (const child of node.children || []) {
          if (child.url) {
            const url = canonicalUrl(child.url);
            if (url) next[child.id] = syncedUrls.has(url) ? { u: url, p: node.id, s: 1 } : { u: url, p: node.id };
          } else if (isFolder(child)) {
            next[child.id] = { f: 1, p: node.id };
            walk(child);
          }
        }
      };
      if (sub) walk(sub);
      ids = next;
      await saveIds();
    }

    async function cleanupEmptyFolders(rootId) {
      const [sub] = await ext.bookmarks.getSubTree(rootId).catch(() => []);
      if (!sub) return false;
      const cutoff = now() - EMPTY_FOLDER_GRACE_MS;
      const prune = async node => {
        let hasContent = false;
        for (const child of node.children || []) {
          if (!isFolder(child)) {
            hasContent = true;
          } else if (await prune(child)) {
            hasContent = true;
          } else if ((child.dateAdded || 0) < cutoff) {
            markNode(child.id);
            await ext.bookmarks.remove(child.id).catch(() => {});
          } else {
            hasContent = true;
          }
        }
        return hasContent;
      };
      return prune(sub);
    }

    // Renames existing sync roots so the first sync starts from an empty one.
    async function setAsidePreviousRoots() {
      const [tree] = await ext.bookmarks.getTree();
      const other = pickOtherFolder(tree);
      const previous = (other.children || []).filter(n => isFolder(n) && n.title === ROOT_TITLE);
      for (const node of previous) await ext.bookmarks.update(node.id, { title: PREVIOUS_ROOT_TITLE });
      return previous.map(node => node.id);
    }

    async function tidyPreviousRoots(folderIds) {
      for (const id of folderIds) {
        const hasContent = await cleanupEmptyFolders(id);
        if (!hasContent) await ext.bookmarks.remove(id).catch(() => {});
      }
    }

    // ------------------------------------------------------------ server calls
    async function sendOps(config, ops, baseCursor, stats, indexRef, confirm = false) {
      const held = [];
      for (let i = 0; i < ops.length; i += OPS_PER_REQUEST) {
        const batch = ops.slice(i, i + OPS_PER_REQUEST);
        let response;
        try {
          const body = { base_cursor: baseCursor, ops: batch };
          if (confirm) body.confirm_deletions = true;
          response = await api(config, "POST", "/v2/changes", body);
        } catch (err) {
          if (err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 401 && err.status !== 429) {
            log.warn("[sync] dropping rejected batch", err.status, err.code);
            continue;
          }
          throw err;
        }
        for (const result of response.results || []) {
          if (result.status === "applied") {
            stats.pushed += 1;
            if (indexRef.applied && result.url) indexRef.applied.add(result.url);
          }
          if (result.status !== "rejected") continue;
          if (result.reason === "mass_delete" && result.url) held.push(result.url);
          else stats.rejected += 1;
          if (!result.state) continue;
          indexRef.index = indexRef.index || (await buildIndex(config));
          await applyRow(indexRef.index, result.state, stats);
        }
      }
      if (held.length) await holdDeletions(held);
    }

    // The server put these bookmarks back; they are deleted only after the
    // user confirms in the popup.
    async function holdDeletions(urls) {
      const status = await load(KEYS.status, {});
      const previous = (status.pending_deletions && status.pending_deletions.urls) || [];
      await setStatus({ pending_deletions: { urls: [...new Set([...previous, ...urls])], at: now() } });
      await updateBadge();
    }

    function confirmDeletions() {
      return exclusive(async () => {
        const config = await getConfig();
        if (!config || !config.token) return { ok: false, error: "not_paired" };
        const status = await load(KEYS.status, {});
        const urls = (status.pending_deletions && status.pending_deletions.urls) || [];
        const stats = newStats();
        const ref = { index: null };
        try {
          await sendOps(config, urls.map(url => ({ op: "remove", url })), config.cursor || 0, stats, ref, true);
          await setStatus({ pending_deletions: null });
          await updateBadge();
          // The deletes come back as changes and remove the local copies.
          await pullUnlocked(config, stats, ref);
          await setStatus({ last_result: stats, last_error: null });
          return { ok: true, stats };
        } catch (err) {
          return { ok: false, error: message(err) };
        }
      });
    }

    function keepBookmarks() {
      return exclusive(async () => {
        await setStatus({ pending_deletions: null });
        await updateBadge();
        return { ok: true };
      });
    }

    async function flushQueueUnlocked(config, stats, indexRef) {
      let queue = await load(KEYS.queue, []);
      while (queue.length) {
        const batch = queue.slice(0, OPS_PER_REQUEST);
        await sendOps(config, batch, config.cursor || 0, stats, indexRef);
        queue = (await load(KEYS.queue, [])).slice(batch.length);
        await save(KEYS.queue, queue);
      }
    }

    async function pullUnlocked(config, stats, indexRef) {
      for (;;) {
        const page = await api(config, "GET", `/v2/changes?since=${config.cursor || 0}&limit=${CHANGES_PAGE}`);
        if (page.changes.length) {
          indexRef.index = indexRef.index || (await buildIndex(config));
          for (const row of page.changes) await applyRow(indexRef.index, row, stats);
        }
        config.cursor = page.cursor;
        await saveConfig(config);
        if (!page.has_more) return;
      }
    }

    // Local bookmarks inside the root that the server does not have: if the
    // server had them at the last full sync they were deleted elsewhere and
    // are removed here; otherwise they are new and sent as creates (the
    // server still rejects ones deleted after `baseCursor`).
    async function pushLocal(config, index, knownUrls, baseCursor, stats, applied) {
      await loadIds();
      const ops = [];
      const seen = new Set();
      for (const entry of [...index.entries.values()]) {
        if (!entry.inRoot || knownUrls.has(entry.url)) continue;
        if (ids[entry.id] && ids[entry.id].s && ids[entry.id].u === entry.url) {
          markUrl(entry.url);
          markNode(entry.id);
          await ext.bookmarks.remove(entry.id).catch(err => log.warn("[sync] could not remove bookmark", err));
          removeEntry(index, entry);
          stats.removed += 1;
          continue;
        }
        if (seen.has(entry.url)) continue;
        seen.add(entry.url);
        ops.push({
          op: "create",
          url: entry.url,
          title: entry.title,
          folderPath: index.folderPaths.get(entry.parentId) || [],
        });
      }
      if (ops.length) await sendOps(config, ops, baseCursor, stats, { index, applied });
    }

    // ------------------------------------------------------------- public ops
    async function runFullSync(config, stats) {
      const ref = { index: null };
      await flushQueueUnlocked(config, stats, ref);
      if (config.cursor) {
        await pullUnlocked(config, stats, ref);
      }
      const index = await buildIndex(config);
      const snapshot = await api(config, "GET", "/v2/snapshot");
      for (const row of snapshot.bookmarks) await placeRow(index, row, stats);
      const synced = new Set(snapshot.bookmarks.map(row => row.url));
      // On the first sync the browser has seen no deletes yet, so leftovers
      // from an older setup cannot bring back bookmarks deleted in Safari.
      const baseCursor = config.cursor || 0;
      const applied = new Set();
      await pushLocal(config, index, synced, baseCursor, stats, applied);
      for (const url of applied) synced.add(url);
      if (!config.cursor) {
        config.cursor = snapshot.cursor;
        await saveConfig(config);
      }
      await pullUnlocked(config, stats, { index });
      await cleanupEmptyFolders(index.rootId);
      await rebuildIds(index.rootId, synced);
    }

    function fullSync() {
      return exclusive(async () => {
        const config = await getConfig();
        if (!config || !config.token) return { ok: false, error: "not_paired" };
        const stats = newStats();
        for (let attempt = 0; ; attempt++) {
          try {
            await runFullSync(config, stats);
            await setStatus({ last_sync_at: now(), last_error: null, last_result: stats, auth_failed: false });
            return { ok: true, stats };
          } catch (err) {
            if (attempt === 0 && isCursorExpired(err)) {
              // Deletes older than the server keeps were purged: start over.
              config.cursor = 0;
              await saveConfig(config);
              continue;
            }
            log.error("[sync] full sync failed", err);
            if (!isFatal(err)) await setStatus({ last_error: message(err), last_attempt_at: now() });
            return { ok: false, error: message(err) };
          }
        }
      });
    }

    function poll() {
      return exclusive(async () => {
        const config = await getConfig();
        if (!config || !config.token) return null;
        const status = await load(KEYS.status, {});
        if (status.auth_failed) return null;
        const stats = newStats();
        const ref = { index: null };
        try {
          await flushQueueUnlocked(config, stats, ref);
          if (!config.cursor) return null;
          await pullUnlocked(config, stats, ref);
          await setStatus({ last_poll_at: now(), last_error: null });
          return null;
        } catch (err) {
          if (isCursorExpired(err)) return "resync";
          if (!isFatal(err)) await setStatus({ last_error: message(err), last_attempt_at: now() });
          return null;
        }
      }).then(next => (next === "resync" ? fullSync() : undefined));
    }

    let flushTimer = null;
    function scheduleFlush() {
      if (flushTimer) return;
      flushTimer = setTimer(() => {
        flushTimer = null;
        poll();
      }, FLUSH_DELAY_MS);
    }

    let pullTimer = null;
    function schedulePull() {
      if (pullTimer) return;
      pullTimer = setTimer(() => {
        pullTimer = null;
        poll();
      }, PULL_DELAY_MS);
    }

    let previousRoots = [];

    async function join(apiUrlRaw, code) {
      const outcome = await exclusive(async () => {
        const apiUrl = normalizeApiUrl(apiUrlRaw);
        if (!apiUrl) return { ok: false, error: "Enter a valid Worker URL (https://…)." };

        // Back up the whole tree before anything is moved or removed.
        const [tree] = await ext.bookmarks.getTree();
        try {
          await save(KEYS.backup, { created_at: now(), platform, tree });
        } catch (err) {
          return { ok: false, error: `Could not save a backup of your bookmarks, so nothing was changed. ${message(err)}` };
        }

        let res;
        try {
          res = await fetchImpl(`${apiUrl}/v2/join`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code: String(code || ""), platform, name: deviceName }),
          });
        } catch (err) {
          return { ok: false, error: `Could not reach the Worker: ${message(err)}` };
        }
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return { ok: false, error: joinError(res.status, data.error) };

        await ext.storage.local.remove([...LEGACY_KEYS, KEYS.queue, KEYS.ids, KEYS.status]);
        ids = {};
        previousRoots = await setAsidePreviousRoots();
        await saveConfig({
          api_url: apiUrl,
          token: data.token,
          pair_id: data.pair_id,
          device_id: data.device_id,
          cursor: 0,
          root_id: null,
          joined_at: now(),
        });
        return { ok: true };
      });
      if (!outcome.ok) return outcome;
      const sync = await fullSync();
      if (sync.ok) await exclusive(() => tidyPreviousRoots(previousRoots));
      connectWebSocket();
      return { ok: sync.ok, error: sync.error, stats: sync.stats };
    }

    function unpair() {
      return exclusive(async () => {
        const config = await getConfig();
        disconnectWebSocket();
        if (config && config.token) {
          try {
            await api(config, "DELETE", "/v2/devices/self");
          } catch (err) {
            log.warn("[sync] could not revoke this device on the server", err);
          }
        }
        await ext.storage.local.remove([KEYS.config, KEYS.queue, KEYS.ids, KEYS.status]);
        ids = {};
        await updateBadge();
        return { ok: true };
      });
    }

    async function statusSummary() {
      const [config, status, queue, backup, legacy] = await Promise.all([
        getConfig(),
        load(KEYS.status, {}),
        load(KEYS.queue, []),
        load(KEYS.backup, null),
        ext.storage.local.get(LEGACY_KEYS),
      ]);
      return {
        ok: true,
        paired: Boolean(config && config.token),
        apiUrl: config ? config.api_url : null,
        pairId: config ? config.pair_id : null,
        status,
        queued: queue.length,
        backupCreatedAt: backup ? backup.created_at : null,
        legacyConfig: Boolean(legacy.sync_config),
        connected: Boolean(ws && ws.readyState === 1),
      };
    }

    // ------------------------------------------------------ local bookmark events
    function enqueueFromEvent(build) {
      exclusive(async () => {
        const config = await getConfig();
        if (!config || !config.token || !config.root_id) return;
        await loadIds();
        const ops = await build(config.root_id);
        await saveIds();
        if (!ops.length) return;
        const queue = await load(KEYS.queue, []);
        queue.push(...ops);
        await save(KEYS.queue, queue);
        scheduleFlush();
      }).catch(err => log.error("[sync] could not record a bookmark change", err));
    }

    function collectBookmarks(node, relPath, out) {
      for (const child of node.children || []) {
        if (child.url) {
          const url = canonicalUrl(child.url);
          if (url) out.push({ id: child.id, parentId: node.id, url, title: child.title || "", path: relPath });
        } else if (isFolder(child)) {
          const name = segment(child.title);
          collectBookmarks(child, name ? [...relPath, name] : relPath, out);
        }
      }
      return out;
    }

    function descendantsFromIds(folderId) {
      const folders = new Set([folderId]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const [id, entry] of Object.entries(ids)) {
          if (entry.f && folders.has(entry.p) && !folders.has(id)) {
            folders.add(id);
            grew = true;
          }
        }
      }
      return Object.entries(ids).filter(([id, entry]) => folders.has(entry.p) || folders.has(id));
    }

    function onCreated(id, node) {
      if (!node || !node.url) return;
      const url = canonicalUrl(node.url);
      if (!url || marked(urlMarks, url)) return;
      enqueueFromEvent(async rootId => {
        const path = await pathOf(node.parentId, rootId);
        if (path === null) return [];
        ids[id] = { u: url, p: node.parentId };
        return [{ op: "create", url, title: node.title || "", folderPath: path, index: node.index }];
      });
    }

    function onChanged(id, changeInfo) {
      const changedUrl = changeInfo && changeInfo.url ? canonicalUrl(changeInfo.url) : null;
      if (marked(nodeMarks, id) || marked(urlMarks, changedUrl)) return;
      enqueueFromEvent(async rootId => {
        const [node] = await ext.bookmarks.get(id).catch(() => []);
        if (!node) return [];

        if (!node.url) {
          if (!isFolder(node)) return [];
          const path = await pathOf(id, rootId);
          if (path === null) return [];
          const [sub] = await ext.bookmarks.getSubTree(id).catch(() => []);
          return collectBookmarks(sub || { children: [] }, path, []).map(b => ({
            op: "update",
            url: b.url,
            title: b.title,
            folderPath: b.path,
          }));
        }

        const url = canonicalUrl(node.url);
        const path = await pathOf(node.parentId, rootId);
        if (path === null) return [];
        const previous = ids[id] && ids[id].u;
        ids[id] = previous === url ? { ...ids[id], p: node.parentId } : { u: url, p: node.parentId };
        const ops = [];
        if (previous && previous !== url) ops.push({ op: "remove", url: previous });
        if (url) ops.push({ op: previous && previous !== url ? "create" : "update", url, title: node.title || "", folderPath: path, index: node.index });
        return ops;
      });
    }

    function onMoved(id, moveInfo) {
      if (marked(nodeMarks, id)) return;
      enqueueFromEvent(async rootId => {
        if (id === rootId) return [];
        const [node] = await ext.bookmarks.get(id).catch(() => []);
        if (!node) return [];
        const newPath = await pathOf(moveInfo.parentId, rootId);
        const oldPath = await pathOf(moveInfo.oldParentId, rootId);
        if (newPath === null && oldPath === null) return [];

        const items = [];
        if (node.url) {
          const url = canonicalUrl(node.url);
          if (url) items.push({ id, parentId: node.parentId, url, title: node.title || "", rel: [] });
        } else if (isFolder(node)) {
          const [sub] = await ext.bookmarks.getSubTree(id).catch(() => []);
          const name = segment(node.title);
          for (const b of collectBookmarks(sub || { children: [] }, [], [])) {
            items.push({ ...b, rel: name ? [name, ...b.path] : b.path });
          }
        }

        return items.map(item => {
          if (newPath === null) {
            delete ids[item.id];
            return { op: "remove", url: item.url };
          }
          ids[item.id] = { ...(oldPath === null ? {} : ids[item.id]), u: item.url, p: item.parentId };
          return { op: oldPath === null ? "create" : "update", url: item.url, title: item.title, folderPath: [...newPath, ...item.rel] };
        });
      });
    }

    function onRemoved(id, removeInfo) {
      const node = (removeInfo && removeInfo.node) || {};
      const url = node.url ? canonicalUrl(node.url) : null;
      if (marked(nodeMarks, id) || marked(urlMarks, url)) return;
      enqueueFromEvent(async rootId => {
        const inScope = id === rootId || (await pathOf(removeInfo.parentId, rootId)) !== null;
        if (!inScope) return [];
        if (url) {
          delete ids[id];
          return [{ op: "remove", url }];
        }
        let urls;
        if (Array.isArray(node.children)) {
          urls = collectBookmarks(node, [], []).map(b => b.url);
        } else {
          urls = descendantsFromIds(id)
            .filter(([, entry]) => entry.u)
            .map(([, entry]) => entry.u);
        }
        for (const [childId] of descendantsFromIds(id)) delete ids[childId];
        delete ids[id];
        return [...new Set(urls)].filter(u => !marked(urlMarks, u)).map(u => ({ op: "remove", url: u }));
      });
    }

    // --------------------------------------------------------------- websocket
    let ws = null;
    let pingTimer = null;
    let reconnectTimer = null;
    let reconnectAttempt = 0;
    let wsStopped = false;

    function scheduleReconnect() {
      if (reconnectTimer || wsStopped) return;
      reconnectAttempt += 1;
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** Math.min(reconnectAttempt - 1, 5), RECONNECT_MAX_MS);
      reconnectTimer = setTimer(() => {
        reconnectTimer = null;
        connectWebSocket();
      }, delay + Math.floor(Math.random() * 1000));
    }

    async function connectWebSocket() {
      if (!WebSocketImpl) return;
      if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
      const config = await getConfig();
      const status = await load(KEYS.status, {});
      if (!config || !config.token || status.auth_failed) return;
      wsStopped = false;
      let ticket;
      try {
        ticket = await api(config, "POST", "/v2/ws-ticket");
      } catch {
        scheduleReconnect();
        return;
      }
      const socket = new WebSocketImpl(config.api_url.replace(/^http/, "ws") + ticket.path);
      ws = socket;
      socket.onopen = () => {
        reconnectAttempt = 0;
        if (pingTimer) clearRepeat(pingTimer);
        pingTimer = setRepeat(() => {
          if (socket.readyState === 1) socket.send('{"type":"ping"}');
        }, WS_PING_MS);
      };
      socket.onmessage = event => {
        let data = null;
        try {
          data = JSON.parse(event.data);
        } catch {
          return;
        }
        if (data && data.type === "changed") schedulePull();
      };
      socket.onclose = () => {
        if (ws !== socket) return;
        ws = null;
        if (pingTimer) clearRepeat(pingTimer);
        pingTimer = null;
        scheduleReconnect();
      };
      socket.onerror = () => {};
    }

    function disconnectWebSocket() {
      wsStopped = true;
      if (reconnectTimer) clearTimer(reconnectTimer);
      reconnectTimer = null;
      if (pingTimer) clearRepeat(pingTimer);
      pingTimer = null;
      const socket = ws;
      ws = null;
      if (socket) {
        try {
          socket.close();
        } catch {
          // Already closed.
        }
      }
    }

    // ------------------------------------------------------------------ wiring
    async function handleMessage(msg) {
      switch (msg && msg.type) {
        case "status":
          return statusSummary();
        case "join":
          return join(msg.apiUrl, msg.code);
        case "sync":
          return fullSync();
        case "unpair":
          return unpair();
        case "confirmDeletions":
          return confirmDeletions();
        case "keepBookmarks":
          return keepBookmarks();
        default:
          return { ok: false, error: "unknown_message" };
      }
    }

    async function ensureAlarms() {
      for (const [name, minutes] of Object.values(ALARMS)) {
        const existing = await ext.alarms.get(name);
        if (!existing) ext.alarms.create(name, { periodInMinutes: minutes });
      }
    }

    async function start() {
      await updateBadge();
      const config = await getConfig();
      if (!config || !config.token) return;
      connectWebSocket();
      if (config.cursor) await poll();
      else await fullSync();
    }

    // Listeners are registered synchronously so a restarted service worker
    // receives the event that woke it.
    function install() {
      ext.bookmarks.onCreated.addListener(onCreated);
      ext.bookmarks.onChanged.addListener(onChanged);
      ext.bookmarks.onMoved.addListener(onMoved);
      ext.bookmarks.onRemoved.addListener(onRemoved);
      ext.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        handleMessage(msg).then(sendResponse, err => sendResponse({ ok: false, error: message(err) }));
        return true;
      });
      ext.alarms.onAlarm.addListener(alarm => {
        if (alarm.name === ALARMS.poll[0]) {
          start().catch(err => log.error("[sync] poll failed", err));
        } else if (alarm.name === ALARMS.full[0]) {
          fullSync();
        }
      });
      ext.runtime.onInstalled.addListener(() => {
        // Alarms left by the v1 extension.
        ext.alarms.clear("sync-check");
        ext.alarms.clear("full-sync");
        ensureAlarms();
      });
      ext.runtime.onStartup.addListener(() => start());
      ensureAlarms().catch(err => log.error("[sync] could not create alarms", err));
      start().catch(err => log.error("[sync] start failed", err));
    }

    return {
      install,
      join,
      unpair,
      fullSync,
      poll,
      statusSummary,
      handleMessage,
      confirmDeletions,
      keepBookmarks,
      // exposed for tests
      _events: { onCreated, onChanged, onMoved, onRemoved },
      _idle: () => exclusive(async () => {}),
    };
  }

  root.SyncCore = { createSyncCore, normalizeApiUrl, KEYS, ROOT_TITLE };
})(typeof self !== "undefined" ? self : globalThis);
