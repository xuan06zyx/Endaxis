'use strict';

/**
 * 验证"客户端能否收到更新提醒"。
 *
 * 这是整条更新链路里最容易出错的一环，也是最该实测的一环：Release 传上去了、
 * 文件能下载，**不等于** electron-updater 认得它。这里让 electron-updater
 * 真的去查询线上 Release，报告它发现的版本。
 *
 * 只做检查，**不下载安装包**（117 MB，没必要），也不安装。
 *
 * 用法： node scripts/launch.mjs tools/verify-update-available.js <owner> <repo> [期望版本]
 *   node scripts/launch.mjs tools/verify-update-available.js xuan06zyx Endaxis 1.0.1
 */

const path = require('node:path');
const { app } = require('electron');

const [owner, repo, expectedVersion] = process.argv.slice(2);
if (!owner || !repo) {
  console.error('用法：verify-update-available.js <owner> <repo> [期望版本]');
  app.exit(2);
}

const PREFIX = 'UPDATE_CHECK ';
const TIMEOUT_MS = 90_000;

/** 让 electron-updater 以"当前版本"参与比较——由调用方通过环境变量指定。 */
const simulateVersion = process.env.ENDAXIS_SIMULATE_VERSION?.trim();

app.whenReady().then(async () => {
  const { autoUpdater } = require('electron-updater');

  if (simulateVersion) {
    // 只有 downgrade 才能观察到"有更新"；直接改 app.getVersion 的返回值。
    app.getVersion = () => simulateVersion;
  }

  const current = app.getVersion();
  console.log(`${PREFIX}当前版本=${current} 更新源=${owner}/${repo}`);

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = null;
  autoUpdater.setFeedURL({ provider: 'github', owner, repo });

  const finish = (payload, code) => {
    console.log(`${PREFIX}RESULT ${JSON.stringify(payload)}`);
    setTimeout(() => app.exit(code), 100);
  };

  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    finish({ outcome: 'timeout', currentVersion: current }, 1);
  }, TIMEOUT_MS);

  autoUpdater.on('update-available', info => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    finish(
      { outcome: 'available', currentVersion: current, availableVersion: info?.version ?? null },
      0,
    );
  });

  autoUpdater.on('update-not-available', info => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    finish(
      { outcome: 'up-to-date', currentVersion: current, latestVersion: info?.version ?? null },
      0,
    );
  });

  autoUpdater.on('error', error => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    finish(
      { outcome: 'error', currentVersion: current, error: String(error?.message ?? error) },
      1,
    );
  });

  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    finish({ outcome: 'threw', error: String(error?.message ?? error) }, 1);
  }
});
