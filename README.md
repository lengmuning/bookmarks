# Safari Bookmarks Sync / Safari 书签同步

实时将 Safari 书签同步到 Chrome 和 Firefox，后端运行在 Cloudflare Worker 上。

Real-time Safari bookmark sync to Chrome and Firefox, powered by Cloudflare Worker.

## 架构 / Architecture

```
Safari Extension ──(HTTP POST)──▶ Cloudflare Worker ◀──(WebSocket)── Chrome Extension
                                  │    ▲
                                  │    └──(WebSocket)── Firefox Extension
                                  │
                              D1 Database (bookmarks)
                              KV (pairing codes)
                              Durable Object (WebSocket hub)
```

## 功能 / Features

- Safari 作为源端，监听书签新增、修改、删除并推送到 Worker。
- Chrome 和 Firefox 通过 WebSocket 近实时接收变更，并用轮询作为断线兜底。
- 首次使用通过 6 位配对码连接设备。
- 设备请求使用 `pair_id + device_id + device_token` 校验。

- Safari acts as the source browser and pushes bookmark changes to the Worker.
- Chrome and Firefox receive near real-time updates over WebSocket, with polling as a fallback.
- Devices are paired with a 6-digit pairing code.
- Device requests are authenticated with `pair_id + device_id + device_token`.

## 部署 Cloudflare Worker / Deploy Cloudflare Worker

这个 Worker **不需要**在 Cloudflare Dashboard 的“变量和机密”里手动创建运行时变量。

This Worker does **not** require runtime Variables or Secrets in the Cloudflare Dashboard.

必须配置的是 Cloudflare 资源绑定，名称必须和 `worker/wrangler.toml` 完全一致。

The required items are Cloudflare resource bindings, and their names must match `worker/wrangler.toml` exactly.

| 项目 / Item | 需要填写或选择的名称 / Name to enter or select | 配置位置 / Config field |
|------------|-----------------------------------------------|--------------------------|
| Worker 服务名 / Worker service name | `bookmarks` | `name` |
| Durable Object 绑定 / Durable Object binding | `SYNC_CHANNEL` | `[[durable_objects.bindings]].name` |
| Durable Object 类 / Durable Object class | `SyncChannel` | `[[durable_objects.bindings]].class_name` |
| D1 绑定变量 / D1 binding variable | `DB` | `[[d1_databases]].binding` |
| D1 数据库名 / D1 database name | `bookmarks-db` | `[[d1_databases]].database_name` |
| D1 数据库 ID / D1 database ID | 复制 Cloudflare 生成的 `database_id` / Copy the generated `database_id` | `[[d1_databases]].database_id` |
| KV 绑定变量 / KV binding variable | `BOOKMARKS_KV` | `[[kv_namespaces]].binding` |
| KV 命名空间名 / KV namespace name | `BOOKMARKS_KV` | Cloudflare KV namespace |
| KV 命名空间 ID / KV namespace ID | 复制 Cloudflare 生成的 `id` / Copy the generated `id` | `[[kv_namespaces]].id` |

不要把 `DB`、`BOOKMARKS_KV`、`SYNC_CHANNEL` 创建成普通变量或机密；它们是绑定。

Do not create `DB`, `BOOKMARKS_KV`, or `SYNC_CHANNEL` as plain variables or secrets; they are bindings.

### 命令行部署 / CLI deployment

```bash
cd worker
npm install

# Create D1 database / 创建 D1 数据库
npx wrangler d1 create bookmarks-db
# Copy the generated database_id into worker/wrangler.toml
# 将输出里的 database_id 填入 worker/wrangler.toml

# Create KV namespace / 创建 KV 命名空间
npx wrangler kv:namespace create BOOKMARKS_KV
# Copy the generated id into worker/wrangler.toml
# 将输出里的 id 填入 worker/wrangler.toml

# Run schema migration / 初始化数据库表
npx wrangler d1 execute bookmarks-db --file=migrations/001_schema.sql

# Only for old deployments created before device_token support
# 仅旧版本已部署过、缺少 device_token 字段时需要执行
npx wrangler d1 execute bookmarks-db --file=migrations/002_device_tokens.sql

# Deploy / 部署
npx wrangler deploy
```

部署完成后，记录 Worker URL，例如 `https://bookmarks.yourname.workers.dev`。

After deployment, note the Worker URL, for example `https://bookmarks.yourname.workers.dev`.

部署成功后访问 Worker 根路径应返回 JSON 状态，不应该是 `Hello World`。例如：

After a successful deployment, opening the Worker root URL should return a JSON status response, not `Hello World`. For example:

```json
{
  "name": "Safari Bookmarks Sync",
  "status": "ok"
}
```

### GitHub 自动部署 / GitHub automatic deployment

如果使用 Cloudflare Workers & Pages 连接 GitHub 仓库，推荐设置：

If using Cloudflare Workers & Pages with a connected GitHub repository, use:

| 设置 / Setting | 值 / Value |
|---------------|------------|
| Root directory / 根目录 | `/worker` |
| Build command / 构建命令 | 留空 / empty |
| Deploy command / 部署命令 | `npx wrangler deploy` |
| Version command / 版本命令 | `npx wrangler versions upload` 或留空 / or empty |

GitHub 自动部署同样会读取 `worker/wrangler.toml`，所以 D1/KV 的真实 ID 必须已经填好。

GitHub deployment also reads `worker/wrangler.toml`, so the real D1/KV IDs must be filled in first.

## 安装扩展 / Install Extensions

### Safari

**方式 A：使用 Xcode 构建 / Option A: Build with Xcode**

1. 打开 Xcode，选择 File -> New -> Project -> Safari Extension App。
2. 选择 SwiftUI。
3. 项目命名为 `Bookmarks Sync`。
4. 删除自动生成的 extension target `Resources/` 文件夹。
5. 将 `safari-extension/Shared/Extension/` 内的文件复制到 extension target。
6. 勾选 “Copy items if needed”。
7. Build and Run。
8. 在 Safari -> Settings/Preferences -> Extensions 启用扩展。

**方式 B：命令行转换 / Option B: Convert from command line**

```bash
xcrun safari-web-extension-converter safari-extension/Shared/Extension/
open safari-extension/Shared/Extension.xcodeproj
```

Then build and run the generated Xcode project.

### Chrome

1. 打开 `chrome://extensions`。
2. 开启 Developer mode。
3. 点击 Load unpacked。
4. 选择 `chrome-extension/` 文件夹。

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select the `chrome-extension/` folder.

### Firefox

1. 打开 `about:debugging` -> This Firefox。
2. 点击 Load Temporary Add-on。
3. 选择 `firefox-extension/manifest.json`。

1. Open `about:debugging` -> This Firefox.
2. Click Load Temporary Add-on.
3. Select `firefox-extension/manifest.json`.

## 使用 / Usage

### 首次配对 / First-time pairing

1. 在 Safari 扩展里输入 Worker URL，点击 Generate Pairing Code。
2. 复制 6 位配对码。
3. 在 Chrome 或 Firefox 扩展里输入同一个 Worker URL 和配对码，点击 Connect。
4. 配对完成后，Safari 书签会同步到 Chrome/Firefox。

1. In the Safari extension, enter the Worker URL and click Generate Pairing Code.
2. Copy the 6-digit pairing code.
3. In Chrome or Firefox, enter the same Worker URL and pairing code, then click Connect.
4. Safari bookmarks will sync to Chrome/Firefox after pairing.

### 日常使用 / Daily use

- 自动同步：Safari 书签变化会通过 WebSocket 推送到 Chrome/Firefox。
- 手动同步：在 Chrome/Firefox 扩展里点击 Sync Now 拉取完整状态。
- 断线恢复：WebSocket 断开时，Chrome/Firefox 会定时轮询增量变更。

- Automatic sync: Safari bookmark changes are pushed to Chrome/Firefox over WebSocket.
- Manual sync: Click Sync Now in Chrome/Firefox to fetch the full bookmark state.
- Recovery: Chrome/Firefox periodically poll incremental changes when WebSocket is unavailable.

## API 接口 / API Endpoints

| Method | Path | 说明 / Description |
|--------|------|--------------------|
| POST | `/api/pair/generate` | 生成 6 位配对码 / Generate a 6-digit pairing code |
| POST | `/api/pair/join` | 使用配对码加入同步组 / Join a pair group with a code |
| GET | `/api/pair/info?pair_id=X` | 查看同步组设备 / Get devices in a pair group |
| POST | `/api/sync` | 推送书签变更 / Push a bookmark change |
| GET | `/api/bookmarks?pair_id=X&device_id=X&device_token=X` | 获取完整书签状态 / Get full bookmark state |
| GET | `/api/bookmarks/since?pair_id=X&device_id=X&device_token=X&since=TS` | 获取指定时间后的变更 / Get changes since a timestamp |
| GET | `/ws?pair_id=X&device_id=X&device_token=X&browser=X` | WebSocket 连接 / WebSocket connection |

## 项目结构 / Project Structure

```
├── worker/              Cloudflare Worker (TypeScript)
│   ├── src/
│   │   ├── index.ts           Entry point + routing
│   │   ├── api/pair.ts        Pairing endpoints
│   │   ├── api/sync.ts        Bookmark sync endpoint
│   │   ├── api/bookmarks.ts   Bookmark retrieval endpoints
│   │   ├── durable/SyncChannel.ts  Durable Object WebSocket hub
│   │   ├── db/schema.sql      D1 schema
│   │   └── utils/crypto.ts    Pairing code and token helpers
│   └── wrangler.toml
├── safari-extension/    Safari Web Extension
├── chrome-extension/    Chrome Extension (MV3)
├── firefox-extension/   Firefox Extension
└── README.md
```

## 要求 / Requirements

- macOS，用于构建 Safari 扩展 / macOS for building the Safari extension
- Xcode 15+，用于 Safari 扩展 / Xcode 15+ for Safari extension builds
- Cloudflare account，免费额度可用 / Cloudflare account, free tier is enough for personal use
- Node.js 18+，用于 Wrangler CLI / Node.js 18+ for Wrangler CLI
- Chrome 109+ / Firefox 115+

## 注意事项 / Notes

- 当前实现以 Safari 为源端，Chrome/Firefox 主要作为接收端。
- Chrome/Firefox 接收书签时会放入各自的默认“其他书签”目录，避免跨浏览器父目录 ID 不兼容。
- 如果要支持 Chrome/Firefox 新增书签反向同步到 Safari，需要新增跨浏览器目录映射和同步回环抑制。

- The current implementation uses Safari as the source browser, with Chrome/Firefox mainly acting as receivers.
- Chrome/Firefox place received bookmarks into their default "Other Bookmarks" location to avoid incompatible cross-browser parent IDs.
- To support reverse sync from Chrome/Firefox back to Safari, the project needs cross-browser folder mapping and loop prevention.
