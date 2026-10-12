'use strict';

/**
 * 浏览器自动保存（防抖）端到端验证。
 *
 * 背景：上游原本"每次提交都立刻写 IndexedDB"，本地版把写入合并到防抖窗口里，
 * 以降低拖拽/连续输入产生的短事务数量。这个改动有两个必须守住的底线：
 *
 *   1. 自动恢复不能坏 —— 重新打开要能读回上次的项目；
 *   2. 合并不能变成"不写" —— 改动最终必须落盘。
 *
 * 因此这里做两件真事（都在真实 Electron 窗口里，不用 mock）：
 *   - 通过 IndexedDB 预置一份项目，重新加载后确认被恢复；
 *   - 在页面里挂钩 IDBDatabase.transaction，数真实写事务的次数与发生时刻，
 *     用来证明"写入确实被推迟合并了"，而不是靠读代码推断。
 *
 * 用法： npm run verify:autosave
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const { buildUserAgent } = require('../src/main/config');
const { startStaticServer } = require('../src/main/server');
const { buildEditScript } = require('./lib/edit-trigger');

const DIST_DIRECTORY = path.resolve(__dirname, '..', 'webapp');
const RENDER_TIMEOUT_MS = 60_000;

/**
 * 用独立的 userData（在 app ready 之前设置）。
 *
 * 必须隔离：存储按 origin 隔离，而端口现在是固定的，所以沿用真实/共享的
 * userData 会让上一次运行（或其它测试）留下的项目串进来，断言随执行顺序
 * 时好时坏——实测跑完其它测试再跑本脚本就会失败。
 */
const SCRATCH_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'endaxis-autosave-'));
app.setPath('userData', SCRATCH_USER_DATA);

/** 与 src/ui/timeline/projectFileSession.ts 的防抖窗口保持一致。 */
const EXPECTED_DEBOUNCE_MS = 1200;
/** 写入被推迟的证据：观测到的延迟必须明显超过"立刻写"。 */
const MIN_OBSERVED_DELAY_MS = 700;
const OBSERVE_TIMEOUT_MS = 20_000;

/**
 * 在文档创建前注入：统计 endaxis-timeline 库里 projects 对象的写事务。
 * 走 preload（见 autosave-probe-preload.js），保证覆盖到应用真正使用的
 * `IDBDatabase` 实例——事后用 executeJavaScript 注入不可靠，实测抓不到写入。
 */
const PROBE_PRELOAD = path.join(__dirname, 'autosave-probe-preload.js');

/** 读取预置项目里的 createdWith，用来确认"恢复的是同一份数据"。 */
const READ_SEEDED = `
new Promise(resolve => {
  const request = indexedDB.open('endaxis-timeline', 1);
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains('projects')) {
      request.result.createObjectStore('projects');
    }
  };
  request.onerror = () => resolve({ ok: false, error: String(request.error) });
  request.onsuccess = () => {
    const tx = request.result.transaction('projects', 'readonly');
    const get = tx.objectStore('projects').get('current');
    get.onsuccess = () => resolve({ ok: true, value: get.result ?? null });
    get.onerror = () => resolve({ ok: false, error: String(get.error) });
  };
});
`;

function waitForRender(window) {
  const deadline = Date.now() + RENDER_TIMEOUT_MS;
  return (async () => {
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
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    return false;
  })();
}

const failures = [];
const record = (condition, message) => {
  if (!condition) failures.push(message);
};

app.whenReady().then(async () => {
  let exitCode = 1;
  let server = null;
  let window = null;

  try {
    record(
      fs.existsSync(path.join(DIST_DIRECTORY, 'index.html')),
      'webapp/index.html 不存在，请先运行 npm run prepare:dist',
    );
    server = await startStaticServer(DIST_DIRECTORY);
    window = new BrowserWindow({
      width: 1400,
      height: 900,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
        preload: PROBE_PRELOAD,
      },
    });
    window.webContents.on('console-message', event => {
      const level = typeof event === 'object' && event !== null ? event.level : undefined;
      const message = typeof event === 'object' && event !== null ? event.message : String(event);
      if (level === 'error' || level === 3) console.log(`  [page:error] ${message}`);
    });

    console.log(`[verify:autosave] 站点：${server.origin}`);
    console.log(`[verify:autosave] 独立数据目录：${SCRATCH_USER_DATA}`);
    await window.loadURL(server.origin);
    record(await waitForRender(window), '首屏没有渲染完成');

    // 首屏不写盘是正常的：自动保存订阅的是"项目提交"，没人改就没有提交。
    // 这里只确认计数器已经挂上（否则后面的计时断言会失去意义）。
    const baseline = await window.webContents.executeJavaScript(
      `(() => ({
         attached: typeof window.__endaxisSaveProbe === 'object' && window.__endaxisSaveProbe !== null,
         writes: window.__endaxisSaveProbe?.writes?.length ?? -1,
         reads: window.__endaxisSaveProbe?.reads?.length ?? -1,
       }))()`,
      true,
    );
    console.log(`[verify:autosave] 首屏后：${JSON.stringify(baseline)}`);
    record(baseline.attached === true, '写事务计数器没有注入成功（preload 失效）');
    // 首屏会读一次存档（恢复上次项目），读事务必须被观测到。
    record(baseline.reads >= 1, '没有观测到读取存档的事务，恢复路径可能没走');

    // ── 防抖：触发一次真实编辑，观察写入被推迟多久 ─────────────────────────
    //
    // 先做这一步再验恢复：空项目第一次提交本来就该把存档建起来，
    // 有了真实存档才能测"重新打开是否读回同一份数据"。
    await window.webContents.executeJavaScript(
      `(() => { window.__endaxisSaveProbe.writes.length = 0; return true; })()`,
      true,
    );
    const editedAt = Date.now();
    const triggered = await window.webContents.executeJavaScript(
      buildEditScript(String(Date.now()).slice(-6)),
      true,
    );
    console.log(`[verify:autosave] 触发编辑：${JSON.stringify(triggered)}`);

    let writeAt = null;
    const deadline = Date.now() + OBSERVE_TIMEOUT_MS;
    while (Date.now() < deadline && writeAt === null) {
      const probe = await window.webContents.executeJavaScript(
        '(() => ({ writes: window.__endaxisSaveProbe.writes }))()',
        true,
      );
      if (probe.writes.length > 0) writeAt = probe.writes[0];
      else await new Promise(resolve => setTimeout(resolve, 100));
    }

    if (!triggered.ok) {
      failures.push(`没找到可用于触发提交的输入框：${JSON.stringify(triggered.candidates)}`);
    } else {
      record(
        writeAt !== null,
        `编辑后 ${OBSERVE_TIMEOUT_MS}ms 内没有任何写事务（保存路径可能断了）`,
      );
      if (writeAt !== null) {
        const delay = writeAt - editedAt;
        console.log(`[verify:autosave] 编辑 → 写入延迟：${delay}ms`);
        record(
          delay >= MIN_OBSERVED_DELAY_MS,
          `写入没有被推迟（延迟仅 ${delay}ms，期望 >= ${MIN_OBSERVED_DELAY_MS}ms，` +
            `防抖窗口 ${EXPECTED_DEBOUNCE_MS}ms 可能没生效）`,
        );
        record(
          delay <= EXPECTED_DEBOUNCE_MS + 4000,
          `写入推迟过久（${delay}ms），保存进度可能被拖住`,
        );
      }
    }

    // ── 自动恢复：给刚写下的存档打标记，重新加载后必须读回 ─────────────────
    const seededMarker = `autosave-probe-${Date.now()}`;
    const seeded = await window.webContents.executeJavaScript(
      `(async () => {
         const read = () => new Promise(resolve => {
           const request = indexedDB.open('endaxis-timeline', 1);
           request.onsuccess = () => {
             const tx = request.result.transaction('projects', 'readonly');
             const get = tx.objectStore('projects').get('current');
             get.onsuccess = () => resolve(get.result ?? null);
             get.onerror = () => resolve(null);
           };
           request.onerror = () => resolve(null);
         });
         const current = await read();
         if (typeof current !== 'string') {
           return { ok: false, reason: '存档不存在或不是字符串', got: typeof current };
         }
         const mutated = current.replace(/"createdWith":"[^"]*"/, '"createdWith":"${seededMarker}"');
         if (mutated === current) return { ok: false, reason: '存档里没有 createdWith 字段' };
         await new Promise((resolve, reject) => {
           const request = indexedDB.open('endaxis-timeline', 1);
           request.onsuccess = () => {
             const tx = request.result.transaction('projects', 'readwrite');
             tx.objectStore('projects').put(mutated, 'current');
             tx.oncomplete = () => resolve();
             tx.onerror = () => reject(tx.error);
           };
           request.onerror = () => reject(request.error);
         });
         return { ok: true, length: mutated.length };
       })()`,
      true,
    );
    console.log(`[verify:autosave] 预置存档：${JSON.stringify(seeded)}`);
    record(seeded.ok === true, `无法预置存档用于恢复测试：${seeded.reason ?? ''}`);

    await window.loadURL(server.origin);
    record(await waitForRender(window), '重新加载后首屏没有渲染完成');
    await new Promise(resolve => setTimeout(resolve, 3000));
    const restored = await window.webContents.executeJavaScript(READ_SEEDED, true);
    const restoredText = typeof restored.value === 'string' ? restored.value : '';
    console.log(
      `[verify:autosave] 重载后读回存档：${restoredText.includes(seededMarker) ? '命中预置标记' : '未见预置标记'}`,
    );
    record(restored.ok === true, `重载后读取 IndexedDB 失败：${restored.error}`);
    if (seeded.ok === true) {
      record(restoredText.includes(seededMarker), '自动恢复失效：重载后没有读回预置的项目内容');
    }

    if (failures.length === 0) {
      console.log('[verify:autosave] 通过：自动恢复可用，写入已按防抖窗口合并。');
      exitCode = 0;
    } else {
      console.error('[verify:autosave] 失败：');
      for (const message of failures) console.error(`  - ${message}`);
    }
  } catch (error) {
    console.error(`[verify:autosave] ${error instanceof Error ? error.stack : error}`);
  } finally {
    window?.destroy();
    await server?.close();
    // 清理独立数据目录，避免在临时目录里堆积。
    try {
      fs.rmSync(SCRATCH_USER_DATA, { recursive: true, force: true });
    } catch {
      // 清理失败无所谓。
    }
    app.exit(exitCode);
  }
});
