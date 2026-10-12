'use strict';

/**
 * 冒烟测试：按真实启动路径跑一遍壳，然后检查渲染结果。
 *
 * 只复用 src/main 的运行逻辑（静态服务器 + 与主进程一致的 webPreferences），
 * 因此这里失败就代表用户看到的 App 会失败。
 *
 * 用法： npm run verify
 *   退出码 0 = 通过，1 = 失败（失败原因写在 stdout）。
 */

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, session } = require('electron');

const { APP_NAME, buildUserAgent } = require('../src/main/config');
const { startStaticServer } = require('../src/main/server');

const DIST_DIRECTORY = path.resolve(__dirname, '..', 'webapp');
const RENDER_TIMEOUT_MS = 30_000;
const SNAPSHOT_PATH = path.join(__dirname, '..', 'verification', 'window.png');

/** 渲染进程里执行的检查；必须是自包含函数，不能引用外部变量。 */
function collectPageReport() {
  const root = document.querySelector('#app');
  const children = root === null ? [] : Array.from(root.children);
  const classes = children.map(node => String(node.className || ''));
  const joined = classes.join(' ');
  return {
    title: document.title,
    url: location.href,
    origin: location.origin,
    hasAppRoot: root !== null,
    appChildCount: children.length,
    appChildTags: children.map(node => node.tagName.toLowerCase()),
    appRootClasses: classes.flatMap(value => value.split(/\s+/).filter(Boolean)).slice(0, 20),
    hasDesktopWorkbench: /\bworkbench-layout\b/.test(joined),
    hasMobileWorkbench: /mobile/i.test(joined),
    bodyTextLength: (document.body?.innerText ?? '').trim().length,
    bodyTextHead: (document.body?.innerText ?? '').trim().slice(0, 160),
    bootLoaderPresent: document.querySelector('#boot-loader') !== null,
    userAgent: navigator.userAgent,
    nativeAppClass: document.documentElement.classList.contains('native-app'),
    viewport: { width: window.innerWidth, height: window.innerHeight },
    localStorageUsable: (() => {
      try {
        localStorage.setItem('endaxis:smoke', '1');
        localStorage.removeItem('endaxis:smoke');
        return true;
      } catch {
        return false;
      }
    })(),
  };
}

const failures = [];
const consoleErrors = [];
const record = (condition, message) => {
  if (!condition) failures.push(message);
};

async function waitForRender(window) {
  // 启动遮罩由 src/main.ts 在“语言资源 + 首个路由挂载”完成后移除，
  // 因此它消失才是真正的就绪信号；只看 #app 有子节点会在挂载前误判通过。
  const deadline = Date.now() + RENDER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const ready = await window.webContents.executeJavaScript(
      `(() => {
         const root = document.querySelector('#app');
         return document.querySelector('#boot-loader') === null &&
                root !== null && root.children.length > 0;
       })()`,
      true,
    );
    if (ready === true) return true;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return false;
}

app.whenReady().then(async () => {
  session.defaultSession.setUserAgent(buildUserAgent());

  let server = null;
  let window = null;
  let exitCode = 1;

  try {
    record(
      fs.existsSync(path.join(DIST_DIRECTORY, 'index.html')),
      'webapp/index.html 不存在，请先运行 npm run prepare:dist',
    );

    server = await startStaticServer(DIST_DIRECTORY);
    console.log(`[verify] 本地站点：${server.origin}`);

    window = new BrowserWindow({
      width: 1600,
      height: 950,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        backgroundThrottling: false,
      },
    });

    window.webContents.on('console-message', event => {
      // Electron 44 用事件对象；旧签名通过 level 字段判断。
      const level = typeof event === 'object' && event !== null ? event.level : undefined;
      const message = typeof event === 'object' && event !== null ? event.message : String(event);
      if (level === 'error' || level === 3) consoleErrors.push(String(message));
    });
    window.webContents.on('render-process-gone', (_event, details) => {
      failures.push(`渲染进程崩溃：${JSON.stringify(details)}`);
    });

    await window.loadURL(server.origin);
    const rendered = await waitForRender(window);
    record(rendered, `页面在 ${RENDER_TIMEOUT_MS}ms 内没有渲染出内容`);

    const report = await window.webContents.executeJavaScript(
      `(${collectPageReport.toString()})()`,
      true,
    );

    console.log('[verify] 页面报告：');
    console.log(JSON.stringify(report, null, 2));

    record(report.hasAppRoot, '#app 容器缺失');
    record(report.appChildCount > 0, '#app 内没有挂载任何组件');
    record(!report.bootLoaderPresent, '启动遮罩没有消失，应用仍停在“正在加载”界面');
    record(
      report.bodyTextLength > 200,
      `页面可见文本过少（${report.bodyTextLength}），可能只剩加载面板`,
    );
    record(report.title.includes('Endaxis'), `窗口标题异常：${report.title}`);
    record(report.localStorageUsable, 'localStorage 不可用，项目不会自动保存');
    record(!report.nativeAppClass, 'html.native-app 被误启用；这会把时间轴强制切成移动工作台');
    record(
      report.url.includes('/timeline'),
      `/ 没有重定向到 /timeline（History 路由未生效）：${report.url}`,
    );
    record(report.viewport.width > 1366, `视口宽度 ${report.viewport.width} 未超过桌面阈值 1366`);
    // 桌面壳不能声明 EndaxisApp/，否则会落到移动工作台；这里直接验证真实渲染结果。
    record(report.hasDesktopWorkbench, '没有渲染出桌面工作台（workbench-layout）');
    record(!report.hasMobileWorkbench, '渲染出了移动工作台，桌面壳身份被误判');

    fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
    const image = await window.webContents.capturePage();
    fs.writeFileSync(SNAPSHOT_PATH, image.toPNG());
    console.log(`[verify] 截图：${SNAPSHOT_PATH}`);

    if (consoleErrors.length > 0) {
      console.log('[verify] 控制台错误：');
      for (const message of consoleErrors.slice(0, 20)) console.log(`  - ${message}`);
    }

    if (failures.length === 0) {
      console.log(`[verify] 通过：${APP_NAME} 本地版可以正常渲染。`);
      exitCode = 0;
    } else {
      console.error('[verify] 失败：');
      for (const message of failures) console.error(`  - ${message}`);
    }
  } catch (error) {
    console.error(`[verify] 异常：${error instanceof Error ? error.stack : error}`);
  } finally {
    window?.destroy();
    await server?.close();
    app.exit(exitCode);
  }
});
