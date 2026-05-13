# Safari Bookmarks Sync / Safari 书签同步

把 Safari 书签同步到 Firefox / Chrome，并保留 Safari 里的分类文件夹和文件夹名称。后端运行在 Cloudflare Worker，数据存储使用 Cloudflare D1，配对码使用 KV，实时推送使用 Durable Object WebSocket。

> 当前项目仍处于测试阶段，适合研究和小范围自测。写入浏览器书签前建议先备份 Safari 书签。

## 当前能力

- Safari macOS App 读取 `/Users/<name>/Library/Safari/Bookmarks.plist`，上传到 Worker。
- Firefox / Chrome 在“其他书签”下创建 `Safari Bookmarks` 根目录，并按 Safari 的 `Favorites/分类文件夹/子文件夹` 结构创建书签。
- Firefox / Chrome 在 `Safari Bookmarks` 根目录内新增、修改、移动、删除书签时，会把变更上传到 Worker。
- Safari macOS App 支持 `Check Now`、`Auto Check` 和 `Pull Remote Changes`。
- `Auto Check` 每 5 分钟检查远端是否有 Safari 缺失的书签，但不会自动写入 Safari。
- `Pull Remote Changes` 手动把远端新增书签合并回 Safari。

## 目前限制

- Safari 侧当前是“手动上传 + 手动拉取远端新增”，不是后台静默全自动写入。
- Safari 拉取远端变化时，目前主要合并缺失书签，不做危险的覆盖、删除和全量重排。
- Chrome / Firefox 只监听 `Safari Bookmarks` 根目录内的变化，避免把浏览器里所有个人书签都上传。
- 如果同一个 URL 放在不同文件夹，会按 `url + folder_path` 判断，允许存在于不同分类里。

## 架构

```text
Safari macOS App
  ├─ 读取/写入 Bookmarks.plist
  ├─ 上传 Safari 书签
  └─ 手动拉取远端新增
        │
        ▼
Cloudflare Worker
  ├─ D1: pairs / devices / bookmarks
  ├─ KV: 6 位配对码
  └─ Durable Object: WebSocket 广播
        ▲
        │
Chrome Extension / Firefox Extension
  ├─ 接收远端变化
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

把命令输出里的 `database_id` 填到 [worker/wrangler.toml](/Users/pretty/Downloads/DevOps/bookmarks/worker/wrangler.toml)：

```toml
[[d1_databases]]
binding = "DB"
database_name = "bookmarks-db"
database_id = "替换成 Cloudflare 生成的 D1 database_id"
```

注意：

- `binding = "DB"` 不能改，代码里使用的是 `env.DB`。
- `database_name` 可以是 `bookmarks-db`，也可以用你自己的名称。
- `database_id` 必须换成你 Cloudflare 账号里真实生成的 ID。

### 3. 创建 KV 命名空间

```bash
npx wrangler kv:namespace create BOOKMARKS_KV
```

把命令输出里的 `id` 填到 [worker/wrangler.toml](/Users/pretty/Downloads/DevOps/bookmarks/worker/wrangler.toml)：

```toml
[[kv_namespaces]]
binding = "BOOKMARKS_KV"
id = "替换成 Cloudflare 生成的 KV namespace id"
```

注意：

- `binding = "BOOKMARKS_KV"` 不能改，代码里使用的是 `env.BOOKMARKS_KV`。
- 这里填的是 KV namespace 的 `id`，不是名称。

### 4. Durable Object 绑定

[worker/wrangler.toml](/Users/pretty/Downloads/DevOps/bookmarks/worker/wrangler.toml) 里已经有：

```toml
[[durable_objects.bindings]]
name = "SYNC_CHANNEL"
class_name = "SyncChannel"

[[migrations]]
tag = "v1"
new_sqlite_classes = [ "SyncChannel" ]
```

注意：

- `name = "SYNC_CHANNEL"` 不能改，代码里使用的是 `env.SYNC_CHANNEL`。
- `class_name = "SyncChannel"` 要和 `worker/src/durable/SyncChannel.ts` 导出的类名一致。

### 5. 初始化 D1 表

新数据库只需要执行 `001_schema.sql`：

```bash
npx wrangler d1 execute bookmarks-db --file=migrations/001_schema.sql
```

如果你是从早期版本升级，旧库可能缺少 `devices.token_hash` 或 `bookmarks.folder_path`，再按需执行：

```bash
npx wrangler d1 execute bookmarks-db --file=migrations/002_device_tokens.sql
npx wrangler d1 execute bookmarks-db --file=migrations/003_folder_paths.sql
```

如果新库已经执行过 `001_schema.sql`，不要重复执行 `002` / `003`，否则 D1 会提示 column already exists。

### 6. D1 SQL 结构

当前完整建表 SQL 位于 [worker/migrations/001_schema.sql](/Users/pretty/Downloads/DevOps/bookmarks/worker/migrations/001_schema.sql)：

```sql
CREATE TABLE IF NOT EXISTS pairs (
  id TEXT PRIMARY KEY,
  code_hash TEXT UNIQUE NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  pair_id TEXT NOT NULL,
  browser TEXT NOT NULL,
  name TEXT,
  token_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (pair_id) REFERENCES pairs(id)
);

CREATE TABLE IF NOT EXISTS bookmarks (
  id TEXT PRIMARY KEY,
  pair_id TEXT NOT NULL,
  bookmark_id TEXT NOT NULL,
  title TEXT,
  url TEXT,
  parent_id TEXT,
  folder_path TEXT,
  idx INTEGER,
  action TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  FOREIGN KEY (pair_id) REFERENCES pairs(id)
);

CREATE INDEX IF NOT EXISTS idx_bookmarks_pair ON bookmarks(pair_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_devices_pair ON devices(pair_id);
```

字段说明：

| 表 | 字段 | 说明 |
|---|---|---|
| `pairs` | `id` | 一组同步设备的 pair id |
| `pairs` | `code_hash` | 6 位配对码的哈希 |
| `devices` | `token_hash` | 设备 token 哈希，用于接口鉴权 |
| `bookmarks` | `bookmark_id` | 浏览器侧书签 ID |
| `bookmarks` | `title` / `url` | 书签标题和链接 |
| `bookmarks` | `parent_id` | 浏览器侧父级 ID，仅作辅助信息 |
| `bookmarks` | `folder_path` | JSON 字符串数组，例如 `["Favorites","科技新闻"]`，用于恢复目录分级 |
| `bookmarks` | `idx` | 同级排序位置 |
| `bookmarks` | `action` | `create` / `update` / `remove` |
| `bookmarks` | `timestamp` | 变更时间戳 |

### 7. 部署 Worker

```bash
npx wrangler deploy
```

部署完成后访问 Worker 根路径，例如：

```text
https://bookmarks.your-domain.workers.dev/
```

应该返回类似：

```json
{
  "name": "Safari Bookmarks Sync",
  "status": "ok"
}
```

## 浏览器端安装

### Safari macOS App

Safari 端在 [safari-macos/App](/Users/pretty/Downloads/DevOps/bookmarks/safari-macos/App)。

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

测试版也可以直接使用已打包文件：

```text
dist/Safari Bookmarks Sync.app
dist/Safari Bookmarks Sync-test.zip
```

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
  -quiet build
```

### Chrome

1. 打开 `chrome://extensions`。
2. 开启 `Developer mode`。
3. 点击 `Load unpacked`。
4. 选择 [chrome-extension](/Users/pretty/Downloads/DevOps/bookmarks/chrome-extension)。

### Firefox

1. 打开 `about:debugging#/runtime/this-firefox`。
2. 点击 `Load Temporary Add-on`。
3. 选择 [firefox-extension/manifest.json](/Users/pretty/Downloads/DevOps/bookmarks/firefox-extension/manifest.json)。

临时扩展在 Firefox 重启后会失效，需要重新加载。正式分发需要走 Firefox Add-ons 签名流程。

## 使用流程

### 首次配对

1. 打开 macOS App。
2. 填入 Worker URL，例如 `https://bookmarks.example.com/`。
3. 点击 `Generate Pairing Code` 生成 6 位配对码。
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
3. macOS App 点击 `Check Now` 查看是否有远端新增。
4. 点击 `Pull Remote Changes` 合并到 Safari。
5. 如果 Safari 菜单没有立刻刷新，退出并重新打开 Safari。

### 自动检查

macOS App 里的 `Auto Check` 会每 5 分钟检查一次远端变化。

它只做检查和提示，不会自动写入 Safari。真正写入仍需点击 `Pull Remote Changes`。

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

## API

| Method | Path | 说明 |
|---|---|---|
| `GET` | `/` | Worker 状态 |
| `GET` | `/health` | 健康检查 |
| `POST` | `/api/pair/generate` | 生成 6 位配对码 |
| `POST` | `/api/pair/join` | 使用配对码加入同步组 |
| `GET` | `/api/pair/info?pair_id=X` | 查看同步组设备 |
| `POST` | `/api/sync` | 上传书签变更 |
| `GET` | `/api/bookmarks?pair_id=X&device_id=X&device_token=X` | 获取当前书签快照 |
| `GET` | `/api/bookmarks/since?pair_id=X&device_id=X&device_token=X&since=TS` | 获取增量变化 |
| `GET` | `/ws?pair_id=X&device_id=X&device_token=X&browser=X` | WebSocket 实时连接 |

## 项目结构

```text
.
├── worker/                 Cloudflare Worker
│   ├── src/api/            Pair / sync / bookmarks API
│   ├── src/durable/        Durable Object WebSocket hub
│   ├── src/db/             D1 schema copy
│   ├── migrations/         D1 SQL migrations
│   └── wrangler.toml       Cloudflare bindings
├── safari-macos/App/       macOS App + Safari WebExtension Xcode project
├── chrome-extension/       Chrome MV3 extension
├── firefox-extension/      Firefox extension
├── dist/                   Local packaged test app
├── WECHAT_ARTICLE.md       微信公众号文章草稿
└── README.md
```

## 常见问题

### Worker 页面返回 Not Found

先确认浏览器扩展里填写的是 Worker 根 URL，例如：

```text
https://bookmarks.example.com/
```

不要填错路径，也不要填旧的 Worker 地址。

### D1 报 no such table: pairs

说明 D1 表还没初始化。执行：

```bash
cd worker
npx wrangler d1 execute bookmarks-db --file=migrations/001_schema.sql
```

### D1 报 no column named folder_path

说明你是旧数据库升级，缺少目录字段。执行：

```bash
cd worker
npx wrangler d1 execute bookmarks-db --file=migrations/003_folder_paths.sql
```

### Safari 提示没有权限访问 Bookmarks.plist

重新打开新版 App，点击 `Choose File`，手动选择：

```text
/Users/<name>/Library/Safari/Bookmarks.plist
```

如果仍失败，确认运行的是 `dist` 里的新版 App，并退出旧进程后再打开。

### Firefox / Chrome 显示已同步但书签慢慢出现

浏览器创建大量书签和目录需要时间，尤其是第一次同步 200+ 条书签时。等待一会儿或打开书签管理器观察 `Safari Bookmarks` 目录。

### Safari 拉取显示 0 条新增

这通常表示 Worker 远端没有新的书签记录。可以先在 Firefox / Chrome 扩展点击 `Sync Now`，让扩展扫描 `Safari Bookmarks` 目录并上传本地缺失记录，再回 macOS App 点击 `Check Now`。

## 开发校验

```bash
node --check chrome-extension/background.js
node --check firefox-extension/background.js
node --check "safari-macos/App/Shared (App)/Resources/Script.js"
```

macOS App 构建：

```bash
xcodebuild \
  -project "safari-macos/App/Safari Bookmarks Sync.xcodeproj" \
  -scheme "Safari Bookmarks Sync (macOS)" \
  -configuration Debug \
  -quiet build
```
