# Sync protocol v2

This document is the contract shared by the Worker (`worker/src/v2`), the
Chrome/Firefox extensions (`extensions-shared/`) and the macOS app
(`macos-app`). Change it first, then the three implementations.

## Roles

- **Safari** (the macOS app) is the authority. A sync group has at most one
  active Safari device.
- **Browsers** (Chrome, Firefox) are replicas. They can add bookmarks, but they
  cannot move, rename or delete a bookmark that Safari owns: such changes are
  rejected and the browser puts the bookmark back.

## Identity

A bookmark is identified inside a group by its canonical URL
(`worker/src/utils/url.ts`, mirrored by `extensions-shared/canonical.js`):
WHATWG URL parsing, http/https only, credentials removed. The macOS app does
not canonicalize; it sends raw URLs and uses the `canonical_map` the server
returns.

Different groups are fully isolated: every group lives in its own Durable
Object with its own SQLite database.

## Rows

| field | meaning |
|---|---|
| `url` | canonical URL, primary key |
| `title`, `folder_path`, `idx` | placement; `folder_path` is relative to the Safari root, e.g. `["Favorites","Tech"]` |
| `owner` | `safari` or `browser` |
| `removed` | tombstone flag |
| `in_safari` | present in the last Safari snapshot (internal) |
| `seq` | group-wide monotonic change number |

Every visible change (insert, title/folder change, owner change, delete,
restore) takes the next `seq`. Index-only changes do not. Clients read changes
with `seq > cursor`; the cursor is never a timestamp.

A URL has one row per group for its whole life: moving, renaming or
re-classifying it updates that row. Tombstones are kept for 90 days and then
purged by a daily Durable Object alarm; the highest purged `seq` becomes the
group's horizon. A request whose `since` or `base_cursor` is above 0 but below
the horizon gets `409 cursor_expired`, and the browser starts over with a
cursor of 0 (snapshot, then pushes judged against a cursor of 0).

## Browser changes (`POST /v2/changes`)

The request carries `base_cursor`, the last cursor the browser had fully
applied. Each op is answered in order with `applied`, `noop`, `rejected` or
`invalid`; `rejected` carries the authoritative `state` for the browser to
apply.

| op | existing row | result |
|---|---|---|
| create / update | none | insert, owner `browser` |
| create / update | tombstone with `seq <= base_cursor` | restore, owner `browser` (the user re-added it after seeing the delete) |
| create / update | tombstone with `seq > base_cursor` | `rejected`, state = tombstone (browser removes its copy) |
| create / update | owner `safari`, same title and folder | `noop` |
| create / update | owner `safari`, different title or folder | `rejected`, state = Safari's placement |
| create / update | owner `browser` | update (last writer wins) |
| remove | none or tombstone | `noop` |
| remove | owner `safari` | `rejected`, state = row (browser restores it) |
| remove | owner `browser` | tombstone |

## Safari snapshot (`POST /v2/safari/snapshot`)

The app sends every bookmark in `Bookmarks.plist` plus `unconfirmed_imports`
(URLs it wrote into the plist that Safari has not yet been seen keeping).

- URL in the snapshot, not unconfirmed: owner becomes `safari`; title and
  folder are taken from Safari; a tombstone is restored.
- URL in `unconfirmed_imports`: left untouched (still owner `browser`).
- Safari-owned row missing from the snapshot: deleted in Safari, tombstoned.
- **Mass-delete guard**: if the snapshot is empty while Safari owns rows, or
  it would delete more than 20 rows and more than 10% of Safari's rows, nothing
  is deleted and `needs_confirmation` is returned. The app asks the user and
  resends with `confirm_deletions: true`.
- Response `pending_imports`: active browser-owned rows not present in Safari.

## Browser placement (applying server state locally)

Scope root: `Other Bookmarks / Safari Bookmarks /` (Firefox: `Other
Bookmarks`, id `unfiled_____`). Target folder = root + `folder_path`.

For an active row:

1. Collect every modifiable bookmark in the **whole** browser tree whose
   canonical URL matches.
2. None: create it in the target folder.
3. Otherwise keep one copy (the one already in the target folder, else the
   oldest by `dateAdded`), move it into the target folder and set the title.
4. Remove every other copy, inside or outside the root. A URL that exists in
   Safari ends up exactly once in the browser, in Safari's folder.

For a tombstone: remove copies inside the root only. Bookmarks whose URL is not
in the group are never touched.

When joining, the extension first stores a full backup of the bookmark tree
(downloadable from the popup), then renames an existing root to `Safari
Bookmarks (before sync v2)` and starts from an empty one. Bookmarks Safari has
are moved out of the old folder by the rules above; what remains is left for
the user to review and is not uploaded, so bookmarks deleted in Safari long
ago (the v1 extension never synced deletes) do not come back. The old folder
is removed if nothing is left in it. Moving a bookmark into the new root
uploads it as usual.

## Safari import (browser-owned rows into the plist)

- Only while Safari is not running; otherwise the app waits for Safari to quit.
- Folder mapping: `Favorites` -> `BookmarksBar`, `Bookmarks Menu` ->
  `BookmarksMenu`, `Reading List` -> `com.apple.ReadingList`. Any other first
  segment is placed under `Bookmarks Menu`.
- A backup of the plist is written to the app container first; the original
  plist format (binary/XML) is kept.
- Imported URLs stay in `unconfirmed_imports` until a later snapshot, taken
  after Safari itself rewrote the plist, still contains them. If such a
  snapshot no longer contains them (for example iCloud replaced the file), the
  app parks them instead of treating that as a delete, and shows them in the
  menu.

## Access control

An access key identifies a user: **one access key, one sync group, one
`pair_id`**. All of that user's devices share the `pair_id`; each device has its
own token so it can be removed on its own.

- `ACCESS_KEY` (Worker secret, at least 16 characters): the owner's key.
- `ADMIN_KEY` (Worker secret, at least 16 characters): enables `/v2/admin`,
  which issues keys for other users (`sbk_` + 48 hex characters), optionally
  with a lower bookmark limit. Revoking a key disables its group: every call
  from its devices gets `403 group_disabled` and its pairing codes stop working.
- With neither secret set, no group can be created (`403
  access_key_not_configured`).

`POST /v2/connect` `{access_key, platform, name, replace_safari?}`:

- The key has no group yet: the group is created with this device, and a
  pairing code is returned (`created: true`).
- The key already has a group: this device joins it (`created: false`). A group
  has one Safari device; if another one is active the answer is `409
  safari_device_exists` with its name, and the app asks before retrying with
  `replace_safari: true`, which revokes the old one (new or reinstalled Mac).

Browsers normally join with a pairing code (`POST /v2/join`), so the access key
only has to be typed on the Mac. v1 `POST /api/pair/generate` accepts only the
master `ACCESS_KEY`, in `X-Access-Key`.

Groups are never merged across users: two users with the same URL each have
their own row in their own Durable Object.

## Pairing and tokens

- `POST /v2/pair-code` issues a code for the caller's group (the previous code
  stops working). `POST /v2/join` redeems a code once and adds the device to
  that group.
- Codes: 8 characters from `23456789ABCDEFGHJKMNPQRSTUVWXYZ`, shown as
  `XXXX-XXXX`, valid 30 minutes, single use (enforced by the Registry Durable
  Object, strongly consistent). Failed joins are limited per IP and globally.
- Device token: `v2.<pair_id>.<device_id>.<secret>`, sent as
  `Authorization: Bearer`. Only the SHA-256 of the secret is stored. Devices
  can be listed and revoked.
- WebSocket: `POST /v2/ws-ticket` returns a single-use ticket valid 60 s; the
  socket connects with `/v2/ws?pair=<pair_id>&ticket=<ticket>`, so the device
  token never appears in a URL. The server sends `{"type":"changed","cursor":n}`;
  clients then call `GET /v2/changes`. `{"type":"ping"}` is answered with
  `{"type":"pong"}` without waking the object.

## Endpoints

| method | path | auth |
|---|---|---|
| GET | `/v2/health` | none |
| POST | `/v2/connect` | access key (rate limited) |
| POST | `/v2/join` | none (rate limited) |
| POST | `/v2/pair-code` | token |
| GET | `/v2/devices` | token |
| DELETE | `/v2/devices/{id or "self"}` | token |
| GET | `/v2/snapshot` | token |
| GET | `/v2/changes?since=&limit=` | token |
| POST | `/v2/changes` | token (browser) |
| POST | `/v2/safari/snapshot` | token (Safari) |
| GET | `/v2/safari/pending` | token (Safari) |
| POST | `/v2/ws-ticket` | token |
| GET | `/v2/ws?pair=&ticket=` | ticket |
| POST | `/v2/admin/keys` | admin (`{label, max_bookmarks}`) |
| GET | `/v2/admin/keys` | admin |
| DELETE | `/v2/admin/keys/{id}` | admin (revokes the key, disables its group) |
| GET | `/v2/admin/groups/{pair_id}` | admin (usage) |
| POST | `/v2/admin/groups/{pair_id}/disable` | admin |
| DELETE | `/v2/admin/groups/{pair_id}` | admin (deletes all its data) |

Admin calls use `Authorization: Bearer <ADMIN_KEY>` and return 404 when
`ADMIN_KEY` is not set.

## Limits

URL 4096 chars, title 1024 chars (longer titles are truncated), folder depth
32, folder name 255 chars, 500 ops per request, 50 000 active bookmarks per
group (lower if the access key says so), 16 MB request body, 10 `/v2/connect` calls
per IP per hour.

## Not covered

- Order inside a folder is stored but browsers append instead of reordering.
- Writing the plist does not make Safari upload to iCloud; iCloud may replace
  the imported bookmarks, which is why imports are confirmed before Safari
  takes ownership of them.
