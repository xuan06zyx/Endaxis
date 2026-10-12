'use strict';

/**
 * 验证"固定端口被占用"时的行为。
 *
 * 这是数据安全的关键约束：项目存档按 origin（含端口）隔离，**换端口 = 读不到
 * 自己的项目**。所以端口被占用时必须报错退出，绝不能悄悄换个端口继续跑。
 *
 * 断言：
 *   1. 正常情况下服务起在固定端口上；
 *   2. 端口被占用时抛 PortUnavailableError，且**不会**起在别的端口；
 *   3. 错误里带上端口号，便于提示用户。
 *
 * 用 `ENDAXIS_SERVER_PORT` 指到一个空闲高位端口，避免动到真实用户的 17321。
 *
 * 用法： npm run verify:port-conflict
 */

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');

const { startStaticServer, PortUnavailableError } = require('../src/main/server');

const DIST_DIRECTORY = path.resolve(__dirname, '..', 'webapp');
/** 高位端口，避开 Windows 保留区间。 */
const TEST_PORT = 28901;

const failures = [];
const record = (condition, message) => {
  if (!condition) failures.push(message);
};

/** 占住端口，模拟"另一个进程/实例正在使用"。 */
function occupyPort(port) {
  return new Promise((resolve, reject) => {
    const blocker = http.createServer((_request, response) => response.writeHead(200).end('busy'));
    blocker.once('error', reject);
    blocker.listen(port, '127.0.0.1', () => resolve(blocker));
  });
}

app.whenReady().then(async () => {
  let exitCode = 1;
  let blocker = null;
  let server = null;
  const originalPort = process.env.ENDAXIS_SERVER_PORT;

  try {
    record(
      fs.existsSync(path.join(DIST_DIRECTORY, 'index.html')),
      'webapp/index.html 不存在，请先运行 npm run prepare:dist',
    );
    process.env.ENDAXIS_SERVER_PORT = String(TEST_PORT);

    // ── 1. 正常情况下起在指定端口 ────────────────────────────────────────
    server = await startStaticServer(DIST_DIRECTORY);
    console.log(`[port-test] 正常启动 → ${server.origin}`);
    record(server.origin === `http://127.0.0.1:${TEST_PORT}`, `没有起在指定端口：${server.origin}`);
    await server.close();
    server = null;

    // ── 2. 端口被占用：必须抛错，且不能换端口 ─────────────────────────────
    blocker = await occupyPort(TEST_PORT);
    console.log(`[port-test] 已用占位服务占住 ${TEST_PORT}`);
    const startedAt = Date.now();
    let thrown = null;
    try {
      server = await startStaticServer(DIST_DIRECTORY);
      console.log(`[port-test] 意外返回：${server.origin}`);
    } catch (error) {
      thrown = error;
    }
    const elapsed = Date.now() - startedAt;
    console.log(
      `[port-test] 占用时结果：${thrown === null ? '未抛错' : thrown.name}（等待 ${elapsed}ms）`,
    );

    record(thrown !== null, '端口被占用时没有抛错——可能悄悄换了端口，用户会读不到自己的项目');
    record(
      thrown instanceof PortUnavailableError,
      `抛出的不是 PortUnavailableError：${thrown?.name ?? '(无)'}`,
    );
    record(thrown?.port === TEST_PORT, `错误里的端口号不对：${thrown?.port}（期望 ${TEST_PORT}）`);
    record(server === null, '端口被占用时仍然启动了服务');

    if (failures.length === 0) {
      console.log('[port-test] 通过：端口占用时明确报错，不会换端口继续跑。');
      exitCode = 0;
    } else {
      console.error('[port-test] 失败：');
      for (const message of failures) console.error(`  - ${message}`);
    }
  } catch (error) {
    console.error(`[port-test] ${error instanceof Error ? error.stack : error}`);
  } finally {
    if (originalPort === undefined) delete process.env.ENDAXIS_SERVER_PORT;
    else process.env.ENDAXIS_SERVER_PORT = originalPort;
    await server?.close().catch(() => {});
    await new Promise(resolve => blocker?.close(resolve) ?? resolve());
    app.exit(exitCode);
  }
});
