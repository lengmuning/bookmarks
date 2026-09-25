// In-memory stand-ins for the browser bookmarks/storage APIs and for the v2
// Worker, used by the sync-core tests. The fake server follows
// docs/SYNC-V2.md for browser ops; the real rules are tested in worker/test.

import "../canonical.js";

const { canonicalUrl } = globalThis.SyncCanonical;

const LAYOUT = {
  chrome: { root: "0", folders: [["1", "Bookmarks bar"], ["2", "Other bookmarks"], ["3", "Mobile bookmarks"]] },
  firefox: {
    root: "root________",
    folders: [["menu________", "Bookmarks Menu"], ["toolbar_____", "Bookmarks Toolbar"], ["unfiled_____", "Other Bookmarks"], ["mobile______", "Mobile Bookmarks"]],
  },
};

export function createFakeBrowser(flavor = "chrome") {
  const layout = LAYOUT[flavor];
  const nodes = new Map();
  const listeners = { onCreated: [], onChanged: [], onMoved: [], onRemoved: [] };
  let nextId = 100;
  let clock = 1_000;
  const store = {};

  const add = (id, parentId, title, url, dateAdded) => {
    nodes.set(id, { id, parentId, title, url, dateAdded: dateAdded ?? clock++, children: url ? undefined : [] });
    if (parentId !== undefined) nodes.get(parentId).children.push(id);
    return id;
  };
  add(layout.root, undefined, "", undefined, 0);
  for (const [id, title] of layout.folders) add(id, layout.root, title, undefined, 0);

  const toNode = (id, deep) => {
    const n = nodes.get(id);
    const out = { id: n.id, title: n.title, dateAdded: n.dateAdded };
    if (n.parentId !== undefined) {
      out.parentId = n.parentId;
      out.index = nodes.get(n.parentId).children.indexOf(id);
    }
    if (n.url) out.url = n.url;
    if (flavor === "firefox") out.type = n.url ? "bookmark" : "folder";
    if (!n.url && deep) out.children = n.children.map(c => toNode(c, true));
    return out;
  };
  const fire = (name, ...args) => listeners[name].forEach(fn => fn(...args));
  const need = id => {
    if (!nodes.has(id)) throw new Error(`Can't find bookmark for id ${id}`);
    return nodes.get(id);
  };
  const detach = id => {
    const n = nodes.get(id);
    const siblings = nodes.get(n.parentId).children;
    const index = siblings.indexOf(id);
    siblings.splice(index, 1);
    return index;
  };
  const dropSubtree = id => {
    for (const child of nodes.get(id).children || []) dropSubtree(child);
    nodes.delete(id);
  };

  const bookmarks = {
    async getTree() {
      return [toNode(layout.root, true)];
    },
    async getSubTree(id) {
      need(id);
      return [toNode(id, true)];
    },
    async get(idOrIds) {
      const list = Array.isArray(idOrIds) ? idOrIds : [idOrIds];
      return list.map(id => toNode(need(id).id, false));
    },
    async create({ parentId, title = "", url }) {
      const parent = need(parentId);
      if (parent.url) throw new Error("Parent is not a folder");
      const id = String(nextId++);
      add(id, parentId, title, url);
      fire("onCreated", id, toNode(id, false));
      return toNode(id, false);
    },
    async move(id, { parentId }) {
      const node = need(id);
      need(parentId);
      const oldParentId = node.parentId;
      const oldIndex = detach(id);
      node.parentId = parentId;
      nodes.get(parentId).children.push(id);
      fire("onMoved", id, { parentId, index: nodes.get(parentId).children.length - 1, oldParentId, oldIndex });
      return toNode(id, false);
    },
    async update(id, changes) {
      const node = need(id);
      if (changes.title !== undefined) node.title = changes.title;
      if (changes.url !== undefined) node.url = changes.url;
      fire("onChanged", id, node.url ? { title: node.title, url: node.url } : { title: node.title });
      return toNode(id, false);
    },
    async remove(id) {
      const node = need(id);
      if (!node.url && node.children.length) throw new Error("Can't remove non-empty folder");
      return bookmarks.removeTree(id);
    },
    async removeTree(id) {
      const node = need(id);
      // Chrome reports the removed subtree, Firefox only the node itself.
      const reported = flavor === "chrome" ? toNode(id, true) : toNode(id, false);
      const parentId = node.parentId;
      const index = detach(id);
      dropSubtree(id);
      fire("onRemoved", id, { parentId, index, node: reported });
    },
  };
  for (const name of Object.keys(listeners)) bookmarks[name] = { addListener: fn => listeners[name].push(fn) };

  const badge = { text: "" };
  const ext = {
    bookmarks,
    action: {
      async setBadgeText({ text }) {
        badge.text = text;
      },
      async setBadgeBackgroundColor() {},
    },
    storage: {
      local: {
        async get(keys) {
          const list = keys === undefined ? Object.keys(store) : Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const key of list) if (key in store) out[key] = structuredClone(store[key]);
          return out;
        },
        async set(values) {
          for (const [key, value] of Object.entries(values)) store[key] = structuredClone(value);
        },
        async remove(keys) {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
        },
      },
    },
    alarms: { get: async () => null, create() {}, clear() {}, onAlarm: { addListener() {} } },
    runtime: { onMessage: { addListener() {} }, onInstalled: { addListener() {} }, onStartup: { addListener() {} } },
  };

  const other = layout.folders.find(([id]) => id === "2" || id === "unfiled_____")[0];
  const bar = layout.folders.find(([id]) => id === "1" || id === "toolbar_____")[0];

  return {
    ext,
    store,
    badge,
    ids: { root: layout.root, other, bar },
    // Setup helpers that do not fire events.
    seedFolder: (parentId, title, dateAdded = 0) => add(String(nextId++), parentId, title, undefined, dateAdded),
    seedBookmark: (parentId, title, url, dateAdded) => add(String(nextId++), parentId, title, url, dateAdded),
    node: id => (nodes.has(id) ? toNode(id, false) : null),
    findFolder(parentId, title) {
      const id = (nodes.get(parentId)?.children || []).find(c => !nodes.get(c).url && nodes.get(c).title === title);
      return id ?? null;
    },
    // [path of titles, title, url] for every bookmark, for assertions.
    listing() {
      const out = [];
      const walk = (id, path) => {
        for (const child of nodes.get(id).children) {
          const n = nodes.get(child);
          if (n.url) out.push([path.join(" / "), n.title, n.url, n.id]);
          else walk(child, [...path, n.title]);
        }
      };
      walk(layout.root, []);
      return out;
    },
    copiesOf(url) {
      return this.listing().filter(([, , u]) => canonicalUrl(u) === canonicalUrl(url));
    },
  };
}

export function createFakeServer() {
  const rows = new Map();
  let seq = 0;
  let horizon = 0;
  let disabled = false;
  const requests = [];
  const nextSeq = () => ++seq;
  const title = t => (typeof t === "string" && t !== "" ? t : null);
  const path = p => (Array.isArray(p) ? p.map(s => String(s).trim()).filter(Boolean) : []);
  const pub = r => ({ url: r.url, title: r.title, folderPath: r.folderPath, index: null, owner: r.owner, removed: r.removed, seq: r.seq });
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

  // Same rules as the Worker, with the mass-delete guard per request only.
  function applyOps(baseCursor, ops, confirm) {
    const safariRows = [...rows.values()].filter(r => !r.removed && r.owner === "safari");
    const targets = new Set(
      ops.filter(op => op.op === "remove").map(op => canonicalUrl(op.url)).filter(url => rows.get(url)?.owner === "safari" && !rows.get(url).removed),
    );
    const held = !confirm && targets.size > 20 && targets.size > 0.1 * safariRows.length;
    const results = ops.map(op => {
      const url = canonicalUrl(op.url);
      if (!url) return { url: null, status: "invalid" };
      const row = rows.get(url);
      if (op.op === "remove") {
        if (!row || row.removed) return { url, status: "noop" };
        if (row.owner === "safari" && held) return { url, status: "rejected", reason: "mass_delete", state: pub(row) };
        Object.assign(row, { removed: true, safariDelete: row.owner === "safari", seq: nextSeq() });
        return { url, status: "applied" };
      }
      const t = title(op.title);
      const p = path(op.folderPath);
      if (!row || (row.removed && row.seq <= baseCursor)) {
        rows.set(url, { url, title: t, folderPath: p, owner: "browser", removed: false, seq: nextSeq() });
        return { url, status: "applied" };
      }
      if (row.removed) return { url, status: "rejected", reason: "deleted", state: pub(row) };
      if (row.owner === "safari") {
        return row.title === t && same(row.folderPath, p)
          ? { url, status: "noop" }
          : { url, status: "rejected", reason: "safari_authority", state: pub(row) };
      }
      if (row.title === t && same(row.folderPath, p)) return { url, status: "noop" };
      Object.assign(row, { title: t, folderPath: p, seq: nextSeq() });
      return { url, status: "applied" };
    });
    return { results, needs_confirmation: held ? { count: targets.size, sample: [...targets].slice(0, 10) } : null };
  }

  function handle(method, url, body) {
    if (disabled && url.pathname !== "/v2/join") return [403, { error: "group_disabled" }];
    if (method === "POST" && url.pathname === "/v2/join") {
      if (body.code !== "GOOD-CODE") return [404, { error: "invalid_or_expired_code" }];
      return [200, { pair_id: "p1", device_id: "d1", token: "tok", cursor: seq }];
    }
    if (method === "GET" && url.pathname === "/v2/snapshot") {
      const bookmarks = [...rows.values()].filter(r => !r.removed).map(pub);
      return [200, { cursor: seq, count: bookmarks.length, bookmarks }];
    }
    if (method === "GET" && url.pathname === "/v2/changes") {
      const since = Number(url.searchParams.get("since"));
      const limit = Number(url.searchParams.get("limit"));
      if (since > 0 && since < horizon) return [409, { error: "cursor_expired" }];
      const all = [...rows.values()].filter(r => r.seq > since).sort((a, b) => a.seq - b.seq);
      const page = all.slice(0, limit);
      const hasMore = all.length > limit;
      return [200, { cursor: hasMore ? page[page.length - 1].seq : Math.max(since, seq), has_more: hasMore, changes: page.map(pub) }];
    }
    if (method === "POST" && url.pathname === "/v2/changes") {
      if (body.base_cursor > 0 && body.base_cursor < horizon) return [409, { error: "cursor_expired" }];
      return [200, { cursor: seq, ...applyOps(body.base_cursor, body.ops, body.confirm_deletions === true) }];
    }
    if (method === "DELETE" && url.pathname === "/v2/devices/self") return [200, { revoked: "d1" }];
    return [404, { error: "not_found" }];
  }

  return {
    requests,
    rows,
    get seq() {
      return seq;
    },
    // Drops every tombstone, as the Worker does after the retention period.
    purgeTombstones() {
      for (const [url, row] of rows) {
        if (!row.removed) continue;
        horizon = Math.max(horizon, row.seq);
        rows.delete(url);
      }
    },
    disable() {
      disabled = true;
    },
    // Simulates the macOS app uploading Safari's bookmarks (no guard, no imports).
    safariSnapshot(items) {
      const seen = new Set();
      for (const item of items) {
        const url = canonicalUrl(item.url);
        seen.add(url);
        const row = rows.get(url);
        const next = { title: title(item.title), folderPath: path(item.folderPath) };
        if (!row || row.removed || row.owner !== "safari" || row.title !== next.title || !same(row.folderPath, next.folderPath)) {
          rows.set(url, { url, ...next, owner: "safari", removed: false, seq: nextSeq() });
        }
      }
      for (const row of rows.values()) {
        if (row.owner === "safari" && !row.removed && !seen.has(row.url)) Object.assign(row, { removed: true, seq: nextSeq() });
      }
    },
    fetch: async (input, init = {}) => {
      const url = new URL(input);
      const body = init.body ? JSON.parse(init.body) : undefined;
      requests.push({ method: init.method || "GET", path: url.pathname + url.search, body });
      const [status, json] = handle(init.method || "GET", url, body);
      return { ok: status < 400, status, json: async () => structuredClone(json) };
    },
  };
}
