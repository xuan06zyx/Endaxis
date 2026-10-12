'use strict';

/**
 * 启动探针：验证 `npm start` 这条真实路径确实显示出窗口。
 *
 * 与 verify-app.js 的区别：verify-app 自己建窗口，验证的是"页面能不能跑"；
 * 这里启动的是真正的主进程入口，验证的是"用户双击后有没有窗口出现"。
 *
 * 主进程在 ENDAXIS_STARTUP_PROBE=1 时会打印一行 `ENDAXIS_PROBE {...}` 启动报告，
 * 见 src/main/index.js 的 reportStartupProbe；同时也会把同一份报告写进它自己的
 * `userData/startup-probe.json`，供打包版本（没有控制台）排查。
 *
 * 用法： npm run verify:window
 */

const path = require('node:path');
const { spawn } = require('node:child_process');
const { app } = require('electron');

const SHELL_ROOT = path.resolve(__dirname, '..');
const ELECTRON_BINARY = path.join(
  SHELL_ROOT,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron',
);

const PROBE_PREFIX = 'ENDAXIS_PROBE ';
/** 要比主进程探针自己的就绪超时（60s）宽，否则会在它给出结论前先放弃。 */
const STARTUP_TIMEOUT_MS = 120_000;
/** stdout 到达后，等主进程把报告文件和退出流程处理完，避免提前 kill。 */
const SETTLE_DELAY_MS = 800;

/**
 * 这段代码本身跑在 Electron 主进程里，但只负责拉起子进程并读它的 stdout，
 * 不创建任何窗口。
 */
function runProbe() {
  return new Promise((resolve, reject) => {
    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;

    // 探针开关用命令行参数传递：从另一个 Electron 进程 spawn 时环境变量不一定
    // 传得进来（实测过），命令行参数则总是可靠。
    const child = spawn(ELECTRON_BINARY, ['.', '--endaxis-startup-probe'], {
      cwd: SHELL_ROOT,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let settleTimer = null;

    const finish = (error, report) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(settleTimer);
      child.kill();
      if (error) reject(error);
      else resolve(report);
    };

    const timeout = setTimeout(() => {
      finish(
        new Error(
          `等待启动探针超时（${STARTUP_TIMEOUT_MS}ms）。\n` +
            `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
        ),
      );
    }, STARTUP_TIMEOUT_MS);

    child.stdout.on('data', chunk => {
      const text = chunk.toString();
      stdout += text;
      if (settled) return;
      const line = stdout.split(/\r?\n/).find(value => value.startsWith(PROBE_PREFIX));
      if (line === undefined) return;
      let report;
      try {
        report = JSON.parse(line.slice(PROBE_PREFIX.length));
      } catch (error) {
        finish(new Error(`探针输出无法解析：${line}\n${error.message}`));
        return;
      }
      // 报告已经拿到，但主进程还要写文件再退出；稍等再收尾。
      // 清掉总超时，并让 exit 处理器知道"成功路径已经在走"，不要抢答。
      clearTimeout(timeout);
      settleTimer = setTimeout(() => finish(null, report), SETTLE_DELAY_MS);
    });

    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });

    child.on('exit', (code, signal) => {
      // 报告已经解析出来时，退出是预期行为，交给 settleTimer 收尾。
      if (settleTimer !== null) return;
      finish(
        new Error(
          `主进程在写出启动报告前退出（code=${code}, signal=${signal}）。\n` +
            `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
        ),
      );
    });

    child.on('error', error => finish(error));
  });
}

app.whenReady().then(async () => {
  let exitCode = 1;
  try {
    const report = await runProbe();
    console.log('[verify:window] 探针结果：');
    console.log(JSON.stringify(report, null, 2));

    const failures = [];
    if (report.visible !== true) failures.push('窗口没有显示（show() 未生效）');
    if (report.destroyed === true) failures.push('窗口在探针检查前已被销毁');
    if (typeof report.url !== 'string' || !report.url.includes('/timeline')) {
      failures.push(`History 路由没有生效：${report.url}`);
    }
    if (typeof report.title !== 'string' || !report.title.includes('Endaxis')) {
      failures.push(`窗口标题异常：${report.title}`);
    }
    // 仍是占位标题，说明页面没有解析完成（真实标题由 index.html 提供）。
    if (typeof report.title === 'string' && report.title.startsWith('Endaxis —')) {
      failures.push('窗口仍是占位标题，页面未完成加载');
    }

    if (failures.length === 0) {
      console.log('[verify:window] 通过：启动路径会正常显示应用窗口。');
      exitCode = 0;
    } else {
      console.error('[verify:window] 失败：');
      for (const message of failures) console.error(`  - ${message}`);
    }
  } catch (error) {
    console.error(`[verify:window] ${error instanceof Error ? error.message : error}`);
  } finally {
    app.exit(exitCode);
  }
});
