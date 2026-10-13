# Endaxis 桌面版（Electron 套壳）

本目录是 [Endaxis](../README.md) 的 **Windows 桌面壳**：把上游的 Web 前端用
Electron 包成本地应用，并补上本地存档、关窗落盘、自动更新等桌面能力。

前端代码来自上游（`refactor/v3` 分支），**基本原样保留**，因此可以持续跟随上游更新。
只有一处必要改动（见下文「对上游的唯一改动」）。

---

## 为什么是"套壳 + 本地服务"而不是直接加载 `file://`

前端的资源路径是 `/assets/...` 绝对路径，路由用 history 模式，`file://` 下都不成立，
所以壳里跑了一个只监听 `127.0.0.1` 的静态服务，再把窗口指过去。

### 端口必须固定，且绝不自动换端口

服务固定在 **`127.0.0.1:17321`**。这不是随便挑的：**项目存档（IndexedDB）按 origin
隔离，而 origin 包含端口**。端口一变就是另一个 origin，旧存档读不到，
用户看到的是"关掉再打开又变回初始状态"。

早期版本用了随机端口，在真实机器上留下过 **70 多个读不到的孤儿库**。
所以现在的行为是：

- 端口被占用时**先重试约 12 秒**（通常是上一个实例正在退出），成功则用户无感；
- 仍然占用就**报错退出**并给出排查命令 —— 而不是"为了能用"换个端口继续跑。
  换个端口确实能起来，但用户会看到一个读不到自己排轴数据的空应用，那比报错更糟。

> 曾尝试把 Chromium 的存储根 `app.setPath('sessionData', …)` 固定到与端口无关的
> 目录，希望换端口后仍能读到存档。**实测无效**：Chromium 在存储根内部仍然按
> origin 分目录。既然没办法让两个端口共享同一个 IndexedDB，唯一正确的做法就是不换端口。

不变量由 `npm run verify:port-conflict` 守住。

---

## 数据存在哪

| 内容             | 位置                                                                         |
| ---------------- | ---------------------------------------------------------------------------- |
| 项目存档         | `%APPDATA%\endaxis-desktop\IndexedDB\http_127.0.0.1_17321.indexeddb.leveldb` |
| 更新前备份       | `%APPDATA%\endaxis-desktop\data-backups\<时间戳>\`                           |
| 更新源选择等偏好 | `%APPDATA%\endaxis-desktop\desktop-preferences.json`                         |
| 更新链路日志     | `%TEMP%\endaxis-update-trace.log`                                            |
| 端口占用日志     | `%TEMP%\endaxis-server-port.log`                                             |

启动时会做一次性清理：删除**随机端口时代**留下的孤儿库，当前端口与固定端口的库一律保留。

---

## 对上游的唯一改动

`src/ui/timeline/projectFileSession.ts`（及 `TimelineEditor.vue` 的一处桥接）：

1. **自动保存改为防抖合并写入**（1.2 秒窗口，最长等待 15 秒）。上游是每次改动都写，
   桌面版长时间排轴时写入过于频繁；
2. **新增关窗落盘**：窗口关闭前主进程会先要求渲染进程把排队的保存写进磁盘，
   再真正关闭。否则用户改完立刻关程序，那次改动会随渲染进程一起消失。

浏览器版行为不变（`window.EndaxisDesktop` 不存在时走原路径）。

---

## 更新机制

- 更新源：本仓库的 GitHub Releases（`package.json` 的 `build.publish`）
- 启动后静默检查，结果只在**主窗口右下角**播报，不弹模态框、不挡操作
- 菜单「帮助 → 检查更新」打开独立窗口：可选镜像站、测速、再检查更新
- 下载前会由用户确认；**安装前自动备份项目数据**

### 镜像站（给无法直连 GitHub 的用户）

内置 GitHub 直连 + 三个公共反代。实测能力**并不一致**：

| 能力                        | ghfast.top | gh-proxy.com | ghproxy.net |
| --------------------------- | ---------- | ------------ | ----------- |
| `releases/download` 资产    | ✅         | ✅           | ✅          |
| `raw.githubusercontent.com` | ✅         | ✅           | 未测        |
| `api.github.com`（查版本）  | ❌ 403     | ✅           | 未测        |
| `releases.atom`             | ❌ 403     | ❌ 404       | ❌ 403      |

两个由此得出的设计约束：

1. **版本发现自己实现**，不依赖 electron-updater 内部的 `api.github.com`
   （那个还受匿名限流 60 次/小时），而是经"支持 API 的镜像"查询，失败再退到直连 atom feed；
2. **没有任何镜像支持 atom feed**，所以不能靠它兜底。

稳定性实测（供排查参考）：

- `gh-proxy.com`：54 ms 握手，最稳
- `ghproxy.net`：偶发 4 秒 TCP 超时，速度约 0.5 MB/s
- `ghfast.top`：**不稳定**，曾观察到两次 10 秒连接超时后第三次 6.5 秒才成功

正因为镜像可用性因网络而异，"测速让用户自己选"是**必需功能**而不是锦上添花。
镜像地址会变动，界面里给出 [ghproxy.link](https://ghproxy.link/)（官方"最新地址发布页"）
让用户自己查。

---

## 发布新版本

推一个 `desktop-v*` tag 即可，GitHub Actions 会自动构建并发布：

```bash
git tag desktop-v1.0.9 && git push origin desktop-v1.0.9
```

工作流（[`.github/workflows/desktop-release.yml`](../.github/workflows/desktop-release.yml)）会：
装依赖 → 构建前端 → 构建安装包 → **串行上传资产** → 转 Published → 匿名可用性验收。

本地发布：

```powershell
cd desktop-shell
npm version patch --no-git-tag-version
npm run package:win
pwsh -File scripts/publish-release.ps1 -Version 1.0.9
```

> **为什么不用 `electron-builder --publish always`**：它并发上传资产，实测会创建出
> **两个同 tag 的 Draft Release**（一个拿到 exe/latest.yml，另一个拿到 `.blockmap`），
> 而 Draft 客户端看不见，还得人工合并。`publish-release.ps1` 改成逐个串行上传并校验。

> **同名资产会被 CDN 缓存**：重复发布同一版本时，无参请求可能拿到上一份文件，
> 导致校验脚本误报"大小与清单不符"。所以校验与发布脚本都带缓存绕过参数。

Release 里三个文件的作用见 [RELEASE-ASSETS.md](docs/RELEASE-ASSETS.md)。

---

## 验证工具

这些不是"跑一遍看看"，每一件都对应一个踩过的坑：

| 命令                               | 覆盖                                      |
| ---------------------------------- | ----------------------------------------- |
| `npm run check`                    | 全部 JS 语法                              |
| `npm run verify`                   | 前端能渲染                                |
| `npm run verify:window`            | 窗口状态                                  |
| `npm run verify:autosave`          | 自动恢复 + 防抖合并（独立 userData）      |
| `npm run verify:closeflush`        | 关窗瞬间的改动不丢（真的关掉再重开进程）  |
| `npm run verify:storage-migration` | 孤儿库清理的删/留边界                     |
| `npm run verify:port-conflict`     | 端口占用时不换端口，明确报错              |
| `verify-injection.js`              | 打包版里 `executeJavaScript` 可用         |
| `verify-update-overlay.js`         | 浮层各状态渲染                            |
| `verify-overlay-bridge.js`         | preload → 浮层 的真实数据链路             |
| `verify-mirrors.js`                | 镜像能力声明 vs 实际                      |
| `verify-mirrors-noproxy.js`        | 按"无代理用户"场景测镜像                  |
| `verify-source-window.js`          | 检查更新窗口的渲染与 IPC（18 项断言）     |
| `verify-release.mjs`               | 线上 Release 匿名可用性（含 sha512 核对） |

---

## 沙箱约束（改 preload 前必读）

`src/preload.js` 运行在 `sandbox: true` 的预加载环境，**只能 `require('electron')`**：

- `require('node:fs')` → `module not found: node:fs`
- `require('./main/closeCoordinator')` → `module not found: ...`

两种写法都会让 preload **整个静默失效**，只在主进程的 `preload-error` 事件里留一行线索，
表现出来就是"关窗依然丢数据"，极难定位。所以频道名在这里写字面量，
两侧一致性由 `verify-close-flush.js` 端到端守住。

另外：主窗口的 preload **刻意不暴露任何可调用方法**。页面是上游前端，
暴露方法等于给它提权。更新进度采用"单向数据推入"——preload 只往共享 DOM 写
`data-*` 属性并派发事件，浮层在主世界读取渲染。
