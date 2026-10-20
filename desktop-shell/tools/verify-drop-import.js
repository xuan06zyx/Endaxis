'use strict';

/**
 * 「拖入 JSON 文件导入排轴」端到端验证。
 *
 * 这个功能唯一不能靠单测保证的是 **DOM 契约**：桌面壳把拖入的文件投递给上游那个
 * `input.project-file-input`，再派发 `change` 让上游原有导入流程接管。
 * 一旦上游改了类名或换掉这个 input，功能会失效但**不会报错** —— 只能靠真实窗口验证。
 *
 * 这里在真实 Electron 窗口里做三件事：
 *   1. 合成一次真正的 `drop`（DataTransfer + File），确认进入上游导入流程（弹确认框）；
 *   2. 点确认，确认项目真的被导入（用样本里的方案名做标记）；
 *   3. 再拖一个 .txt，确认被拒绝且给出提示。
 *
 * 样本来自 `tools/fixtures/sample-project.json`：由应用自己的
 * `createEmptyProject` + `serializeProjectDocument` 生成，格式永远合法。
 * 早先这个脚本靠"在页面里改输入框"来产生项目，上游一次 UI 调整就失效了。
 *
 * 用法：npm run verify:drop
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const { startStaticServer } = require('../src/main/server');

const DIST_DIRECTORY = path.resolve(__dirname, '..', 'webapp');
const FIXTURE = path.join(__dirname, 'fixtures', 'sample-project.json');
const RENDER_TIMEOUT_MS = 60_000;
const DIALOG_TIMEOUT_MS = 25_000;
/** 与样本里写死的方案名保持一致。 */
const MARKER = '拖入导入-样本';

/** 独立 userData：避免与其它验证脚本/真实使用互相污染项目数据。 */
const SCRATCH_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'endaxis-drop-'));
app.setPath('userData', SCRATCH_USER_DATA);

const failures = [];
const record = (condition, message) => {
  console.log(`${condition ? '✓' : '✗'} ${message}`);
  if (!condition) failures.push(message);
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** 等待首屏渲染出导入入口（也是本功能依赖的那个元素）。 */
async function waitForRender(window) {
  const deadline = Date.now() + RENDER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const ready = await window.webContents.executeJavaScript(
      `(() => document.querySelector('input.project-file-input') !== null)()`,
      true,
    );
    if (ready) return true;
    await sleep(400);
  }
  return false;
}

/** 在页面里合成一次文件拖放。 */
function buildDropScript(fileName, content, mime) {
  return `
(() => {
  const file = new File([${JSON.stringify(content)}], ${JSON.stringify(fileName)}, { type: ${JSON.stringify(mime)} });
  const transfer = new DataTransfer();
  transfer.items.add(file);
  const event = new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true });
  window.dispatchEvent(event);
  return { types: Array.from(transfer.types) };
})()`;
}

/** 导入确认弹窗里的主按钮（替换/追加/覆盖）。 */
const HAS_CONFIRM_BUTTON = `(() => Array.from(document.querySelectorAll('button')).some(b => /替换|追加|覆盖/.test(b.textContent ?? '')))()`;

const CLICK_CONFIRM = `
(() => {
  const buttons = Array.from(document.querySelectorAll('button'));
  const target = buttons.find(button => /替换|追加|覆盖/.test(button.textContent ?? ''));
  if (!target) return { clicked: false };
  target.click();
  return { clicked: true, label: (target.textContent ?? '').trim() };
})()`;

app.whenReady().then(async () => {
  let server = null;
  let window = null;
  let exitCode = 1;
  try {
    record(fs.existsSync(FIXTURE), `样本文件存在：${path.basename(FIXTURE)}`);
    if (!fs.existsSync(FIXTURE)) throw new Error('缺少 fixtures/sample-project.json');
    const sampleContent = fs.readFileSync(FIXTURE, 'utf8');

    server = await startStaticServer(DIST_DIRECTORY);
    window = new BrowserWindow({
      // 必须显示：隐藏窗口会被 Chromium 节流，渲染与 IndexedDB 写入都会推迟。
      show: true,
      width: 1400,
      height: 900,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        preload: path.join(__dirname, '..', 'src', 'preload.js'),
      },
    });
    await window.loadURL(`${server.origin}/`);

    record(await waitForRender(window), '时间轴首屏渲染完成，导入入口存在');

    // ── 1. 合成拖放 ────────────────────────────────────────────────────
    const dropped = await window.webContents.executeJavaScript(
      buildDropScript('dropped-project.json', sampleContent, 'application/json'),
      true,
    );
    record(
      Array.isArray(dropped.types) && dropped.types.includes('Files'),
      '合成的拖放事件带 Files 类型',
    );

    // ── 2. 等导入确认弹窗 ──────────────────────────────────────────────
    let dialogSeen = false;
    const dialogDeadline = Date.now() + DIALOG_TIMEOUT_MS;
    while (Date.now() < dialogDeadline && !dialogSeen) {
      await sleep(300);
      dialogSeen = await window.webContents.executeJavaScript(HAS_CONFIRM_BUTTON, true);
    }
    record(dialogSeen, '拖入后进入上游导入流程（出现导入确认弹窗）');

    // ── 3. 确认导入并验证 ─────────────────────────────────────────────
    const clicked = await window.webContents.executeJavaScript(CLICK_CONFIRM, true);
    record(clicked.clicked === true, `点击确认按钮：${clicked.label ?? '(未找到)'}`);
    await sleep(3500);

    const bodyText = await window.webContents.executeJavaScript(
      `(() => document.body.innerText)()`,
      true,
    );
    record(bodyText.includes(MARKER), `导入后界面出现样本方案名「${MARKER}」`);

    // ── 4. 非项目文件应被拒绝 ─────────────────────────────────────────
    await window.webContents.executeJavaScript(
      buildDropScript('notes.txt', 'not a project', 'text/plain'),
      true,
    );
    await sleep(1000);
    const toast = await window.webContents.executeJavaScript(
      `(() => document.querySelector('[data-endaxis-drop-toast]')?.textContent ?? '')()`,
      true,
    );
    record(/只支持|Only/.test(toast), `非项目文件被拒绝并提示：${toast}`);
    // 拒绝之后项目不应被破坏。
    const afterText = await window.webContents.executeJavaScript(
      `(() => document.body.innerText)()`,
      true,
    );
    record(afterText.includes(MARKER), '拒绝非项目文件后，已导入的项目仍在');

    console.log('');
    if (failures.length === 0) {
      console.log('通过：拖入 JSON 可导入排轴，非项目文件被正确拒绝。');
      exitCode = 0;
    } else {
      console.log('失败：');
      for (const message of failures) console.log(`  - ${message}`);
    }
  } catch (error) {
    console.log(`异常：${error?.stack ?? error}`);
  } finally {
    window?.destroy();
    await server?.close();
    app.exit(exitCode);
  }
});
