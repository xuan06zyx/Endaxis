'use strict';

/**
 * 启动诊断：把首屏启动过程完整记录下来。
 *
 * 与 verify-app.js 的区别：这里重点回答“为什么没起来”，而不是“起没起来”。
 * 会记录每个请求的状态码、控制台输出、页面异常，并等待启动遮罩真正消失。
 *
 * 用法： npm run diagnose
 */

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, session } = require('electron');

const { buildUserAgent } = require('../src/main/config');
const { startStaticServer } = require('../src/main/server');

/** 打包后站点在 resources/webapp；开发时在仓库的 webapp/。 */
const DIST_DIRECTORY = app.isPackaged
  ? path.join(process.resourcesPath, 'webapp')
  : path.resolve(__dirname, '..', 'webapp');
const REPORT_PATH = app.isPackaged
  ? path.join(app.getPath('userData'), 'diagnose-boot.txt')
  : path.resolve(__dirname, '..', 'verification', 'diagnose.txt');
const LOADER_TIMEOUT_MS = 120_000;

const lines = [];
const log = message => {
  lines.push(message);
  console.log(message);
};

/** 收集启动过程中的失败请求与慢请求。 */
function watchNetwork(targetSession) {
  const requests = new Map();
  const failures = [];

  targetSession.webRequest.onBeforeRequest((details, callback) => {
    requests.set(details.id, { url: details.url, startedAt: Date.now() });
    callback({});
  });

  targetSession.webRequest.onCompleted(details => {
    const record = requests.get(details.id);
    requests.delete(details.id);
    if (details.statusCode >= 400) {
      failures.push(`HTTP ${details.statusCode} ${details.url}`);
    }
  });

  targetSession.webRequest.onErrorOccurred(details => {
    requests.delete(details.id);
    failures.push(`NET ${details.error} ${details.url}`);
  });

  return failures;
}

/** 渲染进程快照：应用根、遮罩、可见文本、已加载的样式表。 */
function snapshotExpression() {
  return `(() => {
    const root = document.querySelector('#app');
    const loader = document.querySelector('#boot-loader');
    const children = root === null ? [] : Array.from(root.children);
    return {
      bootLoaderPresent: loader !== null,
      bootLoaderText: loader === null ? null : (loader.innerText || '').trim(),
      appChildCount: children.length,
      appChildTags: children.map(node => node.tagName.toLowerCase()).slice(0, 20),
      appChildClasses: children.map(node => String(node.className || '')).slice(0, 20),
      bodyTextLength: (document.body?.innerText ?? '').trim().length,
      bodyTextHead: (document.body?.innerText ?? '').trim().slice(0, 400),
      styleSheetCount: document.styleSheets.length,
      scriptCount: document.scripts.length,
      readyState: document.readyState,
      href: location.href,
    };
  })()`;
}

app.whenReady().then(async () => {
  session.defaultSession.setUserAgent(buildUserAgent());
  const failures = watchNetwork(session.defaultSession);

  const server = await startStaticServer(DIST_DIRECTORY);
  log(`站点根目录：${DIST_DIRECTORY}`);
  log(`本地站点：${server.origin}`);

  const window = new BrowserWindow({
    width: 1600,
    height: 950,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  window.webContents.on('console-message', event => {
    const level = typeof event === 'object' && event !== null ? event.level : undefined;
    const message = typeof event === 'object' && event !== null ? event.message : String(event);
    const line = typeof event === 'object' && event !== null ? event.lineNumber : undefined;
    log(`[console:${level}] ${message}${line === undefined ? '' : ` (line ${line})`}`);
  });
  window.webContents.on('preload-error', (_event, preloadPath, error) => {
    log(`[preload-error] ${preloadPath}: ${error.message}`);
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    log(`[render-process-gone] ${JSON.stringify(details)}`);
  });
  window.webContents.on('did-fail-load', (_event, code, description, url) => {
    log(`[did-fail-load] ${description} (${code}) ${url}`);
  });

  await window.loadURL(server.origin);
  log('[nav] did-finish-load');

  const deadline = Date.now() + LOADER_TIMEOUT_MS;
  let finalSnapshot = null;
  while (Date.now() < deadline) {
    finalSnapshot = await window.webContents.executeJavaScript(snapshotExpression(), true);
    if (!finalSnapshot.bootLoaderPresent) {
      log(
        `启动遮罩已消失（用时约 ${Math.round((LOADER_TIMEOUT_MS - (deadline - Date.now())) / 1000)}s）`,
      );
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  log('');
  log('=== 最终页面状态 ===');
  log(JSON.stringify(finalSnapshot, null, 2));

  if (failures.length > 0) {
    log('');
    log(`=== 失败请求（${failures.length}）===`);
    for (const failure of failures.slice(0, 60)) log(failure);
  } else {
    log('');
    log('=== 没有失败请求 ===');
  }

  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, lines.join('\n'), 'utf8');

  window.destroy();
  await server.close();
  app.exit(finalSnapshot?.bootLoaderPresent === false ? 0 : 1);
});
