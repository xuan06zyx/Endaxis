'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, Menu, dialog, session, shell } = require('electron');

const {
  APP_ID,
  APP_NAME,
  DENIED_PERMISSIONS,
  buildUserAgent,
  resolveAppIcon,
} = require('./config');
const { attachCloseFlush } = require('./closeCoordinator');
const { cleanupOrphanedStorage } = require('./storageMigration');
const { buildApplicationMenu } = require('./menu');
const { openSourceWindow, disposeSourceWindow } = require('./sourceWindow');
const { startStaticServer, resolveFixedPort, PortUnavailableError } = require('./server');
const { createUpdater } = require('./updater');
const {
  DEFAULT_BOUNDS,
  MINIMUM_SIZE,
  captureWindowState,
  createWindowStateWriter,
  readWindowState,
} = require('./windowState');

/** 开发模式指向 Vite 开发服务器；缺省则是打包好的静态站点。 */
const DEVELOPMENT_URL = process.env.ENDAXIS_DEV_URL?.trim() || '';
const IS_DEVELOPMENT = DEVELOPMENT_URL.length > 0;

/** 只在“帮助”菜单里作为外部链接出现，不在应用内浏览。 */
const WEBSITE_URL = 'https://www.end-axis.com/';

/**
 * 启动探针：`npm run verify:window` 用真实入口启动应用后检查启动结果。
 *
 * 打包后的 Windows GUI 程序没有控制台，stdout 拿不到内容，因此报告同时写到
 * `userData/startup-probe.json`；开发时 stdout 也照样打印一份，方便直接看。
 * 日常运行（不带该开关）完全不受影响。
 *
 * 环境变量和命令行参数都认：从另一个 Electron 进程里 spawn 时，环境变量
 * 不一定传得进来（实测过），命令行参数则总是可靠。
 */
const PROBE_FLAG = '--endaxis-startup-probe';
const STARTUP_PROBE =
  process.env.ENDAXIS_STARTUP_PROBE === '1' || process.argv.includes(PROBE_FLAG);
const PROBE_PREFIX = 'ENDAXIS_PROBE ';
const PROBE_REPORT_NAME = 'startup-probe.json';
/** 探针最多等这么久让应用完成首屏（开发模式要现场编译，给得宽一些）。 */
const PROBE_READY_TIMEOUT_MS = 60_000;

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {{ origin: string, close: () => Promise<void> } | null} */
let staticServer = null;
/** @type {ReturnType<typeof createWindowStateWriter> | null} */
let windowStateWriter = null;
/** @type {ReturnType<typeof createUpdater> | null} */
let updater = null;

/**
 * 用环境变量重定向数据目录。
 *
 * 用途：自动化测试需要一份和用户真实数据完全隔离的 userData。验证自动更新时
 * 尤其重要——更新会真的把程序换掉，不能拿用户的真实安装和项目数据做实验。
 *
 * 必须放在 `requestSingleInstanceLock()` **之前**：那个锁是按 userData 目录
 * 建立的，路径改了锁也要跟着换。
 *
 * 不能用 `--user-data-dir`：那是 Chromium 的开关，Electron 会直接以
 * `bad option` 拒绝启动（退出码 9，实测过）。
 */
const USER_DATA_OVERRIDE = process.env.ENDAXIS_USER_DATA_DIR?.trim();
if (USER_DATA_OVERRIDE) {
  try {
    fs.mkdirSync(USER_DATA_OVERRIDE, { recursive: true });
    app.setPath('userData', path.resolve(USER_DATA_OVERRIDE));
  } catch {
    // 设置失败就退回默认目录，不影响正常使用。
  }
}

// 同一份数据目录只能由一个实例写入（IndexedDB / localStorage 都按源隔离）。
const hasSingleInstanceLock = app.requestSingleInstanceLock();

/**
 * 启动期错误落盘。
 *
 * GUI 程序没有控制台，未捕获异常只会表现为"窗口没出现"。这里把异常写到
 * 临时目录（一定可写），保证问题可查；同时也把单实例锁的结果记下来。
 */
function writeStartupDiagnostic(label, detail) {
  // 日常运行不落盘，避免在用户机器上留下无关文件。
  if (!STARTUP_PROBE) return;
  try {
    fs.appendFileSync(
      path.join(require('node:os').tmpdir(), 'endaxis-startup-errors.log'),
      `[${new Date().toISOString()}] ${label}: ${detail}\n`,
      'utf8',
    );
  } catch {
    // 记录失败不能影响启动。
  }
  // 打包后的 GUI 程序没有控制台，写 stdout/stderr 可能失败，绝不能让日志本身
  // 把启动流程带崩——这里的异常必须被吞掉。
  try {
    console.error(`[endaxis] ${label}: ${detail}`);
  } catch {
    // 忽略：日志不是启动的必要条件。
  }
}

process.on('uncaughtException', error => {
  writeStartupDiagnostic('uncaughtException', error?.stack ?? String(error));
});
process.on('unhandledRejection', reason => {
  writeStartupDiagnostic('unhandledRejection', reason?.stack ?? String(reason));
});

writeStartupDiagnostic(
  'lock',
  `acquired=${hasSingleInstanceLock} packaged=${app.isPackaged} ` +
    `userData=${(() => {
      try {
        return app.getPath('userData');
      } catch {
        return 'unavailable';
      }
    })()}`,
);

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  bootstrap();
}

function bootstrap() {
  app.setName(APP_NAME);
  app.setAppUserModelId(APP_ID);

  app.on('second-instance', () => {
    if (mainWindow === null) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.on('window-all-closed', () => {
    // Windows/Linux 的习惯是关窗即退出；macOS 保留在 Dock。
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void openMainWindow();
  });

  app.on('before-quit', () => {
    if (mainWindow !== null && !mainWindow.isDestroyed()) {
      windowStateWriter?.save(captureWindowState(mainWindow));
    }
    windowStateWriter?.flushNow();
    void shutdownStaticServer();
  });

  app.whenReady().then(
    async () => {
      configureSessionDefaults();
      if (!IS_DEVELOPMENT) {
        const distDirectory = resolveDistDirectory();
        try {
          staticServer = await startStaticServer(distDirectory);
        } catch (error) {
          if (error instanceof PortUnavailableError) {
            reportPortUnavailableError(error.port);
            return;
          }
          reportFatalStartupError(
            `无法启动本地服务。\n\n目录：${distDirectory}\n\n${describeError(error)}`,
          );
          return;
        }
        runStorageMigration(staticServer.port);
      }
      try {
        await openMainWindow();
      } catch (error) {
        writeStartupDiagnostic('openMainWindow', error?.stack ?? String(error));
        throw error;
      }
    },
    error => {
      writeStartupDiagnostic('whenReady', error?.stack ?? String(error));
      reportFatalStartupError(describeError(error));
    },
  );
}

/**
 * 固定端口被长期占用时的提示。
 *
 * 这里**故意不换端口继续启动**：项目存档按 origin（含端口）隔离，换个端口就是
 * 另一个库，用户会看到一个读不到自己项目的空应用——那比"起不来"更糟。
 * 所以明确报错，并把排查动作写清楚。
 */
function reportPortUnavailableError(port = resolveFixedPort()) {
  const detail =
    `${APP_NAME} 需要在本机 ${port} 端口提供界面，但这个端口已被占用。\n\n` +
    `为什么不能自动换端口：项目存档按「协议+主机+端口」隔离，换端口后\n` +
    `你的排轴数据不会丢，但本程序读不到（看起来像被清空了）。\n\n` +
    `请先处理占用：\n` +
    `  1. 确认没有另一个 Endaxis 正在运行（包括托盘/后台残留），关掉它；\n` +
    `  2. 查看是谁占用：netstat -ano | findstr :${port}\n` +
    `  3. 若该端口被系统保留：netsh int ipv4 show excludedportrange protocol=tcp\n\n` +
    `排查记录：%TEMP%\\endaxis-server-port.log`;
  writeStartupDiagnostic('port-unavailable', `port ${port} occupied`);
  dialog.showErrorBox(`${APP_NAME} 启动失败：端口被占用`, detail);
  app.exit(1);
}

/**
 * 一次性清理历史遗留的孤儿存档库。
 *
 * 早期版本用随机端口，导致每次启动都新建一个 origin 目录，用户的项目存档因此
 * 永远读不回来。这里把那些孤儿目录清掉（**当前端口的库绝不删**，详见
 * storageMigration.js 的安全约束）。失败不影响启动。
 */
function runStorageMigration(currentPort) {
  if (process.env.ENDAXIS_SKIP_STORAGE_MIGRATION === '1') return;
  try {
    const result = cleanupOrphanedStorage({
      userDataDirectory: app.getPath('userData'),
      currentPort,
      force: process.env.ENDAXIS_FORCE_STORAGE_MIGRATION === '1',
    });
    if (result.status === 'completed' && (result.removed?.length ?? 0) > 0) {
      console.log(
        `[storage-migration] 已清理 ${result.removed.length} 个历史孤儿存档库` +
          `（约 ${Math.round((result.freedBytes ?? 0) / 1024)} KB），保留 ${result.kept} 个`,
      );
    }
    writeStartupDiagnostic(
      'storage-migration',
      `${result.status}${result.reason === undefined ? '' : ` (${result.reason})`}` +
        `${result.removed === undefined ? '' : ` removed=${result.removed.length}`}`,
    );
  } catch (error) {
    // 清理是"锦上添花"：失败绝不能让应用起不来。
    writeStartupDiagnostic('storage-migration', `失败：${describeError(error)}`);
  }
}

/** 打包后站点位于 resources/webapp；开发时直接读同级仓库的 dist。 */
function resolveDistDirectory() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'webapp');
  }
  const override = process.env.ENDAXIS_DIST_DIR?.trim();
  if (override) return path.resolve(override);
  return path.resolve(__dirname, '..', '..', '..', 'Endaxis', 'dist');
}

function reportFatalStartupError(detail) {
  dialog.showErrorBox(
    `${APP_NAME} 启动失败`,
    `${detail}\n\n请先在 desktop-shell 目录执行：\n  npm run setup`,
  );
  app.exit(1);
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 会话级默认值：统一 UA、拒绝无关权限、把下载交给系统“另存为”。
 * 每次启动只配置一次，作用于 default session（默认 partition）。
 */
function configureSessionDefaults() {
  const defaultSession = session.defaultSession;

  defaultSession.setUserAgent(buildUserAgent());

  defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    // 时间轴在窄屏下可能请求全屏；剪贴板用于复制排轴结果。
    const allowed = permission === 'fullscreen' || permission === 'clipboard-sanitized-write';
    callback(allowed && !DENIED_PERMISSIONS.has(permission));
  });

  defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    return !DENIED_PERMISSIONS.has(permission);
  });

  // 导出项目文件时走真正的“保存到…”对话框，而不是默默写进下载目录。
  defaultSession.on('will-download', (_event, item) => {
    const suggested = item.getFilename() || 'endaxis-export';
    const filters = buildDownloadFilters(suggested);
    const chosen = dialog.showSaveDialogSync(mainWindow ?? undefined, {
      title: '保存文件',
      defaultPath: path.join(app.getPath('downloads'), suggested),
      filters,
    });
    if (chosen) item.setSavePath(chosen);
  });
}

function buildDownloadFilters(filename) {
  const extension = path.extname(filename).replace('.', '').toLowerCase();
  const known = {
    json: { name: 'JSON 项目文件', extensions: ['json'] },
    png: { name: 'PNG 图片', extensions: ['png'] },
    webp: { name: 'WebP 图片', extensions: ['webp'] },
    csv: { name: 'CSV 表格', extensions: ['csv'] },
  };
  return [known[extension] ?? { name: '所有文件', extensions: ['*'] }];
}

async function openMainWindow() {
  const userDataDirectory = app.getPath('userData');
  windowStateWriter = createWindowStateWriter(userDataDirectory);
  const state = readWindowState(userDataDirectory);

  const icon = resolveAppIcon();
  const window = new BrowserWindow({
    ...DEFAULT_BOUNDS,
    ...state.bounds,
    minWidth: MINIMUM_SIZE.width,
    minHeight: MINIMUM_SIZE.height,
    // 窗口标题以页面 title 为准；这里只提供页面加载前的占位标题。
    title: `${APP_NAME} — 《明日方舟：终末地》排轴工具`,
    show: false,
    autoHideMenuBar: false,
    backgroundColor: '#1e1f22',
    ...(fs.existsSync(icon) ? { icon } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      // 只为"关窗前把自动保存写落地"而存在：见 closeCoordinator 与 src/preload.js。
      preload: path.join(__dirname, '..', 'preload.js'),
      // 时间轴需要持续渲染动画；后台节流会破坏恢复后的首帧。
      backgroundThrottling: false,
    },
  });

  mainWindow = window;

  if (state.maximized) window.maximize();

  // 窗口生命周期、外发链接拦截与右键菜单都在这里接线。
  wireWindowLifecycle(window);
  wireContextMenu(window);
  attachUpdateOverlay(window);

  try {
    updater = createUpdater({ window, isDevelopment: IS_DEVELOPMENT });
  } catch (error) {
    // 更新模块初始化失败不能拖垮整个应用：用户至少要能正常用本地版。
    writeStartupDiagnostic('createUpdater 失败', error?.stack ?? String(error));
    updater = null;
  }

  Menu.setApplicationMenu(
    buildApplicationMenu({
      window,
      isDevelopment: IS_DEVELOPMENT,
      websiteUrl: WEBSITE_URL,
      // 打开"检查更新"窗口，而不是直接开始检查：用户可能要先切镜像站。
      // 无法直连 GitHub 的用户如果一进来就自动检查，只会白等一次超时。
      onCheckForUpdates: () => {
        if (updater === null) return;
        try {
          openSourceWindow({ updater, parent: window });
        } catch (error) {
          writeStartupDiagnostic('打开检查更新窗口失败', error?.stack ?? String(error));
        }
      },
    }),
  );

  window.once('ready-to-show', () => {
    window.show();
    if (IS_DEVELOPMENT) window.webContents.openDevTools({ mode: 'detach' });
    if (STARTUP_PROBE) void reportStartupProbe(window);
    // 启动后稍等再静默检查，避免和首屏加载抢资源。
    setTimeout(() => {
      if (updater === null) {
        writeStartupDiagnostic('更新检查', 'updater 未初始化，跳过检查');
        return;
      }
      updater.checkForUpdatesSilently();
    }, 8000).unref?.();
  });

  // 载入失败时不要留下一个空白窗口。
  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    if (errorCode === -3) return; // ERR_ABORTED：路由切换或主动 stop，不算失败。
    const message = IS_DEVELOPMENT
      ? `无法连接开发服务器：${DEVELOPMENT_URL}\n\n请先运行 npm run dev。\n\n${errorDescription} (${errorCode})\n${validatedURL}`
      : `页面加载失败。\n\n${errorDescription} (${errorCode})\n${validatedURL}`;
    dialog.showErrorBox(`${APP_NAME} 加载失败`, message);
  });

  const targetUrl = IS_DEVELOPMENT ? DEVELOPMENT_URL : staticServer.origin;
  try {
    await window.loadURL(targetUrl);
  } catch (error) {
    if (!IS_DEVELOPMENT) reportFatalStartupError(describeError(error));
  }

  return window;
}

/**
 * 把更新进度浮层注入页面。
 *
 * 为什么由主进程注入，而不是让前端自己写：上游前端是"原样保留"的，改动它会让
 * 以后同步上游时反复冲突。浮层属于桌面壳的能力，就放在壳这一层。
 *
 * 为什么用 executeJavaScript 而不是 preload 注入：
 *   contextIsolation 下 preload 在隔离世界，往页面派发的 CustomEvent 主世界收不到，
 *   浮层就没法自己监听更新状态。所以 preload 只负责"往共享 DOM 写数据"，
 *   浮层在主世界读取并渲染。
 *
 * 注入必须等页面加载完（document.body 存在）。失败只记诊断，不影响应用使用：
 * 更新提示退化成原来的弹窗，功能不缺失。
 */
function attachUpdateOverlay(window) {
  const overlayScript = path.join(__dirname, '..', 'renderer', 'update-overlay.js');

  window.webContents.on('did-finish-load', () => {
    if (!fs.existsSync(overlayScript)) {
      writeStartupDiagnostic('更新浮层脚本缺失', overlayScript);
      return;
    }
    let source = '';
    try {
      source = fs.readFileSync(overlayScript, 'utf8');
    } catch (error) {
      writeStartupDiagnostic('读取更新浮层脚本失败', error?.stack ?? String(error));
      return;
    }
    // 包一层 IIFE 并吞掉异常：浮层出问题绝不能影响页面本身。
    window.webContents
      .executeJavaScript(`(() => { try { ${source} } catch (e) {} })();`, true)
      .catch(error => {
        writeStartupDiagnostic('注入更新浮层失败', error?.stack ?? String(error));
      });
  });
}

function wireWindowLifecycle(window) {
  const persist = () => {
    if (window.isDestroyed()) return;
    windowStateWriter?.save(captureWindowState(window));
  };

  for (const event of [
    'resize',
    'move',
    'maximize',
    'unmaximize',
    'enter-full-screen',
    'leave-full-screen',
  ]) {
    window.on(event, persist);
  }

  // 关窗前必须等自动保存落地（合并写入的改动可能还在渲染进程里排队，
  // 渲染进程会先于 IndexedDB 事务提交被销毁——实测会丢数据）。
  attachCloseFlush(window, {
    onTimeout: () => writeStartupDiagnostic('close', '等待保存超时，仍然关闭窗口'),
  });

  window.on('close', () => {
    persist();
    windowStateWriter?.flushNow();
  });

  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });

  // 外部链接一律交给系统浏览器，绝不在壳内导航出去。
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternallyOpenable(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  window.webContents.on('will-navigate', (event, url) => {
    if (isSameDocument(url)) return;
    event.preventDefault();
    if (isExternallyOpenable(url)) void shell.openExternal(url);
  });
}

/** 允许从网页打开的协议：只放行 http/https，挡掉 custom scheme 与文件路径。 */
function isExternallyOpenable(url) {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * 同一文档内的锚点跳转不能触发“用浏览器打开”。
 * History 路由的 pushState 不会触发 will-navigate，因此无需额外放行。
 */
function isSameDocument(url) {
  const currentOrigin = IS_DEVELOPMENT ? safeOrigin(DEVELOPMENT_URL) : (staticServer?.origin ?? '');
  return safeOrigin(url) === currentOrigin;
}

function safeOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/**
 * 输出启动结果，然后退出。
 *
 * 只用主进程可用的 API（窗口可见性、窗口标题、URL）。**不要改用
 * executeJavaScript 取渲染进程状态**：打包版里那个调用会挂住不返回，
 * 探针将永远得不出结论（开发版却正常），排查代价很高。渲染结果是否正确
 * 由 verify-app.js 的断言和截图负责。
 *
 * 就绪判据：窗口标题已由页面替换（不再是占位标题）**且**已经离开根路径。
 * 后半条不能省：`/` 会重定向到 `/timeline`，标题在 index.html 解析完就设好了，
 * 只看标题会在重定向完成前就下结论，拿到 `/` 这种中间态地址。
 */
async function reportStartupProbe(window) {
  const deadline = Date.now() + PROBE_READY_TIMEOUT_MS;
  let title = window.getTitle();
  let url = window.webContents.getURL();

  while (Date.now() < deadline) {
    title = window.getTitle();
    url = window.webContents.getURL();
    const titleReady = title.length > 0 && !title.startsWith(`${APP_NAME} —`);
    const navigated = url.startsWith('http') && !url.endsWith('/');
    if (titleReady && navigated) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }

  const payload = {
    title,
    url,
    visible: window.isVisible(),
    destroyed: window.isDestroyed(),
    minimized: window.isMinimized(),
    bounds: window.getBounds(),
    packaged: app.isPackaged,
    version: app.getVersion(),
  };

  const serialized = JSON.stringify(payload);
  try {
    // 打包后的 GUI 程序没有控制台，写 stdout 可能失败，不能让它影响流程。
    console.log(PROBE_PREFIX + serialized);
  } catch {
    // 忽略：报告文件才是打包版的主要出口。
  }
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(path.join(app.getPath('userData'), PROBE_REPORT_NAME), serialized, 'utf8');
  } catch (error) {
    writeStartupDiagnostic('probe', `报告写盘失败：${describeError(error)}`);
  }

  // 给 stdout 一点时间刷出去，再退出。
  setTimeout(() => app.exit(0), 150);
}

/** 渲染进程的右键菜单：只放开只读操作，避免出现“检查元素”等开发入口。 */
function wireContextMenu(window) {
  window.webContents.on('context-menu', (_event, params) => {
    const items = [];
    if (params.selectionText.trim().length > 0) {
      items.push({ role: 'copy', label: '复制' });
      items.push({ role: 'selectAll', label: '全选' });
    }
    if (params.isEditable) {
      if (items.length > 0) items.push({ type: 'separator' });
      items.push({ role: 'cut', label: '剪切' });
      items.push({ role: 'copy', label: '复制' });
      items.push({ role: 'paste', label: '粘贴' });
    }
    if (items.length === 0) return;
    Menu.buildFromTemplate(items).popup({ window });
  });
}

/**
 * 只做兜底：正常退出路径已在 before-quit 里关闭服务器。
 * 仍保留这个入口，避免异常路径下端口悬挂。
 */
async function shutdownStaticServer() {
  if (staticServer === null) return;
  const server = staticServer;
  staticServer = null;
  try {
    await server.close();
  } catch {
    // 退出阶段无法恢复，忽略。
  }
}
