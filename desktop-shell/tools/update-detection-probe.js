'use strict';

/**
 * 单场景探针：用本地源检查一次更新，报告结论后退出。
 *
 * 必须一次进程只跑一个场景：electron-updater 会**缓存检查结果**，
 * 同一进程里连续检查不同版本号会拿到缓存（实测踩过：第二个场景起就失真）。
 * 编排交给 tools/verify-update-detection.js。
 *
 * 环境变量：
 *   ENDAXIS_SIMULATE_VERSION  参与比较的"当前版本"
 *   ENDAXIS_FEED_PORT         本地更新源端口
 *   ENDAXIS_RELEASE_DIR       含 latest.yml 的目录
 */

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { app } = require('electron');

const PREFIX = 'DETECT_ONE ';
const TIMEOUT_MS = 30_000;

const simulateVersion = process.env.ENDAXIS_SIMULATE_VERSION?.trim() ?? '0.0.0';
const port = Number.parseInt(process.env.ENDAXIS_FEED_PORT ?? '28902', 10);
const releaseDirectory = path.resolve(
  process.env.ENDAXIS_RELEASE_DIR ?? path.join(__dirname, '..', 'release'),
);

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
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(server)));
}

app.whenReady().then(async () => {
  const server = await startServer();
  const { autoUpdater } = require('electron-updater');

  app.getVersion = () => simulateVersion;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = null;
  // 未打包时必须显式允许，否则 electron-updater 直接跳过检查
  // （日志：Skip checkForUpdates because application is not packed）。
  autoUpdater.forceDevUpdateConfig = true;
  autoUpdater.setFeedURL({ provider: 'generic', url: `http://127.0.0.1:${port}/` });

  const finish = (payload, code) => {
    console.log(`${PREFIX}RESULT ${JSON.stringify(payload)}`);
    server.close();
    setTimeout(() => app.exit(code), 100);
  };

  let settled = false;
  const done = payload => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    finish(payload, 0);
  };
  const timer = setTimeout(() => done({ outcome: 'timeout' }), TIMEOUT_MS);

  autoUpdater.on('update-available', info =>
    done({ outcome: 'available', availableVersion: info?.version ?? null }),
  );
  autoUpdater.on('update-not-available', info =>
    done({ outcome: 'up-to-date', latestVersion: info?.version ?? null }),
  );
  autoUpdater.on('error', error =>
    done({ outcome: 'error', error: String(error?.message ?? error) }),
  );

  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    done({ outcome: 'threw', error: String(error?.message ?? error) });
  }
});
