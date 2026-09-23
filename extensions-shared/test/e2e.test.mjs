// End-to-end run of the extension engine against a real Worker started by
// scripts/e2e.sh (wrangler dev, local only). Skipped unless SYNC_E2E_URL and
// SYNC_E2E_ADMIN_KEY are set.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import "../canonical.js";
import "../sync-core.js";
import { createFakeBrowser } from "./fakes.mjs";

const API = process.env.SYNC_E2E_URL;
const ADMIN = process.env.SYNC_E2E_ADMIN_KEY;
const { createSyncCore, KEYS } = globalThis.SyncCore;

async function http(method, path, { token, body } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function browser(flavor) {
  const fake = createFakeBrowser(flavor);
  let clock = Date.now();
  const core = createSyncCore({
    ext: fake.ext,
    platform: flavor,
    deviceName: `e2e ${flavor}`,
    now: () => clock,
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    WebSocket: null,
    log: { warn() {}, error() {} },
  });
  core.install();
  return {
    fake,
    core,
    advance: ms => (clock += ms),
    rootId: () => fake.store[KEYS.config]?.root_id,
    settle: async () => {
      await core._idle();
      await core.poll();
    },
  };
}

const only = list => {
  assert.equal(list.length, 1, JSON.stringify(list));
  return list[0];
};

describe("extension engine against a real Worker", { skip: !API || !ADMIN }, () => {
  it("syncs Safari's folders into Chrome and Firefox and keeps Safari in charge", async () => {
    // The Mac: its own access key, then a snapshot of Safari's bookmarks.
    const key = (await http("POST", "/v2/admin/keys", { token: ADMIN, body: { label: "e2e" } })).body.key;
    const mac = await http("POST", "/v2/connect", { body: { platform: "safari", name: "e2e Mac", access_key: key } });
    assert.equal(mac.status, 200, JSON.stringify(mac.body));
    const snapshot = items =>
      http("POST", "/v2/safari/snapshot", { token: mac.body.token, body: { bookmarks: items } });
    await snapshot([
      { url: "https://github.com/", title: "GitHub", folderPath: ["Favorites", "Tech"], index: 0 },
      { url: "https://news.example/", title: "News", folderPath: ["Bookmarks Menu"], index: 0 },
    ]);

    // Chrome already has GitHub in its bookmarks bar and an unrelated bookmark.
    const chrome = browser("chrome");
    const original = chrome.fake.seedBookmark(chrome.fake.ids.bar, "gh", "https://github.com", 1);
    chrome.fake.seedBookmark(chrome.fake.ids.bar, "mine", "https://unrelated.example/");
    const joined = await chrome.core.join(API, mac.body.code);
    assert.equal(joined.ok, true, joined.error);
    chrome.advance(60_000);

    const github = only(chrome.fake.copiesOf("https://github.com/"));
    assert.equal(github[0], "Other bookmarks / Safari Bookmarks / Favorites / Tech");
    assert.equal(github[3], original, "the existing bookmark was moved, not duplicated");
    assert.equal(only(chrome.fake.copiesOf("https://unrelated.example/"))[0], "Bookmarks bar");

    // A bookmark added in Chrome reaches the Mac as a pending import.
    const favorites = chrome.fake.findFolder(chrome.rootId(), "Favorites");
    await chrome.fake.ext.bookmarks.create({ parentId: favorites, title: "Docs", url: "https://docs.example/" });
    await chrome.settle();
    const pending = await http("GET", "/v2/safari/pending", { token: mac.body.token });
    assert.deepEqual(pending.body.pending_imports.map(r => [r.url, r.folderPath]), [["https://docs.example/", ["Favorites"]]]);

    // Moving Safari's bookmark in Chrome is put back.
    await chrome.fake.ext.bookmarks.move(github[3], { parentId: chrome.rootId() });
    await chrome.settle();
    assert.equal(only(chrome.fake.copiesOf("https://github.com/"))[0], "Other bookmarks / Safari Bookmarks / Favorites / Tech");

    // Firefox joins with a new code and gets the same state.
    const code = await http("POST", "/v2/pair-code", { token: mac.body.token });
    const firefox = browser("firefox");
    assert.equal((await firefox.core.join(API, code.body.code)).ok, true);
    firefox.advance(60_000);
    assert.equal(only(firefox.fake.copiesOf("https://github.com/"))[0], "Other Bookmarks / Safari Bookmarks / Favorites / Tech");
    assert.equal(only(firefox.fake.copiesOf("https://docs.example/"))[0], "Other Bookmarks / Safari Bookmarks / Favorites");

    // Safari deletes News: both browsers remove it on their next poll.
    await snapshot([
      { url: "https://github.com/", title: "GitHub", folderPath: ["Favorites", "Tech"], index: 0 },
      { url: "https://docs.example/", title: "Docs", folderPath: ["Favorites"], index: 1 },
    ]);
    await chrome.settle();
    await firefox.settle();
    assert.equal(chrome.fake.copiesOf("https://news.example/").length, 0);
    assert.equal(firefox.fake.copiesOf("https://news.example/").length, 0);

    // The same access key used by Chrome lands in the same group.
    const again = await http("POST", "/v2/connect", { body: { platform: "chrome", access_key: key } });
    assert.equal(again.body.pair_id, mac.body.pair_id);
    assert.equal(again.body.created, false);
  });
});
