'use strict';

/**
 * 验证更新进度浮层：注入是否成功、各状态渲染是否正确。
 *
 * 做法：启动已安装的程序（或指定的可执行文件），自己开一个窗口指向同一个本地
 * 服务，注入浮层脚本，然后用设置 data-* 属性 + 派发事件的方式模拟主进程推送，
 * 断言渲染结果。这比等一次真实下载快得多，也不受 GitHub 限流影响。
 *
 * 用法： node scripts/launch.mjs tools/verify-update-overlay.js <Endaxis.exe> [--keep]
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { app, BrowserWindow } = require('electron');

const PREFIX = 'OVERLAY ';
const executable = process.argv.slice(2).find(value => value.toLowerCase().endsWith('.exe'));
const overlayScript = path.resolve(__dirname, '..', 'src', 'renderer', 'update-overlay.js');

/** 在页面里读回浮层的关键渲染结果。 */
const READ_STATE = `(() => {
  const root = document.getElementById('__endaxis_update_overlay__');
  if (root === null) return { present: false };
  const bar = root.querySelector('div > div > div:first-child');
  const texts = Array.from(root.querySelectorAll('div, span, button')).map(n => n.textContent).filter(Boolean);
  const track = root.querySelector('div[style*="height: 8px"], div[style*="height:8px"]');
  const fill = track ? track.firstElementChild : null;
  return {
    present: true,
    display: root.style.display,
    fillWidth: fill ? fill.style.width : null,
    title: root.firstElementChild ? root.firstElementChild.firstElementChild.textContent : null,
    texts,
  };
})()`;

/** 模拟主进程推送：写 data-* 再派发事件（与 preload 的做法完全一致）。 */
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
    if (!fs.existsSync(overlayScript)) throw new Error(`找不到浮层脚本 ${overlayScript}`);

    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    console.log(`${PREFIX}启动 ${executable}`);
    child = spawn(executable, [], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise(resolve => setTimeout(resolve, 14_000));

    const window = new BrowserWindow({ show: false, width: 1200, height: 800 });
    await window.loadURL('http://127.0.0.1:17321/');
    console.log(`${PREFIX}页面已加载`);

    // 注入方式与主进程完全一致。
    const source = fs.readFileSync(overlayScript, 'utf8');
    await window.webContents.executeJavaScript(
      `(() => { try { ${source} } catch (e) {} })();`,
      true,
    );

    const injected = await window.webContents.executeJavaScript(READ_STATE, true);
    record(injected.present === true, '浮层已注入到页面');

    // ── 空闲：应隐藏 ──────────────────────────────────────────────────
    await window.webContents.executeJavaScript(pushScript({ state: 'idle' }), true);
    const idle = await window.webContents.executeJavaScript(READ_STATE, true);
    record(idle.display === 'none', `idle 状态应隐藏（实际 display=${idle.display}）`);

    // ── 下载中：进度条 + 当前/总量 + 速度 ─────────────────────────────
    await window.webContents.executeJavaScript(
      pushScript({
        state: 'downloading',
        version: '1.0.6',
        percent: 42.5,
        transferred: 52_000_000,
        total: 122_487_906,
        bytesPerSecond: 8_000_000,
      }),
      true,
    );
    const downloading = await window.webContents.executeJavaScript(READ_STATE, true);
    const joined = (downloading.texts ?? []).join(' | ');
    console.log(`${PREFIX}下载中文案：${joined}`);
    record(downloading.display === 'block', '下载中应显示浮层');
    record(
      downloading.fillWidth === '42.5%',
      `进度条宽度应为 42.5%（实际 ${downloading.fillWidth}）`,
    );
    record(
      typeof downloading.title === 'string' && downloading.title.includes('43'),
      `标题应含百分比（实际「${downloading.title}」）`,
    );
    record(joined.includes('/'), '明细应显示"当前 / 总量"');
    record(/MB/.test(joined), '明细应含 MB 单位');
    record(/\/s/.test(joined), '明细应含下载速度');

    // ── 已下载：满条 + 版本号 ────────────────────────────────────────
    await window.webContents.executeJavaScript(
      pushScript({ state: 'downloaded', version: '1.0.6', total: 122_487_906 }),
      true,
    );
    const downloaded = await window.webContents.executeJavaScript(READ_STATE, true);
    const downloadedText = (downloaded.texts ?? []).join(' | ');
    console.log(`${PREFIX}完成文案：${downloadedText}`);
    record(downloaded.fillWidth === '100%', `完成后进度条应满（实际 ${downloaded.fillWidth}）`);
    record(downloadedText.includes('1.0.6'), '完成态应显示版本号');

    // ── 出错：显示错误并保留一段时间 ─────────────────────────────────
    await window.webContents.executeJavaScript(
      pushScript({ state: 'error', error: 'net::ERR_CONNECTION_RESET' }),
      true,
    );
    const errored = await window.webContents.executeJavaScript(READ_STATE, true);
    const errorText = (errored.texts ?? []).join(' | ');
    console.log(`${PREFIX}错误文案：${errorText}`);
    record(errorText.includes('ERR_CONNECTION_RESET'), '错误态应显示具体原因');

    console.log('');
    if (failures.length === 0) {
      console.log('通过：更新浮层注入正常，各状态渲染符合预期。');
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
