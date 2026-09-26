# Safari Bookmarks Sync

把 Safari 书签同步到 Chrome 和 Firefox，一切以 Safari 的分类为准。服务端是你自己部署的 Cloudflare Worker，每个同步组的数据存在独立的 SQLite Durable Object 里。

> 写入书签前会自动备份（Mac 端备份 `Bookmarks.plist`，浏览器端首次连接前备份整个书签树），但仍建议先自行备份一次 Safari 书签。

## 工作方式

- **以 Safari 为准。** 书签在哪个文件夹、叫什么名字，都以 Safari 为准。浏览器里已经存在的同网址书签，不管放在哪里，都会被移动到 Safari 对应的分类里，不会重复新建。浏览器里的同步位置是 `其他书签 / Safari Bookmarks / <Safari 的文件夹>`。
- **一个 Access Key 就是一个用户，对应一个同步组（Pair ID）。** Mac 用 Access Key 连接；Chrome 和 Firefox 用 Mac App 生成的一次性配对码加入同一个组。同一个 key 以后再连接（换 Mac、重装）会回到原来的组，不会生成新的 Pair ID。
- **在浏览器里新增的书签会同步回 Safari。** 在 Chrome/Firefox 的 `Safari Bookmarks` 文件夹里新增的书签，会在 Safari 退出后写入 Safari。
- **删除双向同步。** 在 Safari 删除的书签，各浏览器会跟着删除；在 Chrome 或 Firefox 删除的书签，另一个浏览器会跟着删除，Mac App 也会在 Safari 没运行时把它从 Safari 的书签文件里删掉（删之前先备份）。把书签移出 `Safari Bookmarks` 文件夹也算删除。
- **移动和改名以 Safari 为准。** 在浏览器里移动或改名 Safari 的书签，会被放回原位；要调整分类请在 Safari 里做。
- **大批量删除需要确认。** 在 Safari 一次消失的书签超过 20 条且超过 10% 时，Mac App 会先请你确认；在浏览器里 10 分钟内删除的 Safari 书签超过同样的数量时，书签会先被放回，扩展图标上出现红色 "!"，在扩展弹窗里确认后才会在所有地方删除。这是为了防止误删或文件异常。
- **同一网址在数据库里只有一行。** 每个同步组里，一个网址只有一条记录，移动或改名只更新这一行。删除记录保留 90 天后自动清理。不同用户的数据互相隔离，不共用记录。

完整规则见 [docs/SYNC-V2.md](docs/SYNC-V2.md)。

```text
Mac 菜单栏 App (AppKit)                 Chrome / Firefox 扩展
  读取并写回 Bookmarks.plist              按 Safari 的分类放置书签
  上传 Safari 快照 / 导入浏览器新增        上传 Safari Bookmarks 文件夹里的改动
            │                                        │
            └──────────────► Cloudflare Worker ◄──────┘
                              /v2 API
                              SyncGroup Durable Object：每个组一个 SQLite
                              Registry Durable Object：Access Key、配对码、限流
```

## 目录

| 目录 | 内容 |
|---|---|
| `worker/` | Cloudflare Worker，代码在 `src/v2`，管理页面在 `public/admin` |
| `extensions-shared/` | 两个浏览器扩展共用的同步引擎、弹窗和测试（改这里，再运行 `scripts/sync-extensions.sh`） |
| `chrome-extension/`, `firefox-extension/` | 扩展本体，`lib/` 和 `popup/` 由脚本从 `extensions-shared/` 复制 |
| `macos-app/` | Mac 菜单栏 App，Xcode 工程由 `project.yml` 用 XcodeGen 生成 |
| `docs/SYNC-V2.md` | 同步协议与规则 |

## 部署 Worker

需要 Node.js 22 和一个 Cloudflare 账号。

```bash
cd worker
npm install
```

**配置文件。** `worker/wrangler.toml` 已经在仓库里，只有 Worker 名称和两个 Durable Object 绑定，没有任何和账号相关的 ID，不用修改。所有数据都存在 Durable Object 里，不需要 D1 或 KV。

**设置密钥。** 至少设置一个。两个都不设置时，任何人都不能创建同步组。

```bash
openssl rand -hex 24                   # 生成一个随机密钥
npx wrangler secret put ACCESS_KEY     # 你自己的 Access Key
npx wrangler secret put ADMIN_KEY      # 可选：打开管理页面，给其他用户发 Access Key（和 ACCESS_KEY 用不同的值）
```

**部署。** Durable Object 的迁移会随部署自动执行：

```bash
npx wrangler deploy
curl https://<你的 Worker 地址>/v2/health
```

### 管理页面：给其他用户发 Access Key（可选，需要 ADMIN_KEY）

设置了 `ADMIN_KEY` 之后，打开 `https://<你的 Worker 地址>/admin`，用 ADMIN_KEY 登录（登录状态保持 12 小时）。页面支持中文和英文，可以：

- 查看所有用户：状态、书签数和上限、设备数、最后活动时间；
- 新建 Access Key：填备注名和书签上限（1 到 50000），旁边附带可以直接发给对方的设置说明；
- 查看 Access Key：用户列表里显示每个 Key 的开头和结尾（例如 `sbk_1a2b…9f0e`），在"管理"里点"显示"可以看到完整的 Key 并复制。Key 用由 ADMIN_KEY 派生的密钥加密保存；这个功能加入之前发的 Key、或者更换 ADMIN_KEY 之前发的 Key 无法查看，重置后就可以；
- 编辑备注名和书签上限。上限调低到比现有书签还少时，已有书签保留，新增的书签不再同步；
- 重置 Key：用户弄丢 Key 时用。旧 Key 立即失效，同步组、书签和已连接的设备都保留，只有连接新设备时需要新 Key；
- 吊销 Key：这个用户的所有设备立即停止同步，无法恢复；
- 删除用户：吊销之后可以把这个用户整个删除（Key 和服务器上的全部同步数据，需要输入确认）；
- 删除某个用户在服务器上的全部同步数据（需要输入确认），Key 保留，用户重新连接后从头同步。用户电脑和浏览器里的书签都不受影响。

安全措施：ADMIN_KEY 只在登录时发送一次，之后用 HttpOnly Cookie 保持登录；同一个 IP 一小时内输错 10 次会被暂时拒绝；修改 ADMIN_KEY 会让所有已登录的页面失效。想再加一层保护，可以在 Cloudflare Zero Trust 里给 `/admin` 路径配置 Cloudflare Access（邮箱验证码登录，50 人以内免费）。

同样的操作也可以用命令行完成：

```bash
W=https://<你的 Worker 地址>; A="Authorization: Bearer <ADMIN_KEY>"; J="Content-Type: application/json"

# 发一个 key（max_bookmarks 可选，默认 50000）
curl -X POST $W/v2/admin/keys -H "$A" -H "$J" -d '{"label":"朋友A","max_bookmarks":5000}'

# 列出所有 key、它们的同步组和用量
curl $W/v2/admin/keys -H "$A"

# 修改备注名或书签上限 / 重置 key（返回新 key）/ 查看 key
curl -X PATCH $W/v2/admin/keys/<key_id> -H "$A" -H "$J" -d '{"label":"朋友A","max_bookmarks":8000}'
curl -X POST $W/v2/admin/keys/<key_id>/reset -H "$A"
curl -X POST $W/v2/admin/keys/<key_id>/reveal -H "$A"

# 查看某个组的用量、设备
curl $W/v2/admin/groups/<pair_id> -H "$A"

# 吊销 key（同时停用它的组）/ 吊销后删除这个用户
curl -X DELETE $W/v2/admin/keys/<key_id> -H "$A"
curl -X POST $W/v2/admin/keys/<key_id>/delete -H "$A"

# 只停用某个组 / 删除某个组的全部数据
curl -X POST $W/v2/admin/groups/<pair_id>/disable -H "$A"
curl -X DELETE $W/v2/admin/groups/<pair_id> -H "$A"
```

## 安装与使用

### Mac App

1. 打开 `dist/Safari-Bookmarks-Sync-2.0.3.dmg`，把 App 拖进"应用程序"。App 用开发者证书签名但没有公证，第一次打开需要在 Finder 里右键点击 App，选"打开"。
2. App 常驻在菜单栏，第一次打开会弹出设置窗口。填入 Worker 地址和你的 Access Key，点"Connect"。
3. 接着会弹出一个已经定位在 Safari 文件夹的选择框，点"Allow Access"。macOS 把 `~/Library/Safari` 列为受保护目录，任何 App 都不能自己读取，所以这一步授权是必需的，只需做一次。
4. 设置窗口会显示一个配对码（例如 `K7PM-3QXD`，30 分钟内有效、只能用一次），拿去给 Chrome 或 Firefox 用。需要时可以点"New Pairing Code"重新生成。

之后 App 会自动同步：
- `Bookmarks.plist` 变化时（每 15 秒检查一次）；
- Safari 退出时；
- 其他浏览器有改动时（通过 WebSocket 通知）；
- 以及每 10 分钟一次。

菜单栏会显示状态、等待写入 Safari 的书签数量，以及需要你确认的删除。设置窗口里可以查看和移除设备，也可以设置开机自动启动。

写入 Safari 书签的保护措施：
- 只在 Safari 没有运行时写入。
- 写入前先把原文件备份到 App 自己的目录，最多保留最近 20 份。
- 写入后重新读取校验，失败就恢复原文件。

### Chrome

1. 打开 `chrome://extensions`，开启"开发者模式"，点"加载已解压的扩展程序"，选 `chrome-extension/` 目录。上架 Chrome 应用商店时用 `dist/safari-bookmarks-sync-chrome-2.0.2.zip`。需要 Chrome 116 或更新版本。
2. 点扩展图标，填入 Worker 地址和配对码，点"Connect"。
3. 连接前会先备份整个书签树，弹窗里可以随时下载这份备份。

### Firefox

1. 打开 `about:debugging#/runtime/this-firefox`，点"临时载入附加组件"，选 `firefox-extension/manifest.json`。上架 addons.mozilla.org 时用 `dist/safari-bookmarks-sync-firefox-2.0.2.zip`。
2. 使用方法同 Chrome。

## 从 1.x 升级

新版已经删除旧版 v1 接口。部署新 Worker 后，没有升级的旧 Mac App、Safari 扩展和浏览器扩展都会停止同步，所以请把各端一起升级。

1. **Worker**：部署新版。部署时会自动删除旧版的 `SyncChannel` Durable Object，它只负责实时通知，不保存书签。旧版的书签数据在 D1 数据库 `bookmarks-db` 和 KV 命名空间 `BOOKMARKS_KV` 里，新版不再读取，也不会迁移（各端重新连接后会从 Safari 重新上传）。确认新版工作正常后，可以在 Cloudflare 控制台里手动删除这两个资源。
2. **Mac**：新 App 的 Bundle ID 变了（`com.lengmuning.bookmarks-sync`），不会读取旧 App 的设置，需要在新 App 里重新连接。确认新 App 工作正常后，删除旧的 "Safari Bookmarks Sync" App，旧的 Safari 扩展会随之消失。
3. **浏览器扩展**：升级到 2.0 以上版本后，弹窗会提示用 Mac App 生成的新配对码重新连接。连接时，旧的 `Safari Bookmarks` 文件夹会被改名为 `Safari Bookmarks (before sync v2)`，然后新建一个干净的同步文件夹：
   - Safari 里有的书签会被移到新文件夹；
   - 旧文件夹最后只剩 Safari 里没有的书签。旧版从不同步删除操作，所以这些多半是早已在 Safari 删掉的，App 不会上传它们，留给你检查。想保留的，拖进新的 `Safari Bookmarks` 文件夹即可；
   - 旧文件夹如果被清空了，会自动删除。

## 开发与测试

需要 Node.js 22、Xcode 26、XcodeGen（`brew install xcodegen`）。

```bash
scripts/check.sh                   # 所有单元测试和检查（Worker、扩展、Mac App）
scripts/e2e.sh                     # 本地启动 Worker（wrangler dev，不连 Cloudflare），浏览器引擎和 Mac 同步引擎都对它跑一遍完整流程
scripts/sync-extensions.sh         # 修改 extensions-shared/ 之后复制到两个扩展
scripts/package-extensions.sh      # 打包两个扩展的 zip 到 dist/
macos-app/scripts/build-dmg.sh     # Release 构建并打包 DMG 到 dist/
macos-app/scripts/generate.sh      # 生成 Xcode 工程后可以用 Xcode 打开 macos-app/BookmarksSync.xcodeproj
swift scripts/make-icons.swift     # 重新生成 Mac App 和两个扩展的图标
```

Mac App 的 Debug 版支持 `-snapshot-settings`（加 `-paired` 显示已连接的状态），会把设置窗口渲染成 PNG 保存到 App 的临时目录，用来检查排版。

## 已知限制

- **经 iCloud 同步依赖 Safari 的内部格式。** Safari 的 iCloud 同步只上传书签文件里 `Sync.Changes` 列出的改动，App 写入时会按 Safari 自己的格式记下这些改动（见 [docs/SYNC-V2.md](docs/SYNC-V2.md) 的 "iCloud" 一节），这样浏览器里的新增和删除会经 iCloud 传到你的其他苹果设备。这不是公开接口，Safari 更新后可能失效。
  - Safari 打开时并不会马上上传这些改动。App 会通过 AppleScript 让 Safari 重新添加一条阅读列表项 "Safari Bookmarks Sync" 来触发上传，第一次需要在"系统设置 → 隐私与安全性 → 自动化"里允许 App 控制 Safari。不允许也可以：下一次你在 Safari 或其他苹果设备上改动书签时，这些改动会一起上传。
  - 2.1 之前的版本写进 Safari 的书签没有传到 iCloud，2.1 第一次写入时会把它们补上。
- **没有公证。** 公证需要付费的 Apple Developer Program 会员；在此之前，第一次打开需要右键选"打开"。
- **浏览器里的书签顺序不按 Safari 排。** 书签会放进正确的文件夹，但在文件夹内的顺序不跟 Safari 保持一致。
- **只支持桌面版 Firefox。** Android 版 Firefox 没有书签 API，所以扩展没有声明支持 Android。
