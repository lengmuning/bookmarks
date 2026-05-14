# Safari Bookmarks Sync

把 Safari 书签同步到 Firefox / Chrome，并保留 Safari 里的分类文件夹和文件夹名称。后端运行在 Cloudflare Worker，数据存储使用 Cloudflare D1，配对码使用 KV，实时推送使用 Durable Object WebSocket。

> 当前项目仍处于测试阶段，适合研究和小范围自测。写入浏览器书签前建议先备份 Safari 书签。

## 当前能力

- 支持测试版双向同步：Safari 可以同步到 Firefox / Chrome，Firefox / Chrome 在 `Safari Bookmarks` 目录内的新增或修改也可以回传到 Safari。
- Safari macOS App 读取 `/Users/<name>/Library/Safari/Bookmarks.plist`，上传到 Worker。
- Firefox / Chrome 在"其他书签"下创建 `Safari Bookmarks` 根目录，并按 Safari 的 `Favorites/分类文件夹/子文件夹` 结构创建书签。
- Firefox / Chrome 在 `Safari Bookmarks` 根目录内新增、修改、移动、删除书签时，会把变更上传到 Worker。
- Safari macOS App 支持 `Check Now`、`Auto Check` 和 `Pull Remote Changes`。
- `Auto Check` 每 5 分钟检查远端是否有 Safari 缺失的书签，但不会自动写入 Safari。
- `Pull Remote Changes` 手动把远端新增书签合并回 Safari（写入前会检测 Safari 是否运行）。

## 1.1 版本架构升级

> 如果你在 1.0.x 版本部署过，请按"迁移"章节先升级数据模型。

- **URL 作为主键**：服务端按 `(pair_id, canonical_url)` 唯一识别一条书签，不再依赖各浏览器的本地 ID。一份书签在 D1 里只占一行，无论哪台设备来更新它。
- **写入幂等**：sync 走 `INSERT ... ON CONFLICT DO UPDATE`，重复事件不会撑大数据库。
- **多租户隔离**：不同 `pair_id` 完全独立，同一个 URL 在 A、B 两个同步组里是两条完全独立的记录。
- **配对码一次性**：成功 `join` 后立即作废，并附带 IP 失败计数 + 限流。
- **Bearer 鉴权**：所有 HTTP 请求改用 `Authorization: Bearer <device_token>`（WebSocket 仍走 query 字符串）。
- **CORS 收紧**：默认只接受 `chrome-extension://*`、`moz-extension://*`、`safari-web-extension://*` 来源。
- **服务端时间戳**：客户端不再自己取 `Date.now()` 写入 `last_sync`，使用响应里的 `server_now`，避免设备时钟漂移导致漏事件。
- **同名文件夹定位**：客户端用 `getChildren(parentId)` 找子文件夹，不再用全局 `search({title})`，避免把书签放进错误的同名目录。
- **跨目录误删修复**：本地 `Safari Bookmarks` 子树外的同 URL 书签不再受同步影响。
- **URL 改动检测**：浏览器内改 URL 会发"remove(old) + create(new)"两条事件，远端不会留下孤儿。
- **Safari 写入安全**：`Pull Remote Changes` 写入 `Bookmarks.plist` 前检测 Safari 是否运行，未关闭时拒绝写入；使用 `NSFileCoordinator` 协调写入并保留备份。

## 架构

```text
Safari macOS App
  ├─ 读取/写入 Bookmarks.plist
  ├─ 上传 Safari 书签（canonical URL）
  └─ 手动拉取远端新增
        │
        ▼
Cloudflare Worker
  ├─ D1: pairs / devices / bookmark_state
  ├─ KV: 6 位配对码 + 限流计数
  └─ Durable Object: WebSocket 广播（每条带 server_now）
        ▲
        │
Chrome Extension / Firefox Extension
  ├─ 接收远端变化（按 URL 去重 + 同名文件夹精确定位）
  ├─ 创建 Safari Bookmarks 目录树
  └─ 上传本地 Safari Bookmarks 目录内的变化
```

## Cloudflare 部署

### 1. 安装依赖

```bash
cd worker
npm install
```

### 2. 创建 D1 数据库

```bash
npx wrangler d1 create bookmarks-db
```

### 3. 创建 KV 命名空间

```bash
npx wrangler kv:namespace create BOOKMARKS_KV
```

### 4. 复制并填写 `wrangler.toml`

```bash
cp wrangler.toml.example wrangler.toml
```

把上面两步输出里的 `database_id` 和 KV `id` 填进去：

```toml
[[d1_databases]]
binding = "DB"
database_name = "bookmarks-db"
database_id = "替换成 Cloudflare 生成的 D1 database_id"

[[kv_namespaces]]
binding = "BOOKMARKS_KV"
id = "替换成 Cloudflare 生成的 KV namespace id"
```

注意：

- `binding = "DB"`、`binding = "BOOKMARKS_KV"`、`name = "SYNC_CHANNEL"` 不能改。
- `wrangler.toml` 已加入 `.gitignore`，请勿将真实 ID 提交到版本库。

### 5. 初始化 D1 表

全新部署一次性跑完：

```bash
npx wrangler d1 execute bookmarks-db --file=migrations/001_schema.sql
npx wrangler d1 execute bookmarks-db --file=migrations/004_canonical_state.sql
```

注意：

- `001` 创建 `pairs` / `devices` / `bookmarks`（旧事件流表，保留兼容审计）。
- `004` 创建 `bookmark_state`（当前数据真相）。
- 如果你是从 1.0.x 升级，旧库可能缺少 `devices.token_hash` 或 `bookmarks.folder_path`，再按需执行：

```bash
npx wrangler d1 execute bookmarks-db --file=migrations/002_device_tokens.sql
npx wrangler d1 execute bookmarks-db --file=migrations/003_folder_paths.sql
npx wrangler d1 execute bookmarks-db --file=migrations/004_canonical_state.sql
```

> 1.0.x 升级提示：升级后 `bookmark_state` 是空的，已有数据保留在旧 `bookmarks` 表里但不会再被读取。让任一已配对的客户端点一次 "Sync Now"，它会用 canonical URL 重新写入 `bookmark_state`，整个同步组即完成迁移。

### 6. 部署 Worker

```bash
npx wrangler deploy
```

部署完成后访问 Worker 根路径：

```text
https://bookmarks.your-domain.workers.dev/
```

应该返回类似：

```json
{
  "name": "Safari Bookmarks Sync",
  "status": "ok",
  "endpoints": ["/health", "/api/pair/generate", ...]
}
```

### 7. 类型检查（可选）

```bash
npm run typecheck
```

## 数据模型

### `pairs`

| 字段 | 说明 |
|---|---|
| `id` | 同步组 UUID |
| `code_hash` | 配对码的 SHA-256 |
| `created_at` | 创建时间戳 |

### `devices`

| 字段 | 说明 |
|---|---|
| `id` | 设备 UUID |
| `pair_id` | 所属同步组 |
| `browser` | `safari` / `chrome` / `firefox` |
| `name` | 可选的设备名 |
| `token_hash` | 设备 token 的 SHA-256 |
| `created_at` | 注册时间戳 |

### `bookmark_state`（1.1 引入，主表）

| 字段 | 说明 |
|---|---|
| `pair_id` | 租户标识 |
| `url` | **canonical URL（主键的第二段）** |
| `title` | 当前标题 |
| `folder_path` | JSON 数组，例如 `["Favorites","科技新闻"]` |
| `idx` | 同级顺序 |
| `removed` | tombstone：1=已删除 |
| `last_actor` | 最后修改它的 device_id |
| `created_at` | 首次插入时间 |
| `updated_at` | 最近一次写入时间，作为 `since` 查询和 last-write-wins 的依据 |

**主键 = `(pair_id, url)`**：URL 在同一个 pair 内唯一，**不是全局唯一**。两个不同的 pair 即使都收藏了 `https://github.com`，也是两条独立行。

## 浏览器端安装

### Safari macOS App

Safari 端在 [safari-macos/App](safari-macos/App)。

用 Xcode 打开：

```bash
open "safari-macos/App/Safari Bookmarks Sync.xcodeproj"
```

选择 `Safari Bookmarks Sync (macOS)` scheme，Build and Run。

然后到 Safari：

```text
Safari -> Settings -> Extensions
```

启用 `Safari Bookmarks Sync` 扩展。

如果要重新打包测试版：

```bash
xcodebuild \
  -project "safari-macos/App/Safari Bookmarks Sync.xcodeproj" \
  -scheme "Safari Bookmarks Sync (macOS)" \
  -configuration Release \
  -derivedDataPath "safari-macos/App/build/DerivedData" \
  CODE_SIGN_STYLE=Manual \
  CODE_SIGN_IDENTITY=- \
  DEVELOPMENT_TEAM= \
  AD_HOC_CODE_SIGNING_ALLOWED=YES \
  build
```

### Chrome

1. 打开 `chrome://extensions`。
2. 开启 `Developer mode`。
3. 点击 `Load unpacked`。
4. 选择 [chrome-extension](chrome-extension)。

### Firefox

1. 打开 `about:debugging#/runtime/this-firefox`。
2. 点击 `Load Temporary Add-on`。
3. 选择 [firefox-extension/manifest.json](firefox-extension/manifest.json)。

临时扩展在 Firefox 重启后会失效，需要重新加载。正式分发需要走 Firefox Add-ons 签名流程。

## 使用流程

### 首次配对

1. 打开 macOS App。
2. 填入 Worker URL，例如 `https://bookmarks.example.com/`。
3. 点击 `Generate Pairing Code` 生成 6 位配对码（1 小时内有效，**且只能使用一次**）。
4. 在 Firefox 或 Chrome 扩展里填入同一个 Worker URL 和配对码。
5. 点击 `Connect`。
6. 回到 macOS App，点击 `Sync Now` 上传 Safari 书签。

### Safari -> Firefox / Chrome

1. macOS App 点击 `Sync Now`。
2. Firefox / Chrome 扩展会通过 WebSocket 接收变化。
3. 书签会写入：

```text
其他书签 / Safari Bookmarks / Favorites / Safari 原分类文件夹
```

如果没有实时出现，点击扩展里的 `Sync Now` 手动拉取。

### Firefox / Chrome -> Safari

1. 在 Firefox / Chrome 的 `Safari Bookmarks` 目录内新增或修改书签。
2. 扩展会把变化上传到 Worker。
3. **退出 Safari 后**，macOS App 点击 `Check Now` 查看是否有远端新增。
4. 点击 `Pull Remote Changes` 合并到 Safari。

> macOS App 现在会拒绝在 Safari 运行时写入 `Bookmarks.plist`。

### 自动检查

macOS App 里的 `Auto Check` 会每 5 分钟检查一次远端变化。它只做检查和提示，不会自动写入 Safari。真正写入仍需点击 `Pull Remote Changes`。

## Safari 权限说明

macOS App 需要访问：

```text
/Users/<name>/Library/Safari/Bookmarks.plist
```

通常不需要完整磁盘访问权限。更推荐：

1. 点击 App 里的 `Choose File`。
2. 手动选择 `/Users/<name>/Library/Safari/Bookmarks.plist`。
3. App 通过 sandbox 的 user-selected read-write 权限获得访问能力。

如果你替换了新版 App，需要重新点一次 `Choose File` 授权。当前工程已设置：

```text
com.apple.security.files.user-selected.read-write
```

## 安全说明

- **配对码一次性 + 限流**：单 IP 5 次失败后 1 小时禁止 join；成功一次后配对码立即失效。
- **device_token 仅在配对时返回一次**：失去 token 必须 unpair → 重新配对。
- **CORS 默认只信任浏览器扩展来源**：网页 JS 无法跨域调用 Worker API。
- **租户隔离**：所有 SQL 都强制带 `pair_id` 过滤；不同 pair 之间数据物理上同表，逻辑上完全独立。
- **常量时间 token 比较**：避免毫秒级时序攻击。
- **`wrangler.toml` 不入库**：仓库只包含占位符的 `wrangler.toml.example`。

## API

| Method | Path | 鉴权 | 说明 |
|---|---|---|---|
| `GET` | `/` | 无 | Worker 状态 |
| `GET` | `/health` | 无 | 健康检查（含 `server_now`） |
| `POST` | `/api/pair/generate` | 无 | 生成 6 位配对码 |
| `POST` | `/api/pair/join` | 无 | 使用配对码加入同步组（一次性） |
| `GET` | `/api/pair/info?pair_id=X` | 无 | 查看同步组设备 |
| `POST` | `/api/sync` | Bearer | 上传书签变更（UPSERT） |
| `GET` | `/api/bookmarks?pair_id=X&device_id=X` | Bearer | 获取当前书签快照 |
| `GET` | `/api/bookmarks/since?pair_id=X&device_id=X&since=TS` | Bearer | 获取增量变化（按 `updated_at`） |
| `GET` | `/ws?pair_id=X&device_id=X&device_token=X&browser=X` | query token | WebSocket 实时连接 |

所有响应都带 `server_now` 字段，客户端应用它来更新本地的 `last_sync`。

## 项目结构

```text
.
├── worker/                 Cloudflare Worker
│   ├── src/api/            pair / sync / bookmarks API
│   ├── src/durable/        Durable Object WebSocket hub
│   ├── src/utils/          canonical URL、鉴权、限流
│   ├── migrations/         D1 SQL migrations
│   └── wrangler.toml.example
├── safari-macos/App/       macOS App + Safari WebExtension Xcode project
├── chrome-extension/       Chrome MV3 extension
│   └── lib/canonical.js    Canonical URL 共享实现
├── firefox-extension/      Firefox extension
│   └── lib/canonical.js
└── README.md
```

## 常见问题

### Worker 页面返回 Not Found

确认浏览器扩展里填的是 Worker 根 URL，例如 `https://bookmarks.example.com/`。

### D1 报 no such table: pairs / bookmark_state

依次执行：

```bash
cd worker
npx wrangler d1 execute bookmarks-db --file=migrations/001_schema.sql
npx wrangler d1 execute bookmarks-db --file=migrations/004_canonical_state.sql
```

### Safari 提示 "Safari is running"

`Pull Remote Changes` 写入 plist 前会主动检测 Safari 是否运行。退出 Safari（⌘Q）再重试。

### Safari 提示没有权限访问 Bookmarks.plist

重新打开新版 App，点击 `Choose File`，手动选择 `/Users/<name>/Library/Safari/Bookmarks.plist`。

### Firefox / Chrome 显示已同步但书签慢慢出现

浏览器创建大量书签和目录需要时间，尤其是第一次同步 200+ 条书签时。等待一会儿或打开书签管理器观察 `Safari Bookmarks` 目录。

### 配对码提示 "Pairing code not found or expired"

配对码 1 小时有效，并且**只能使用一次**。如果配对失败请回到 macOS App 重新生成。

### 配对码提示 "Too many attempts"

同 IP 短时间内尝试错误次数过多被限流，等 1 小时或换网络。

## 开发校验

```bash
# JS 语法检查
node --check chrome-extension/background.js
node --check chrome-extension/offscreen.js
node --check chrome-extension/popup/popup.js
node --check chrome-extension/lib/canonical.js
node --check firefox-extension/background.js
node --check firefox-extension/popup/popup.js
node --check firefox-extension/lib/canonical.js
node --check "safari-macos/App/Shared (App)/Resources/Script.js"

# Worker 类型检查
cd worker && npm install && npm run typecheck
```

macOS App 构建：

```bash
xcodebuild \
  -project "safari-macos/App/Safari Bookmarks Sync.xcodeproj" \
  -scheme "Safari Bookmarks Sync (macOS)" \
  -configuration Debug \
  build
```
