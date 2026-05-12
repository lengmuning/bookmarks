# Safari Bookmarks Sync

Real-time sync Safari bookmarks to Chrome and Firefox via Cloudflare Worker.

## Architecture

```
Safari Extension ──(HTTP POST)──▶ Cloudflare Worker ◀──(WebSocket)── Chrome Extension
                                  │    ▲
                                  │    └──(WebSocket)── Firefox Extension
                                  │
                              D1 Database (bookmarks)
                              KV (pairing codes)
                              Durable Object (WebSocket hub)
```

## Setup

### 1. Deploy Cloudflare Worker

```bash
cd worker
npm install

# Create D1 database
npx wrangler d1 create bookmarks-db
# Copy the database_id output into wrangler.toml under [[d1_databases]].database_id

# Create KV namespace
npx wrangler kv:namespace create BOOKMARKS_KV
# Copy the id output into wrangler.toml under [[kv_namespaces]].id

# Run migration
npx wrangler d1 execute bookmarks-db --file=migrations/001_schema.sql

# Existing deployments created before device tokens need this once
npx wrangler d1 execute bookmarks-db --file=migrations/002_device_tokens.sql

# Deploy
npx wrangler deploy
```

Note the deployed Worker URL (e.g., `https://safari-bookmarks-sync.yourname.workers.dev`).

### 2. Install Safari Extension

**Option A: Build with Xcode (recommended)**

1. Open Xcode → File → New → Project → Safari Extension App (macOS)
2. Choose SwiftUI for the app
3. Name it "Bookmarks Sync"
4. Delete the generated `Resources/` folder in the extension target
5. Copy all files from `safari-extension/Shared/Extension/` into the extension target folder
6. In Xcode, check "Copy items if needed"
7. Build and run (Cmd+R)
8. Enable the extension in Safari → Preferences → Extensions

**Option B: Use command-line converter**

```bash
xcrun safari-web-extension-converter safari-extension/Shared/Extension/
open safari-extension/Shared/Extension.xcodeproj
# Build and run the project in Xcode
```

### 3. Install Chrome Extension

1. Open Chrome → `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select `chrome-extension/` folder

### 4. Install Firefox Extension

1. Open Firefox → `about:debugging` → This Firefox
2. Click "Load Temporary Add-on"
3. Select `firefox-extension/manifest.json`

For permanent install, use `about:addons` → gear icon → "Install Add-on From File".

## Usage

### Pairing (first-time setup)

1. In Safari, click the extension icon → enter Worker URL → click "Generate Pairing Code"
2. Copy the 6-digit code
3. In Chrome and/or Firefox, click the extension icon → enter the same Worker URL → enter the pairing code → click "Connect"
4. Done! Safari bookmarks will now sync to Chrome and Firefox.

### Daily Use

- **Automatic**: Safari bookmark changes are pushed to Chrome/Firefox in near real-time via WebSocket
- **Manual**: Click "Sync Now" in the Chrome/Firefox extension to force a full sync
- **Recovery**: If anything goes wrong, just click "Sync Now" - it pulls the full bookmark state

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/pair/generate` | Generate a 6-digit pairing code |
| POST | `/api/pair/join` | Join an existing pair with a code |
| GET | `/api/pair/info?pair_id=X` | Get devices in a pair group |
| POST | `/api/sync` | Push a bookmark change |
| GET | `/api/bookmarks?pair_id=X&device_id=X&device_token=X` | Get full bookmark state |
| GET | `/api/bookmarks/since?pair_id=X&device_id=X&device_token=X&since=TS` | Get changes since timestamp |
| GET | `/ws?pair_id=X&device_id=X&device_token=X&browser=X` | WebSocket connection |

## Project Structure

```
├── worker/              Cloudflare Worker (TypeScript)
│   ├── src/
│   │   ├── index.ts           Entry point + routing
│   │   ├── api/pair.ts        Pairing endpoints
│   │   ├── api/sync.ts        Bookmark sync endpoint
│   │   ├── api/bookmarks.ts   Bookmark retrieval endpoints
│   │   ├── durable/SyncChannel.ts  Durable Object (WebSocket hub)
│   │   ├── db/schema.sql      D1 schema
│   │   └── utils/crypto.ts    Pairing code generation
│   └── wrangler.toml
├── safari-extension/    Safari Web Extension
├── chrome-extension/    Chrome Extension (MV3)
├── firefox-extension/   Firefox Extension (MV3)
└── README.md
```

## Requirements

- macOS (for Safari extension)
- Xcode 15+ (to build Safari extension)
- Cloudflare account (free tier)
- Node.js 18+ (for wrangler CLI)
- Chrome 109+ / Firefox 115+
