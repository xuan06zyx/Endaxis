'use strict';

/**
 * 验证"检查更新"窗口：能打开、镜像表渲染、IPC 白名单可用、测速与检查按钮真的工作。
 *
 * 这个窗口是用户选镜像站的唯一入口。它要是渲染失败或 IPC 没接上，无法直连 GitHub
 * 的用户就彻底没有出路——所以每一项都要断言，而不是"打开了就算过"。
 *
 * 用法： node scripts/launch.mjs tools/verify-source-window.js
 */

const path = require('node:path');
const { app, ipcMain } = require('electron');

const PREFIX = 'SOURCEWIN ';
const failures = [];
const record = (ok, message) => {
  console.log(`${ok ? '✓' : '✗'} ${message}`);
  if (!ok) failures.push(message);
};

/** 记录主进程侧被调用的方法，用来确认 IPC 真的接到了。 */
const called = new Set();
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  let exitCode = 1;
  let window = null;
  let disposeWindows = null;
  try {
    const { openSourceWindow, disposeSourceWindow } = require('../src/main/sourceWindow');
    const { MIRRORS, MIRROR_LIST_URL } = require('../src/main/mirrors');
    // 必须在 try 内取到；漏了会让 finally 抛 ReferenceError，
    // 变成未处理的 Promise 拒绝并让进程卡住不退出（实测踩过）。
    disposeWindows = disposeSourceWindow;

    // 桩：只实现窗口需要的接口，避免真去联网。
    const stubUpdater = {
      describeSources: () => {
        called.add('describeSources');
        return {
          currentVersion: '1.0.6',
          mirrors: MIRRORS.map(mirror => ({
            id: mirror.id,
            name: mirror.name,
            description: mirror.description,
            supportsApi: mirror.supportsApi,
          })),
          selectedId: 'ghfast',
          speedTest: null,
          listUrl: MIRROR_LIST_URL,
        };
      },
      selectMirror: id => {
        called.add(`selectMirror:${id}`);
        return { ok: true, mirror: { id, name: id } };
      },
      runSpeedTest: () => {
        called.add('runSpeedTest');
        return [
          {
            id: 'github',
            ok: true,
            ttfbMs: 900,
            speedBps: 1_500_000,
            sampleBytes: 100,
            error: null,
          },
          {
            id: 'ghfast',
            ok: true,
            ttfbMs: 1200,
            speedBps: 5_000_000,
            sampleBytes: 100,
            error: null,
            unstable: true,
          },
          {
            id: 'ghproxy-com',
            ok: false,
            ttfbMs: null,
            speedBps: null,
            sampleBytes: 0,
            error: '超时',
          },
          {
            id: 'ghproxy-net',
            ok: true,
            ttfbMs: 1500,
            speedBps: 500_000,
            sampleBytes: 100,
            error: null,
          },
        ];
      },
      queryLatest: () => {
        called.add('queryLatest');
        return {
          ok: true,
          latest: '1.0.7',
          current: '1.0.6',
          source: 'ghproxy-com',
          hasUpdate: true,
        };
      },
      startDownload: () => {
        called.add('startDownload');
        return { ok: false, reason: '验证不真的下载' };
      },
      installNow: () => {
        called.add('installNow');
        return { ok: true };
      },
    };

    window = openSourceWindow({ updater: stubUpdater, parent: null });
    record(window !== null && !window.isDestroyed(), '检查更新窗口已创建');

    // 等页面加载完成。
    await new Promise(resolve => {
      if (!window.webContents.isLoading()) return resolve();
      window.webContents.once('did-finish-load', resolve);
    });
    // 给 init() 里的异步 getState 一点时间。
    await wait(1200);

    const snapshot = await window.webContents.executeJavaScript(
      `(() => ({
         title: document.title,
         heading: document.querySelector('h1')?.textContent ?? null,
         currentVersion: document.getElementById('currentVersion')?.textContent ?? null,
         rowCount: document.querySelectorAll('#mirrorRows tr').length,
         rows: Array.from(document.querySelectorAll('#mirrorRows tr')).map(tr =>
           Array.from(tr.querySelectorAll('td')).map(td => td.textContent.trim())),
         selectedRow: document.querySelector('#mirrorRows tr.selected')?.textContent?.trim() ?? null,
         hasTestButton: !!document.getElementById('testButton'),
         hasCheckButton: !!document.getElementById('checkButton'),
         hasListLink: !!document.getElementById('listLink'),
         exposedApi: typeof window.EndaxisSource === 'object' && window.EndaxisSource !== null,
       }))()`,
      true,
    );

    console.log(
      `${PREFIX}标题=${snapshot.title} 当前版本=${snapshot.currentVersion} 行数=${snapshot.rowCount}`,
    );
    for (const row of snapshot.rows) console.log(`${PREFIX}  行: ${row.join(' | ')}`);

    record(snapshot.heading === '检查更新', '标题正确');
    record(snapshot.currentVersion === '1.0.6', '显示当前版本');
    record(snapshot.rowCount === MIRRORS.length, `镜像表渲染出全部 ${MIRRORS.length} 行`);
    record(snapshot.hasTestButton && snapshot.hasCheckButton, '测速与检查按钮都在');
    record(snapshot.hasListLink, '提供官方地址发布页入口');
    record(snapshot.exposedApi, 'preload 暴露了 EndaxisSource 接口');
    record(called.has('describeSources'), '窗口启动时读取了状态');
    record(
      typeof snapshot.selectedRow === 'string' && snapshot.selectedRow.includes('ghfast'),
      `选中的下载源被高亮（实际「${snapshot.selectedRow}」）`,
    );

    // ── 测速按钮 ──────────────────────────────────────────────────────
    await window.webContents.executeJavaScript(
      `document.getElementById('testButton').click()`,
      true,
    );
    await wait(1500);
    const afterTest = await window.webContents.executeJavaScript(
      `(() => ({
         rowCount: document.querySelectorAll('#mirrorRows tr').length,
         rows: Array.from(document.querySelectorAll('#mirrorRows tr')).map(tr =>
           Array.from(tr.querySelectorAll('td')).map(td => td.textContent.trim())),
         status: document.getElementById('status')?.textContent ?? '',
       }))()`,
      true,
    );
    record(called.has('runSpeedTest'), '点测速调到了主进程');
    record(afterTest.status.length > 0, '测速后给出状态说明');
    console.log(`${PREFIX}测速后状态：${afterTest.status}`);
    for (const row of afterTest.rows) console.log(`${PREFIX}  行: ${row.join(' | ')}`);

    const joined = afterTest.rows.map(row => row.join(' ')).join(' ');
    record(joined.includes('MB/s'), '测速结果里显示了速度');
    record(joined.includes('ms'), '测速结果里显示了延迟');
    record(joined.includes('超时'), '不可用的源照实标出原因');
    record(joined.includes('不稳定'), '重试才成功的源被标注为不稳定');

    // 校验"最快的源被突出显示"：stub 里 ghfast 本来就选中，所以这里断言高亮行
    // 是 ghfast（自动选择逻辑的效果是"选中项等于最快项"，而不是"必然发生切换"）。
    const selectedAfterTest = await window.webContents.executeJavaScript(
      `document.querySelector('#mirrorRows tr.selected')?.textContent?.trim() ?? null`,
      true,
    );
    record(
      typeof selectedAfterTest === 'string' && selectedAfterTest.includes('ghfast'),
      `测速后选中的是最快的源（实际「${selectedAfterTest}」）`,
    );

    // ── 检查更新按钮 ──────────────────────────────────────────────────
    await window.webContents.executeJavaScript(
      `document.getElementById('checkButton').click()`,
      true,
    );
    await wait(1500);
    const afterCheck = await window.webContents.executeJavaScript(
      `document.getElementById('status')?.textContent ?? ''`,
      true,
    );
    record(called.has('queryLatest'), '点检查更新调到了主进程');
    record(called.has('startDownload'), '发现新版本后进入下载流程');
    console.log(`${PREFIX}检查后状态：${afterCheck}`);

    console.log('');
    if (failures.length === 0) {
      console.log('通过：检查更新窗口渲染、IPC 与测速/检查流程都正常。');
      exitCode = 0;
    } else {
      console.log('失败：');
      for (const message of failures) console.log(`  - ${message}`);
    }
  } catch (error) {
    console.log(`${PREFIX}异常：${error?.stack ?? error}`);
  } finally {
    try {
      disposeWindows?.();
    } catch {
      // 清理失败不影响结论。
    }
    for (const channel of [
      'endaxis:source:get-state',
      'endaxis:source:select',
      'endaxis:source:test',
      'endaxis:source:query',
      'endaxis:source:download',
      'endaxis:source:install',
      'endaxis:source:open-list',
    ]) {
      ipcMain.removeHandler(channel);
    }
    app.exit(exitCode);
  }
});

void path;
