'use strict';

/**
 * 单阶段探针：给 verify-close-flush 当子进程用。
 *
 * 阶段一（--edit）：触发一次提交，只等一小会儿就关窗退出——模拟"改完马上关程序"。
 * 阶段二（--check）：只读存档，报告标记值在不在。
 *
 * 必须拆成两个进程：只有一个窗口的应用，关掉窗口就等于退出，
 * 没法在同一个进程里既"关掉"又"重开"。
 *
 * 用法： node scripts/launch.mjs tools/close-flush-probe.js --edit <marker> <delayMs> [--user-data-dir=<dir>]
 */

const path = require('node:path');
const { app, BrowserWindow, session } = require('electron');
const { startStaticServer } = require('../src/main/server');
const { buildUserAgent } = require('../src/main/config');

const DIST_DIRECTORY = path.resolve(__dirname, '..', 'webapp');

const mode = process.argv.includes('--edit')
  ? 'edit'
  : process.argv.includes('--check')
    ? 'check'
    : null;
const positional = process.argv.slice(2).filter(value => !value.startsWith('--'));
const marker = positional[0] ?? 'probe';
const delayMs = Number.parseInt(positional[1] ?? '0', 10);

const userDataArgument = process.argv.find(value => value.startsWith('--user-data-dir='));
if (userDataArgument !== undefined) {
  const directory = userDataArgument.slice('--user-data-dir='.length);
  require('node:fs').mkdirSync(directory, { recursive: true });
  app.setPath('userData', directory);
}

/**
 * 触发一次真实提交，把某个敌人数值改成标记值。
 * 逻辑与 verify-autosave 共用，避免两边各修一遍（见 tools/lib/edit-trigger.js）。
 */
const EDIT_WITH_MARKER = value => require('./lib/edit-trigger').buildEditScript(value);

const STORED_HAS_MARKER = value => `
new Promise(resolve => {
  const request = indexedDB.open('endaxis-timeline', 1);
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains('projects')) {
      request.result.createObjectStore('projects');
    }
  };
  request.onsuccess = () => {
    const tx = request.result.transaction('projects', 'readonly');
    const get = tx.objectStore('projects').get('current');
    get.onsuccess = () => {
      const stored = get.result;
      if (typeof stored !== 'string') return resolve({ found: false, kind: typeof stored });
      resolve({ found: stored.includes('${value}'), bytes: stored.length });
    };
    get.onerror = () => resolve({ found: false, error: String(get.error) });
  };
});
`;

const PROBE_PREFIX = 'CLOSE_FLUSH ';

app.whenReady().then(async () => {
  session.defaultSession.setUserAgent(buildUserAgent());
  const server = await startStaticServer(DIST_DIRECTORY);
  const preloadPath = path.join(__dirname, '..', 'src', 'preload.js');
  console.log(
    `${PROBE_PREFIX}preload=${preloadPath} exists=${require('node:fs').existsSync(preloadPath)}`,
  );
  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      // 必须和正式窗口一致：关窗等待保存是靠这个 preload 建立的通道，
      // 漏掉它就会测出"写入丢失"的假象（实际是没人接主进程的请求）。
      preload: preloadPath,
    },
  });
  window.webContents.on('preload-error', (_event, failedPath, error) => {
    console.log(`${PROBE_PREFIX}preload-error ${failedPath}: ${error?.message ?? error}`);
  });

  // 关键：必须复刻正式主进程的关窗行为。
  // 这个探针本身也是一个 Electron 入口，如果不挂 coordinator，
  // 窗口就会直接关掉、排队的写入自然丢失——那测出来的是假故障。
  require('../src/main/closeCoordinator').attachCloseFlush(window, {
    onTimeout: () => console.log(`${PROBE_PREFIX}flush-timeout`),
  });

  await window.loadURL(server.origin);
  await new Promise(resolve => setTimeout(resolve, 6000));

  if (mode === 'check') {
    const result = await window.webContents.executeJavaScript(STORED_HAS_MARKER(marker), true);
    // 用独立前缀，避免和上面的 preload 诊断行混淆（verify-close-flush 只认这一行）。
    console.log(`${PROBE_PREFIX}RESULT ${JSON.stringify(result)}`);
    window.destroy();
    await server.close();
    app.exit(0);
    return;
  }

  if (mode !== 'edit') {
    console.error('用法：--edit <marker> <delayMs> 或 --check <marker>');
    window.destroy();
    await server.close();
    app.exit(2);
    return;
  }

  const edited = await window.webContents.executeJavaScript(EDIT_WITH_MARKER(marker), true);
  console.log(`${PROBE_PREFIX}edit=${JSON.stringify(edited)}`);

  // 关键：确认页面里确实挂上了"关窗前交保存"的桥。
  // 没有桥的话，主进程等的是一次空操作——数据照样丢。
  const bridge = await window.webContents.executeJavaScript(
    `(() => {
       const api = window.EndaxisDesktop;
       return {
         exposed: typeof api === 'object' && api !== null,
         hasOnFlushSaves: typeof api?.onFlushSaves === 'function',
         placeholderCount: Array.from(document.querySelectorAll('*'))
           .filter(n => n.children.length === 0)
           .filter(n => /^未设置干员$/.test((n.textContent ?? '').trim())).length,
       };
     })()`,
    true,
  );
  console.log(`${PROBE_PREFIX}bridge=${JSON.stringify(bridge)}`);

  // 关键：只等 delayMs 就关窗，远小于 1.2 秒防抖窗口。
  if (process.argv.includes('--no-close')) {
    // 诊断用：不关窗，等过防抖窗口后再看写事务计数，
    // 用来区分"编辑没产生提交"和"提交了但关窗时丢了"。
    await new Promise(resolve => setTimeout(resolve, delayMs + 2500));
    const counters = await window.webContents.executeJavaScript(
      `(async () => {
         const probe = window.EndaxisDesktop;
         return { hasBridge: typeof probe === 'object' };
       })()`,
      true,
    );
    console.log(`${PROBE_PREFIX}no-close ${JSON.stringify(counters)}`);
    window.destroy();
    await server.close();
    app.exit(0);
    return;
  }

  await new Promise(resolve => setTimeout(resolve, delayMs));

  let prevented = false;
  window.webContents.on('will-prevent-unload', event => {
    prevented = true;
    // 模拟用户点"离开"：放行关闭。
    event.preventDefault();
  });

  console.log(`${PROBE_PREFIX}closing`);
  window.close();

  // 如果关闭被拦下（用户点"留下"），也别把测试挂死。
  setTimeout(() => {
    console.log(`${PROBE_PREFIX}force-exit prevented=${prevented}`);
    process.exit(0);
  }, 5000);
});
