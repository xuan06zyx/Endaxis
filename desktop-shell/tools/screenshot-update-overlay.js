'use strict';

/**
 * 给更新浮层各状态截图，用于人工确认视觉效果。
 *
 * 状态数据通过 data-* 属性注入（与 preload 推送方式完全一致），
 * 所以截出来的就是真实渲染结果，不是示意图。
 *
 * 用法： node scripts/launch.mjs tools/screenshot-update-overlay.js <Endaxis.exe> [输出目录]
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { app, BrowserWindow } = require('electron');

const PREFIX = 'SHOT ';
const executable = process.argv.slice(2).find(value => value.toLowerCase().endsWith('.exe'));
const outputDirectory = path.resolve(
  process.argv
    .slice(2)
    .find(value => !value.toLowerCase().endsWith('.exe') && !value.endsWith('.js')) ??
    path.join(__dirname, '..', 'verification'),
);
const overlayScript = path.resolve(__dirname, '..', 'src', 'renderer', 'update-overlay.js');

function pushScript(payload) {
  const attributes = Object.entries({
    'data-state': payload.state ?? 'idle',
    'data-version': payload.version ?? '',
    'data-percent': payload.percent ?? '',
    'data-transferred': payload.transferred ?? '',
    'data-total': payload.total ?? '',
    'data-speed': payload.bytesPerSecond ?? '',
    'data-error': payload.error ?? '',
  })
    .map(
      ([key, value]) =>
        `root.setAttribute(${JSON.stringify(key)}, ${JSON.stringify(String(value))});`,
    )
    .join('\n');
  return `(() => {
    const root = document.getElementById('__endaxis_update_overlay__');
    if (root === null) return false;
    ${attributes}
    root.dispatchEvent(new CustomEvent('endaxis:update-status'));
    return true;
  })()`;
}

const SCENES = [
  {
    name: '1-downloading',
    label: '下载中（进度条 + 当前/总量 + 速度与剩余）',
    payload: {
      state: 'downloading',
      version: '1.0.6',
      percent: 42.5,
      transferred: 52_000_000,
      total: 122_487_906,
      bytesPerSecond: 8_000_000,
    },
    settleMs: 1200, // 等进度条 transition 走完
  },
  {
    name: '2-downloaded',
    label: '下载完成（等待重启安装）',
    payload: { state: 'downloaded', version: '1.0.6', total: 122_487_906 },
    settleMs: 400,
  },
  {
    name: '3-error',
    label: '出错（显示具体原因）',
    payload: { state: 'error', error: 'net::ERR_CONNECTION_RESET' },
    settleMs: 400,
  },
];

app.whenReady().then(async () => {
  let exitCode = 1;
  let child = null;
  try {
    if (!executable || !fs.existsSync(executable)) throw new Error(`找不到 ${executable}`);
    fs.mkdirSync(outputDirectory, { recursive: true });

    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    child = spawn(executable, [], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise(resolve => setTimeout(resolve, 14_000));

    const window = new BrowserWindow({ show: false, width: 1400, height: 900 });
    await window.loadURL('http://127.0.0.1:17321/');
    const source = fs.readFileSync(overlayScript, 'utf8');
    await window.webContents.executeJavaScript(
      `(() => { try { ${source} } catch (e) {} })();`,
      true,
    );
    console.log(`${PREFIX}窗口与浮层就绪`);

    for (const scene of SCENES) {
      await window.webContents.executeJavaScript(pushScript(scene.payload), true);
      await new Promise(resolve => setTimeout(resolve, scene.settleMs));
      // 先读回实际状态再截图：capturePage 相对渲染有延迟，不确认就容易出现
      // "文件名写的是 A、图里却是 B"的错位（第一次跑就踩了）。
      const expected = scene.payload.state;
      let actual = null;
      for (let attempt = 0; attempt < 10; attempt += 1) {
        actual = await window.webContents.executeJavaScript(
          `document.getElementById('__endaxis_update_overlay__')?.getAttribute('data-state') ?? null`,
          true,
        );
        if (actual === expected) break;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      // 再等两帧，确保 DOM 改动已经画到屏幕上。
      await new Promise(resolve => setTimeout(resolve, 600));
      if (actual !== expected) {
        console.log(`${PREFIX}注意：期望状态 ${expected}，实际 ${actual}`);
      }
      const image = await window.webContents.capturePage();
      const file = path.join(outputDirectory, `update-overlay-${scene.name}.png`);
      fs.writeFileSync(file, image.toPNG());
      console.log(`${PREFIX}${scene.label}（state=${actual}） → ${file}`);
    }

    console.log('');
    console.log('完成：截图已生成。');
    exitCode = 0;
  } catch (error) {
    console.log(`${PREFIX}异常：${error?.message ?? error}`);
  } finally {
    child?.kill();
    app.exit(exitCode);
  }
});
