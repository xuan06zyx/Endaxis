'use strict';

/**
 * 受控地跑完整更新链路：检查 → 提示 → 下载 → 提示安装 → 备份 → 安装。
 *
 * 为什么打桩 dialog.showMessageBox：真实弹窗需要人点，而 UI 自动化在模态
 * 对话框上很脆弱（实测：本进程窗口树里根本枚举不到 Electron 原生对话框的按钮）。
 * 这里把对话框换成"自动选第一个按钮"，等价于用户依次点击
 * 「立即下载」和「重启并安装」，从而把链路一次跑通并逐步取证。
 *
 * 用本地静态源喂线上同一批资产，避开 GitHub 匿名限流。
 *
 * 用法： node scripts/launch.mjs tools/verify-update-flow.js [release目录]
 */

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { app, dialog } = require('electron');

const PREFIX = 'FLOW ';
const PORT = 28930;
const shellRoot = path.resolve(__dirname, '..');
const releaseDirectory = path.resolve(process.argv[2] ?? path.join(shellRoot, 'release'));
// 只走本地源：不真装到系统目录，避免把测试机的正式版本覆盖掉。
const INSTALL = process.env.ENDAXIS_FLOW_INSTALL === '1';

const log = message => console.log(`${PREFIX}${message}`);

function startServer() {
  const server = http.createServer((request, response) => {
    const requested = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname);
    const target = path.join(releaseDirectory, path.basename(requested));
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      response.writeHead(404).end('not found');
      return;
    }
    const stats = fs.statSync(target);
    response.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': stats.size,
      'Accept-Ranges': 'bytes',
    });
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    fs.createReadStream(target).pipe(response);
  });
  return new Promise(resolve => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

/** 把对话框换成自动应答，并记录每次弹出的内容。 */
const prompts = [];
function stubDialogs() {
  const original = dialog.showMessageBox.bind(dialog);
  dialog.showMessageBox = async (target, options) => {
    const normalized = options ?? target;
    const buttons = normalized?.buttons ?? [];
    const chosen = 0; // 第一个按钮就是"现在下载"/"重启并安装"
    prompts.push({ title: normalized?.title, message: normalized?.message, buttons, chosen });
    log(`对话框：「${normalized?.title}」→ 选择「${buttons[chosen] ?? '(无按钮)'}」`);
    return { response: chosen, checkboxChecked: false };
  };
  return () => {
    dialog.showMessageBox = original;
  };
}

app.whenReady().then(async () => {
  let exitCode = 1;
  let server = null;
  let restoreDialogs = null;
  const failures = [];

  try {
    const manifestPath = path.join(releaseDirectory, 'latest.yml');
    if (!fs.existsSync(manifestPath)) throw new Error(`缺少 ${manifestPath}`);
    const sourceVersion = /^version:\s*(.+)$/m
      .exec(fs.readFileSync(manifestPath, 'utf8'))?.[1]
      ?.trim();
    log(`源目录=${releaseDirectory} 源版本=${sourceVersion}`);

    server = await startServer();
    restoreDialogs = stubDialogs();

    const { createUpdater } = require('../src/main/updater');
    const { backupUserData } = require('../src/main/updater');

    // 用一个假的"当前版本"参与比较：必须低于源版本才会触发更新。
    const simulated = '0.0.1';
    app.getVersion = () => simulated;
    log(`模拟当前版本=${simulated}`);

    const updater = createUpdater({
      window: null,
      isDevelopment: false,
      getStrings: () => ({
        availableTitle: '发现新版本',
        availableBody: (v, c) => `新版本 ${v}（当前 ${c}）已发布。`,
        download: '现在下载',
        later: '稍后',
        skipVersion: '跳过此版本',
        installTitle: '更新已就绪',
        installBody: v => `版本 ${v} 已下载完成。现在重启并安装吗？`,
        installNow: '重启并安装',
        installLater: '稍后（下次启动时安装）',
        installNote: '安装前会自动备份你的排轴项目数据。',
        backedUp: dir => `已备份项目数据到：\n${dir}`,
        backupFailed: '数据备份失败',
        downloadFailedTitle: '下载失败',
        downloadFailedBody: '更新包下载失败，请稍后重试。',
        releaseNotes: '更新说明',
        checkNow: '检查更新',
        upToDateTitle: '已是最新版本',
        upToDateBody: v => `当前版本 ${v} 已是最新。`,
        ok: '确定',
        rateLimitedHint: '',
      }),
    });

    // 让 updater 指向本地源。
    const { autoUpdater } = require('electron-updater');
    autoUpdater.forceDevUpdateConfig = true;
    autoUpdater.setFeedURL({ provider: 'generic', url: `http://127.0.0.1:${PORT}/` });
    autoUpdater.autoDownload = false;

    // 备份目录基线。
    const backupRoot = path.join(app.getPath('userData'), 'data-backups');
    const before = fs.existsSync(backupRoot) ? fs.readdirSync(backupRoot) : [];
    log(`备份目录基线：${before.length} 个`);

    // 走手动检查这条路：会弹「发现新版本」→ 我们自动选「现在下载」。
    log('调用 checkForUpdatesManually()');
    updater.checkForUpdatesManually();

    // 等下载完成（大文件，给足时间）。
    const deadline = Date.now() + 300_000;
    let sawDownloaded = false;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      if (updater.getState() === 'downloaded') {
        sawDownloaded = true;
        break;
      }
      log(`状态=${updater.getState()}`);
    }
    log(`观察到 downloaded 状态：${sawDownloaded}`);
    if (!sawDownloaded) failures.push('没有走到"下载完成"状态');

    // 等安装确认对话框出现（它由 update-downloaded 触发）。
    await new Promise(resolve => setTimeout(resolve, 8000));
    const installPrompt = prompts.find(entry => entry.title === '更新已就绪');
    log(`安装对话框是否出现：${installPrompt !== undefined}`);
    if (installPrompt === undefined) failures.push('没有出现"更新已就绪"对话框');

    // 备份结果：promptForInstall 在选择安装后调用 backupUserData 并弹「已备份…」。
    const backedUp = prompts.find(
      entry => typeof entry.message === 'string' && entry.message.includes('已备份项目数据到'),
    );
    const after = fs.existsSync(backupRoot) ? fs.readdirSync(backupRoot) : [];
    log(`备份目录现在：${after.length} 个（新增 ${after.length - before.length}）`);
    if (after.length <= before.length) failures.push('安装确认后没有产生新的数据备份');
    log(`备份提示框：${backedUp === undefined ? '未出现' : backedUp.message.replace(/\n/g, ' ')}`);

    // 直接验证 backupUserData 的返回值（不依赖弹窗）。
    const direct = backupUserData();
    log(
      `backupUserData() 直接调用：ok=${direct.ok} reason=${direct.reason ?? '-'} dir=${direct.directory ?? '-'}`,
    );

    log(`对话框共 ${prompts.length} 次：`);
    for (const entry of prompts) log(`  - 「${entry.title}」按钮=[${entry.buttons.join(', ')}]`);

    if (!INSTALL) log('（未执行真实安装；如需真装请设 ENDAXIS_FLOW_INSTALL=1）');

    log('');
    if (failures.length === 0) {
      log('通过：检查 → 提示 → 下载 → 提示安装 → 备份，整条链路走通。');
      exitCode = 0;
    } else {
      log('失败：');
      for (const message of failures) log(`  - ${message}`);
    }
  } catch (error) {
    log(`异常：${error?.stack ?? error}`);
  } finally {
    restoreDialogs?.();
    await new Promise(resolve => server?.close(resolve) ?? resolve());
    // 不在这里 quitAndInstall：真实安装会替换测试机版本，交给调用方决定。
    app.exit(exitCode);
  }
});
