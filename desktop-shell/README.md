# Endaxis 本地版（Electron 套壳）

把 [Endaxis](https://github.com/Lieyuan621/Endaxis)（《明日方舟：终末地》排轴工具，Web 版）
包装成一个可安装、可离线启动的 Windows 桌面应用。

- 上游项目：<https://github.com/Lieyuan621/Endaxis>（分支 `refactor/v3`）
- 本目录：只包含**桌面壳**。前端业务代码全部来自上游仓库，本壳不改动它。

```
endaxis-local/
├── Endaxis/          # git clone 下来的上游项目（Vue 3 + Vite）
└── desktop-shell/    # 本目录：Electron 壳
```

---

## 快速开始

```powershell
cd desktop-shell

npm install          # 安装 Electron 等依赖
npm run build:web    # 用上游项目构建前端产物 → ../Endaxis/dist
npm run prepare:dist # 把产物同步到 webapp/（打包时进安装包的那份）
npm run icon         # 从项目 logo 生成 build/icon.ico / icon.png
npm start            # 启动本地版 App
```

`npm run setup` 等价于上面第 2~4 步（依赖需已安装）。

---

## 有哪些命令

| 命令                                                                 | 作用                                                                |
| -------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `npm start`                                                          | 启动本地版 App（生产模式，读 `webapp/`）                            |
| `npm run dev`                                                        | 开发模式：起 Vite 开发服务器 + 桌面窗口，支持热更新                 |
| `npm run verify`                                                     | 自动检查：起窗口、加载页面、断言渲染结果（含截图）                  |
| `npm run verify:window`                                              | 自动检查：走真实入口启动，确认窗口真的显示出来                      |
| `npm run verify:packaged`                                            | 自动检查：跑 `release/win-unpacked/Endaxis.exe`，确认打包版能起来   |
| `npm run verify:autosave`                                            | 自动检查：自动保存的防抖与自动恢复（真实窗口里数 IndexedDB 写事务） |
| `npm run verify:closeflush`                                          | 自动检查：**改完立刻关程序**，数据不丢（真的关掉再重开一次进程）    |
| `npm run verify:storage-migration`                                   | 自动检查：孤儿存档库清理的删除/保留边界                             |
| `npm run verify:port-conflict`                                       | 自动检查：端口被占用时**不换端口**，明确报错                        |
| `node --use-env-proxy tools/verify-release.mjs <owner> <repo> <ver>` | 线上 Release 可用性验收（匿名下载 + sha512 核对）                   |
| `node --use-env-proxy tools/verify-feed-fallback.mjs <owner> <repo>` | 限流回退路径（Releases Atom feed）可用性                            |
| `node scripts/launch.mjs tools/verify-update.js`                     | 自动检查：自动更新端到端（见「验证自动更新」）                      |
| `npm run diagnose`                                                   | 启动诊断：记录失败请求、控制台输出、首屏状态                        |
| `npm run check`                                                      | 主进程源码语法检查                                                  |
| `npm run prepare:runtime`                                            | 生成要打进包的生产依赖树（`app-runtime/`）                          |
| `npm run dist`                                                       | 打包成 Windows 安装包 → `release/`                                  |
| `npm run dist:dir`                                                   | 只展开目录、不做安装包（调试打包配置用）                            |

`verify:packaged` 也可以指定任意一份 exe，例如验证安装后的那一份：

```powershell
node scripts/launch.mjs tools/verify-exe.js "$env:LOCALAPPDATA\Programs\Endaxis\Endaxis.exe"
```

三个 `verify*` 命令都以退出码报告结果，可以直接接进 CI。
`verify` 会在 `verification/window.png` 留一张截图，方便肉眼复核界面。

### 验证命令的两个坑（都已处理，改代码时别踩回去）

1. **不要用 PowerShell 的 `Start-Process` 启动被测 exe。**
   同一个 `Endaxis.exe`，用 `Start-Process` 启动会以退出码 9 立刻失败，
   用 Node 的 `spawn` 启动则完全正常。这是启动方式的问题，不是应用缺陷。
   所有验证脚本都用 `spawn`。
2. **探针开关走命令行参数，不走环境变量。**
   从一个 Electron 进程里 `spawn` 打包版时，环境变量不保证传得进去（实测过），
   命令行参数 `--endaxis-startup-probe` 则总是可靠。
   同理，**不要用 `executeJavaScript` 去读渲染进程状态**：打包版里它会挂住
   不返回，开发版却正常。探针只用主进程 API（`isVisible` / `getTitle` / `getURL`）。

改完前端代码后，`npm start` 前要重新跑一次 `npm run build:web && npm run prepare:dist`；
开发时用 `npm run dev` 可以免去这一步。

---

## 它是怎么工作的

### 为什么需要一层本地 HTTP 服务器

前端产物用 `/assets/...` 这类**绝对路径**引用资源，路由用的是 `createWebHistory('/')`
（只有 Android 容器才切到 hash 路由）。直接 `file://` 打开会让绝对路径和 History 路由
同时失效。

所以主进程在 `127.0.0.1` 上起一个**只监听回环地址**的静态服务器
（`src/main/server.js`），再把窗口指过去。这样相对路径、History API、IndexedDB、
localStorage 全都按标准浏览器语义工作，等于把线上站点原样搬进窗口。

#### 端口必须固定，不能用随机端口（这条是数据能不能保住的根因）

浏览器按 **origin（协议 + 主机 + 端口）隔离存储**。早期版本用 `listen(0)` 拿随机端口，
于是**每次启动都是全新 origin**，上一次的项目数据变成读不到的孤儿：

```
%APPDATA%\endaxis-desktop\IndexedDB\
  http_127.0.0.1_4491...   ← 第一次启动写的
  http_127.0.0.1_8006...   ← 第二次启动写的（与上面毫不相干）
  ...（实测积累了 70 多个孤儿库）
```

用户感受到的就是「设置好干员 → 关掉 → 再打开，又回到初始状态」。
现在固定用 `17321`（被占用时依次退到 27321 / 37321 / 47321 / 57321），
所有启动共享同一个 origin，存档才能真正被读回来。

改动这个方法时请注意：**不要改回随机端口或"占用就换一个"**。
换端口 = 换 origin = 用户读不到自己的项目。原因与实测见下文。

#### 端口被占用时：重试，然后明确报错（绝不换端口）

这是刻意的设计取舍，别"优化"成自动换端口：

- **先重试固定端口**约 12 秒（`PORT_RETRY_DELAYS_MS`）。绝大多数"占用"其实是
  上一个实例正在退出，重试就能接上，用户完全无感；
- **仍然占用就报错退出**，弹窗说明端口号、排查命令和日志路径。
  换端口虽然能让程序"起来"，但用户会看到一个读不到自己项目的空应用——
  那比直接报错更糟，因为看起来像数据被清空了。

> 实测结论（别重走这条路）：曾尝试把 Chromium 存储根 `app.setPath('sessionData', …)`
> 固定到一个与端口无关的目录，希望换端口后仍能读到存档。**该方案无效**——
> Chromium 在存储根内部**仍然按 origin（含端口）分目录**。
> 既然没有任何办法让两个端口共享同一个 IndexedDB，唯一正确的做法就是不换端口。
> 这个结论由 `npm run verify:port-conflict` 守住：占用时必须是
> `PortUnavailableError`，且不得起在别的端口。

#### 启动时的一次性清理

固定端口上线后，历史遗留的孤儿库只是垃圾。应用会在**首次启动时自动清理一次**
（`src/main/storageMigration.js`），只在 IndexedDB 目录内动手，并且：

| 目录                                                  | 处理                           |
| ----------------------------------------------------- | ------------------------------ |
| `http_127.0.0.1_<随机端口>.indexeddb.leveldb`         | 删除                           |
| 当前会话端口的库                                      | **保留**（删了就是删当前数据） |
| 任一首选固定端口（17321/27321/37321/47321/57321）的库 | 保留                           |
| 其它任何名字                                          | 不碰                           |

如果本次启动因端口冲突退回了随机端口，清理会**整体跳过**——那种情况下无法
可靠区分孤儿与当前数据。清理结果记录在 `%APPDATA%\endaxis-desktop\storage-migration.json`，
只执行一次。可用环境变量干预：`ENDAXIS_SKIP_STORAGE_MIGRATION=1` 跳过，
`ENDAXIS_FORCE_STORAGE_MIGRATION=1` 强制重跑（排查用）。

服务器只服务 `webapp/` 目录：

- 越界的路径（`..` 之类）一律回落到 SPA 入口，不会读到目录外的文件；
- 未命中的路径回落到 `index.html`，让前端路由接管；
- 非 `GET`/`HEAD` 直接拒绝。

### 为什么不声明 `EndaxisApp/` 标记

上游把「原生壳」定义为 UA 里带 `EndaxisApp/` 标记，并且明确规定
**「Endaxis 原生壳始终使用移动工作台」**
（见 `docs/architecture/runtime-environment.md` 与 `src/ui/timeline/timelineLayoutPolicy.ts`）。

也就是说：只要壳声明了该标记，时间轴就会被强制切成手机版工作台——对桌面应用来说这是
功能倒退。因此本壳只声明一个**普通 Windows 桌面 Chrome 身份**（剥离 Electron 标识），
让项目按自身规则选到桌面工作台。`npm run verify` 会直接断言渲染出来的是
`workbench-layout`（桌面工作台）而不是移动工作台，防止以后被误改。

上游另外两个桥接钩子（`window.EndaxisNative.appReady`、`window.EndaxisHandleBack`）
只在声明了该标记时才被调用，本壳不声明标记，因此不需要注入 preload，
窗口也就保持 `sandbox: true` + `contextIsolation: true` + `nodeIntegration: false`。

### 安全与体验上做的事

- 外部链接一律交给系统浏览器打开，窗口内不允许导航出去；
- `window.open` 弹窗全部拒绝；
- 定位、USB、串口、HID 等无关权限直接拒绝，只放开全屏与剪贴板写入；
- 导出文件走系统「另存为」对话框，而不是默默写进下载目录；
- 记住窗口大小/位置/最大化状态（跨 DPI 显示器也按 DIP 保存）；
- 关窗即退出，第二次启动会聚焦已有窗口（同一份 IndexedDB 只能一个实例写）；
- 项目自动保存按 1.2 秒窗口合并写入（见「自动保存的写入频率」）。

---

## 自动保存的写入频率（对上游的唯一改动）

上游原本**每次项目提交都立刻写一次 IndexedDB**，拖拽和连续输入会产生大量短事务。
本地版把它改成**合并写入**：

- 连续改动合并进 1.2 秒的窗口，只落盘一次；
- 持续编辑（一直"又改了"）最多推迟 15 秒强制落盘一次，避免保存被无限拖延；
- **关窗时不丢数据**：`beforeunload` 先把手里的改动交出去，再决定是否弹离页确认。
  只要有排队或进行中的写入就仍然提示，用户点"离开"时数据已经写出去了。

实测（真实窗口里数 IndexedDB 写事务）：

```
[verify:autosave] 编辑 → 写入延迟：17ms        # 首写立即落盘（降低数据风险）
[verify:autosave] 连续 8 次编辑 → 1 次写入      # 连续编辑被合并
[verify:autosave] 重载后读回存档：命中预置标记  # 自动恢复仍然正常
[verify:autosave] 通过：自动恢复可用，写入已按防抖窗口合并。
```

### 对上游的改动：1 个文件、2 行

写入频率只能在提交处接，所以上游仓库**有本地改动**。但这段逻辑本身放在
**我们自己的新文件** `src/desktop/browserSaveBridge.ts` 里，上游那边只有两行：

```diff
- import { saveBrowserProject } from '../../data/browserProjectStorage';
+ import { queueBrowserSave } from '../../desktop/browserSaveBridge';

-     void saveBrowserProject(snapshot.project).then(
+     void queueBrowserSave(snapshot.project).then(
```

其余（错误上报、未落盘计数、离页保护、作用域销毁）全部保留上游原写法；
`TimelineEditor.vue` **完全没有改动** —— 关窗接线由桥接模块在导入时自注册。

早期版本把防抖直接写进上游文件（`projectFileSession.ts` +130 行、
`TimelineEditor.vue` +15 行），结果上游一次普通重构（把 `selectProjectExportScope`
搬到新模块）就让定时同步冲突失败。现在补丁面是 2 行，且只涉及"保存调用"一个语义点。

上游更新后重新落地这两行（幂等，且找不到锚点会拒绝执行）：

```powershell
cd ../Endaxis
node desktop-shell/scripts/minimize-patch.mjs fbf6a292   # 传上游基准提交
```

只有测试文件需要一处补充：上游的错误上报用例假设"提交后已落盘"，而合并写入
可能把它排到防抖窗口之后，所以那处加了一行显式 `await flushBrowserSave()`
（见 `desktop-shell/scripts/patch-upstream-test.mjs`）。

测试分布：

- `src/desktop/browserSaveBridge.test.ts`（新增，7 个用例）锁住合并语义：
  首写立即、连续编辑只写一次、Promise 在写完后才结算、失败不残留、关窗等待有上限。
- `src/ui/timeline/projectFileSession.test.ts`（上游，8 个用例）仍全过。

实测输出（`npm run verify:autosave`）：

```
[verify:autosave] 编辑 → 写入延迟：17ms            # 首写立即落盘
[verify:autosave] 连续 8 次编辑 → 1 次写入        # 连续编辑被合并
[verify:autosave] 重载后读回存档：命中预置标记
```

---

## 自动更新

已接入 [electron-updater](https://www.electron.build/auto-update)，更新源为
**GitHub Releases**。

### 工作方式

1. 启动约 8 秒后**静默检查**一次新版本，失败不打扰用户；
2. 发现新版本 → 弹窗显示版本号与更新说明，用户选「下载并安装 / 稍后 / 跳过此版本」；
3. 确认后下载更新包，任务栏显示进度，electron-updater 负责校验 sha512；
4. 下载完成 → 再确认一次「重启并安装」；
5. 安装前**自动备份项目数据**到 `%APPDATA%\endaxis-desktop\data-backups\<时间戳>\`；
6. 重启完成更新。

菜单「帮助 → 检查更新…」可随时手动检查。

**为什么不做静默自动安装**：本程序没有代码签名，未经用户确认就替换其机器上的程序
风险太高。所以下载和安装都需要用户点确认。

### 你需要改一处配置

`package.json` 里的更新源必须是**你自己的仓库**（当前已指向 `xuan06zyx/Endaxis`）：

```json
"publish": [{ "provider": "github", "owner": "xuan06zyx", "repo": "Endaxis" }]
```

客户端打包时会把这段写进 `resources/app-update.yml`，之后就去
`https://github.com/<owner>/<repo>/releases` 找更新。

### 发布新版本的流程

**方式一：GitHub Actions（推荐，已配好）**

`.github/workflows/desktop-release.yml` 已提交到仓库（`refactor/v3` 分支）。用法：

1. 仓库 Settings → Secrets and variables → Actions → 新建 secret **`GH_TOKEN`**
   （fine-grained PAT，只授权本仓库、Contents: Read and write；名字必须叫 `GH_TOKEN`）；
2. Actions → **Desktop Release** → Run workflow，版本号留空则自动把 patch +1；
3. 工作流会：装依赖 → 构建前端 → 构建安装包 → 串行上传三个资产 → 转 Published
   → 用 `tools/verify-release.mjs` 做匿名可用性验收。

**方式二：本地发布**

```powershell
cd desktop-shell
npm version patch --no-git-tag-version     # 或指定版本
npm run package:win
pwsh -File scripts/publish-release.ps1 -Version 1.0.3
```

发布后可用它自己会做的事来验收：

```powershell
node --use-env-proxy tools/verify-release.mjs xuan06zyx Endaxis 1.0.3
```

> **为什么不用 `electron-builder --publish always`**：它会并发上传资产，实测
> **创建出两个同 tag 的 Draft Release**（一个拿到 exe/latest.yml，另一个拿到
> `.blockmap`），而 Draft 客户端看不见，还得人工合并。`publish-release.ps1`
> 改成逐个串行上传并校验，结果确定。
>
> 另一个坑：**同名资产会被 CDN 缓存**。重复发布同一版本时，无参请求可能仍拿到
> 上一份文件，于是校验脚本会误报"大小与清单不符"。所以校验脚本与发布脚本都
> 带缓存绕过参数；真正发新版时文件名本来就变了，不受影响。

### 更新提醒链路（已实测）

不只是"能上传"，整条链路都实测过：

```
✓ 线上 Release 匿名可见（客户端不带凭据也能读）
✓ 清单 sha512 与安装包实算值一致、size 一致（上传未损坏）
✓ 已装 1.0.3 的客户端启动后在线检查得出"已是最新"
   轨迹：update-not-available（线上最新 1.0.3，当前 1.0.3）
✓ 旧版本能收到更新提醒（检测到新版本 → 弹窗确认 → 下载 → 备份 → 安装）
```

那条 `线上最新 1.0.3` 的版本号**只能来自 GitHub 线上查询**，所以它是"检查真的
发出并拿到结果"的直接证据 —— 比"看起来没报错"可靠得多。排查这类问题时，
`%TEMP%\endaxis-update-trace.log` 是唯一能看到结论的地方：光有"检查开始"不能
说明检查成功，因此 `update-not-available` 也会记一行。

### 更新检查撞上限流怎么办（已内置回退）

`electron-updater` 走 `api.github.com`，**匿名请求只有 60 次/小时**。共享出口 IP
（公司/校园网/运营商 NAT）很容易打满，表现是"检查更新静默失败"——开发期我自己
就把额度打满过。

因此更新模块内置了回退：API 失败时改读 Releases 的 **Atom feed**
（`https://github.com/<owner>/<repo>/releases.atom`），该端点**没有限流**、同样
不需要凭据。代价是只有版本号、没有 sha512——但真正的下载与校验仍由
electron-updater 负责，安全性不受影响。此时弹窗会说明"只能确认有新版本，请稍后重试"。

验证这条回退路径：

```powershell
node --use-env-proxy tools/verify-feed-fallback.mjs xuan06zyx Endaxis
```

### 国内网络提示

更新检查走 GitHub，国内用户可能连不上或很慢。有两种解法：

- 自建更新源：设置环境变量 `ENDAXIS_UPDATE_URL=https://your-host/updates/`，
  程序会改用这个地址（走 generic 协议，目录里同样放 `latest.yml` + 安装包）；
- 或干脆不发更新，靠手动分发。

连不上时程序不会反复打扰用户，只在手动检查时提示失败。

### 验证自动更新

`npm run verify:update` 会做一次真实的端到端验证：起一个本地静态更新源，
让旧版本去检查、下载新版本、并验证安装前的数据备份。**不执行安装**
（安装会真的替换掉被测程序）。

```powershell
# 需要先准备两个版本：一个旧版目录 + 一个含 latest.yml 的更新源目录
node scripts/launch.mjs tools/verify-update.js --baseline <旧版目录> --feed <更新源目录> [--port 18377]
```

准备测试素材的套路：把 `package.json` 版本临时改成 `0.9.0`、`publish` 改成
`generic` 指向 `http://127.0.0.1:18377/`，打包得到"旧版"；再把版本改成 `1.1.0`
打包，把 `latest.yml` 和 `1.1.0` 安装包放进 `--feed` 目录。

实测通过时的输出：

```
[feed] 200 /latest.yml
[feed] 200 /Endaxis-Setup-1.1.0-x64.exe (116.5 MB)
[verify-update] 通过：检查更新 → 下载校验 → 安装前备份 全部走通。
[verify-update] 备份位置：...\data-backups\2026-10-12T14-26-22（324 个文件）
```

### 实现上的两个坑（改代码时别踩回去）

1. **`electron-updater` 必须在 `dependencies` 里，而且要被真正打进包。**
   electron-builder 默认只收集它自己解析出的生产依赖，本项目 `files` 里的
   `src/**` 会连带触发 `!**/node_modules/**` 默认排除——结果就是依赖静默缺失、
   真机上更新功能完全不工作（开发时却正常）。为此加了 `npm run prepare:runtime`：
   用 `npm install --omit=dev` 生成一棵干净的 `app-runtime/node_modules`，
   再通过 `files` 的 `{from,to}` 映射进 asar 根目录。
2. **备份要跳过被占用的文件。** 应用运行时 Chromium 一直占着
   `Network/Cookies` 等文件，`fs.cpSync` 遇到它们会直接抛 EACCES，
   让整个备份失败。现在逐个文件拷贝，锁住的跳过并记进日志——
   真正要保住的 IndexedDB / Local Storage 不受影响。

---

## 打包发布

```powershell
npm run dist
```

产物在 `release/`：

- `Endaxis-Setup-1.0.0-x64.exe` —— NSIS 安装包（约 116 MB）
  - 按用户安装到 `%LOCALAPPDATA%\Programs\Endaxis`，不需要管理员权限
  - 可自选安装目录，自动创建桌面与开始菜单快捷方式
  - 支持 `/S` 静默安装、`/D=<目录>` 指定安装位置
- `Endaxis-1.0.0-win-x64-portable.zip` —— 免安装压缩包（约 162 MB，解压后 386 MB）
- `win-unpacked/` —— 未压缩的运行目录，`Endaxis.exe` 可直接双击

打包时前端产物通过 `extraResources` 从 `webapp/` 复制进 `resources/webapp`，
所以安装包是自包含的，不依赖 `../Endaxis` 目录是否存在。

### 分发哪个（给最终用户）

**只发 `release/` 里的那一个文件，不要发 `desktop-shell/` 整个目录**
（那里面有 `node_modules` 和源码，几百 MB 且对用户毫无用处）。

| 场景                      | 发什么                               |
| ------------------------- | ------------------------------------ |
| 绝大多数用户（推荐）      | `Endaxis-Setup-1.0.0-x64.exe`        |
| 免安装 / 绿色版 / 放 U 盘 | `Endaxis-1.0.0-win-x64-portable.zip` |

免安装包解压后目录里直接双击 `Endaxis.exe` 即可，不需要安装。
压缩包外层带 `Endaxis/` 目录名，解压不会散出一堆文件。

重新生成免安装包：

```powershell
Compress-Archive -Path "release\win-unpacked" -DestinationPath "release\Endaxis-1.0.0-win-x64-portable.zip"
```

（`win-unpacked` 内没有硬链接，普通 zip 即可，实测解压到新位置能正常运行。）

### 分发前必须知道的两件事

1. **没有代码签名，首次运行会弹 SmartScreen 警告。**
   用户看到的是「Windows 已保护你的电脑」→ 需要点「更多信息」→「仍要运行」。
   安装包本身仍能正常安装，这只是未签名程序的默认提示。
   要消除它只能买一张代码签名证书，然后配置 electron-builder 的
   `win.certificateFile` / `certificatePassword`。

2. **安装包会记录安装目录。** NSIS 会记住上次装到哪儿，所以
   「卸载后重装」或「换目录重装」时要显式指定：

   ```powershell
   & .\Endaxis-Setup-1.0.0-x64.exe /S /D=D:\Apps\Endaxis
   ```

   不指定又残留了旧注册表项时，可能装完在默认位置找不到程序。

> **关于免安装单文件版**：electron-builder 26 的 `portable` 目标在这里产出的
> exe 无法启动（双击后立刻退出，连自解压目录都不创建，退出码 0）。
> 与其发布一个坏掉的产物，这里只保留安装包；确实需要免安装用法时，
> 直接压缩 `release/win-unpacked/` 分发即可。

---

## 目录结构

```
desktop-shell/
├── src/main/
│   ├── index.js        # 主进程入口：窗口、会话策略、生命周期
│   ├── config.js       # 应用标识、UA 策略、图标路径
│   ├── server.js       # 本地静态服务器（SPA 回落）
│   ├── menu.js         # 应用菜单（跟随系统语言，中/英）
│   ├── strings.js      # 菜单文案
│   └── windowState.js  # 窗口尺寸/位置持久化
├── scripts/
│   ├── launch.mjs       # 启动 Electron（清掉 ELECTRON_RUN_AS_NODE）
│   ├── dev.mjs          # 开发模式编排（Vite + Electron）
│   ├── prepare-dist.mjs # 同步前端产物到 webapp/
│   └── generate-icon.mjs# 从 logo 生成 ico/png
├── tools/
│   ├── verify-app.js    # 渲染断言 + 截图（源码入口）
│   ├── verify-window.js # 真实启动探针（源码入口）
│   ├── verify-exe.js    # 验证任意 exe（打包版 / 安装版）
│   └── diagnose-boot.js # 启动诊断
├── build/               # 生成的图标
├── webapp/              # 同步过来的前端产物（打包进安装包）
└── release/             # 打包输出
```

---

## 排障

**窗口一闪而过 / 报 `Cannot read properties of undefined (reading 'whenReady')`**
环境里有 `ELECTRON_RUN_AS_NODE=1`，Electron 退化成了普通 Node。
本仓库的 `npm start` 已自动清理该变量；如果你直接调 `electron.exe`，请先删掉它。

**启动时弹「端口被占用」**
程序固定在 `127.0.0.1:17321` 提供界面，端口被占用时会先自动重试约 12 秒
（通常是上一个实例还在退出），仍然占用才报错。**这是刻意不自动换端口**：
换端口会让程序读不到你已有的排轴数据。处理办法：

```powershell
# 谁占用了这个端口
netstat -ano | findstr :17321
# 该端口是否被系统保留
netsh int ipv4 show excludedportrange protocol=tcp
# 排查记录
Get-Content "$env:TEMP\endaxis-server-port.log"
```

最常见的原因是上一个 Endaxis 没退干净（任务管理器结束 `Endaxis.exe` 即可）。

**页面停在「正在加载…」**
启动遮罩由前端在「语言资源 + 首个路由挂载完成」后移除。先跑 `npm run diagnose`，
它会列出所有失败请求与控制台报错；最常见的原因是没跑 `npm run prepare:dist`
（`webapp/` 是旧产物或为空）。

**改了内容，关掉再打开又变回原来的样子（项目没保留）**
多半是 origin 变了导致读不到旧存档。检查两件事：

1. 两次启动的地址端口是否一致（应为 `127.0.0.1:17321`）。
   若每次都不同，说明服务器的固定端口逻辑被改坏了；
2. `%APPDATA%\endaxis-desktop\IndexedDB\` 下是否堆了很多
   `http_127.0.0.1_<不同端口>` 目录。历史版本会留下这种孤儿库，
   新版本首次启动会自动清掉（见上文「启动时的一次性清理」）；
   若你确认还有残留，可以手动删（**别删 `http_127.0.0.1_17321`**）：

   ```powershell
   Get-ChildItem "$env:APPDATA\endaxis-desktop\IndexedDB" -Directory |
     Where-Object { $_.Name -ne 'http_127.0.0.1_17321.indexeddb.leveldb' } |
     Remove-Item -Recurse -Force
   ```

   注意：**孤儿库里的旧数据找不回来**（没有可靠索引定位是哪一次会话）。
   清理只回收空间。

固定端口被占用时会退到随机端口并记一笔日志：

```powershell
Get-Content "$env:TEMP\endaxis-server-port.log"
```

占用的原因通常是上一个进程没退干净，或端口落在 Windows 保留区间内
（用 `netsh int ipv4 show excludedportrange protocol=tcp` 查看）。

**「改完立刻关程序」的那一下改动没保存**
跑 `npm run verify:closeflush`。它会真的起一个进程改数据、立刻关窗，
再起第二个进程检查——这是唯一能覆盖"渲染进程先于 IndexedDB 提交被销毁"的测试。

**App 起不来，想知道卡在哪**
带探针开关运行，它会把自己的启动过程写到 `%TEMP%\endaxis-startup-errors.log`：

```powershell
& "$env:LOCALAPPDATA\Programs\Endaxis\Endaxis.exe" --endaxis-startup-probe
Get-Content "$env:TEMP\endaxis-startup-errors.log"
Get-Content "$env:APPDATA\endaxis-desktop\startup-probe.json"
```

**`npm run build:web` 报找不到模块**
先去 `../Endaxis` 执行 `npm install`。

**打包时下载 Electron/NSIS 卡住**
设置镜像后重试：

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'
```

**重新安装时“装完找不到程序”**
NSIS 会记住上次的安装目录。用 `/D=<目录>` 明确指定，或先跑一次卸载程序：

```powershell
& "$env:LOCALAPPDATA\Programs\Endaxis\Uninstall Endaxis.exe" /S
```

---

## 声明

Endaxis 是粉丝自制工具，与游戏官方无关。
本目录只提供桌面壳，网页部分的一切版权归上游项目所有。
