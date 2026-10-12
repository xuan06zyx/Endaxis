'use strict';

/**
 * 端到端验证"preload 推数据 → 浮层渲染"这一段。
 *
 * 前面 tools/verify-update-overlay.js 是直接往 data-* 写值来测渲染，
 * **没有经过 preload**。而真实链路是：
 *   主进程 IPC → preload (update:status) → 写 data-* + 派发事件 → 浮层渲染
 * 这里把缺的这一环补上：用一个真实 preload 的窗口，从主进程发 IPC，
 * 断言浮层最终显示出正确内容。
 *
 * 用法： node scripts/launch.mjs tools/verify-overlay-bridge.js <Endaxis.exe>
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { app, BrowserWindow, ipcMain } = require('electron');

const PREFIX = 'BRIDGE ';
const executable = process.argv.slice(2).find(value => value.toLowerCase().endsWith('.exe'));
const shellRoot = path.resolve(__dirname, '..');
const preloadPath = path.join(shellRoot, 'src', 'preload.js');
const overlayPath = path.join(shellRoot, 'src', 'renderer', 'update-overlay.js');

const READ = `(() => {
  const root = document.getElementById('__endaxis_update_overlay__');
  if (root === null) return { present: false };
  return {
    present: true,
    display: root.style.display,
    state: root.getAttribute('data-state'),
    percent: root.getAttribute('data-percent'),
    title: root.firstElementChild ? root.firstElementChild.firstElementChild.textContent : null,
    text: Array.from(root.querySelectorAll('div, span')).map(n => n.textContent).filter(Boolean).join(' | '),
  };
})()`;

app.whenReady().then(async () => {
  let exitCode = 1;
  let child = null;
  const failures = [];
  const record = (ok, message) => {
    console.log(`${ok ? '✓' : '✗'} ${message}`);
    if (!ok) failures.push(message);
  };

  try {
    if (!executable || !fs.existsSync(executable)) throw new Error(`找不到 ${executable}`);
    for (const file of [preloadPath, overlayPath]) {
      if (!fs.existsSync(file)) throw new Error(`找不到 ${file}`);
    }

    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    console.log(`${PREFIX}启动 ${executable}`);
    child = spawn(executable, [], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise(resolve => setTimeout(resolve, 14_000));

    // 关键：用**真实的** preload，才能验证它的推送逻辑。
    const window = new BrowserWindow({
      show: false,
      width: 1200,
      height: 800,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: preloadPath,
      },
    });
    await window.loadURL('http://127.0.0.1:17321/');

    const source = fs.readFileSync(overlayPath, 'utf8');
    await window.webContents.executeJavaScript(
      `(() => { try { ${source} } catch (e) {} })();`,
      true,
    );
    const injected = await window.webContents.executeJavaScript(READ, true);
    record(injected.present === true, '浮层已注入');

    // 从主进程发 IPC —— 与 updater 的发送方式完全一致。
    const before = await window.webContents.executeJavaScript(READ, true);
    record(before.display === 'none', '初始应为隐藏（idle）');

    window.webContents.send('update:status', {
      state: 'downloading',
      version: '1.0.7',
      percent: 63.2,
      transferred: 77_000_000,
      total: 122_487_906,
      bytesPerSecond: 9_500_000,
    });
    await new Promise(resolve => setTimeout(resolve, 1500));

    const after = await window.webContents.executeJavaScript(READ, true);
    console.log(`${PREFIX}推送后：state=${after.state} percent=${after.percent}`);
    console.log(`${PREFIX}文案：${after.text}`);
    record(after.display === 'block', 'preload 推送后浮层应显示');
    record(after.state === 'downloading', `data-state 应为 downloading（实际 ${after.state}）`);
    record(after.percent === '63.2', `data-percent 应为 63.2（实际 ${after.percent}）`);
    record(
      typeof after.title === 'string' && after.title.includes('63'),
      `标题应含 63%（实际「${after.title}」）`,
    );
    record(typeof after.text === 'string' && after.text.includes('73.4 MB'), '应显示"当前 / 总量"');

    // 再推一次，验证是持续更新而不是只渲染一次。
    window.webContents.send('update:status', {
      state: 'downloading',
      version: '1.0.7',
      percent: 88.9,
      transferred: 108_000_000,
      total: 122_487_906,
      bytesPerSecond: 9_500_000,
    });
    await new Promise(resolve => setTimeout(resolve, 1200));
    const third = await window.webContents.executeJavaScript(READ, true);
    record(third.percent === '88.9', `第二次推送应更新百分比（实际 ${third.percent}）`);
    record(
      typeof third.title === 'string' && third.title.includes('89'),
      `标题应更新为 89%（实际「${third.title}」）`,
    );

    ipcMain.removeAllListeners('update:status');
    console.log('');
    if (failures.length === 0) {
      console.log('通过：preload → 浮层 的数据推送链路正常，进度可连续更新。');
      exitCode = 0;
    } else {
      console.log('失败：');
      for (const message of failures) console.log(`  - ${message}`);
    }
  } catch (error) {
    console.log(`${PREFIX}异常：${error?.message ?? error}`);
  } finally {
    child?.kill();
    app.exit(exitCode);
  }
});
