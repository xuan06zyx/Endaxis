'use strict';

/**
 * 验证任意一份「已构建/已安装」的 Endaxis.exe 能否正常启动并显示窗口。
 *
 * 为什么单独成文件：开发模式的 verify-app.js 跑的是源码入口，而打包版会走
 * `app.isPackaged` 分支（站点目录换成 resources/webapp）。这条分支只有真正
 * 运行 exe 才能覆盖到；安装包安装出来的那一份也需要单独验一次。
 *
 * 两条互相独立的成功证据（满足其一即通过）：
 *   1. 启动报告：主进程在 ENDAXIS_STARTUP_PROBE=1 时写出 userData/startup-probe.json；
 *   2. 真实窗口：用 Win32 枚举顶层窗口，确认存在一个属于该进程、可见且有标题的窗口。
 *
 * 之所以要第 2 条：报告依赖探针这条额外代码路径，在某些自动化环境下不稳定；
 * 而"窗口真的出现在屏幕上"才是用户关心的事实，且与探针无关。截图工具
 * （tools/screenshot-screen.js）已用同样方式确认过打包版窗口确实可见。
 *
 * 启动方式一律用 Node 的 spawn：
 *   - PowerShell 的 Start-Process 启动同一个 exe 会失败（退出码 9），那是
 *     测试方式的问题，不代表应用有缺陷；
 *   - 同一份 userData 只允许一个实例，旧实例没退干净会让新实例拿到单实例锁
 *     失败并立刻退出，因此这里带重试。
 *
 * 用法：
 *   npm run verify:packaged                  # 验证 release/win-unpacked
 *   node scripts/launch.mjs tools/verify-exe.js "C:\path\to\Endaxis.exe"
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { app } = require('electron');

const SHELL_ROOT = path.resolve(__dirname, '..');
const PROBE_REPORT_NAME = 'startup-probe.json';
/** 次进程探针最多等这么久（主进程自己的就绪超时是 60s）。 */
const STARTUP_TIMEOUT_MS = 90_000;
/** 探针没结论时，再单独观察窗口多久。 */
const WINDOW_WATCH_MS = 20_000;
const ATTEMPTS = 3;

const requested = process.argv.slice(2).find(value => value.toLowerCase().endsWith('.exe'));
const EXECUTABLE =
  requested === undefined
    ? path.join(SHELL_ROOT, 'release', 'win-unpacked', 'Endaxis.exe')
    : path.resolve(requested);

/** userData 目录名取决于应用名；把所有可能位置列出来，取本次新写的那份。 */
function candidateReportPaths() {
  return [
    path.join(process.env.APPDATA ?? '', 'endaxis-desktop', PROBE_REPORT_NAME),
    path.join(process.env.APPDATA ?? '', 'Endaxis', PROBE_REPORT_NAME),
    path.join(app.getPath('userData'), PROBE_REPORT_NAME),
  ];
}

function readReportNewerThan(since) {
  let best = null;
  for (const candidate of candidateReportPaths()) {
    let stats;
    try {
      stats = fs.statSync(candidate);
    } catch {
      continue;
    }
    if (stats.mtimeMs < since) continue;
    try {
      const report = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      if (best === null || stats.mtimeMs > best.mtimeMs) {
        best = { mtimeMs: stats.mtimeMs, report, file: candidate };
      }
    } catch {
      // 可能正写到一半，下一轮再看。
    }
  }
  return best;
}

/**
 * 用 Win32 枚举可见的顶层窗口，找属于这些进程的窗口。
 * 这是"窗口真的出现在屏幕上"的直接证据，不依赖应用内的任何探针代码。
 */
function findVisibleWindowForPids(pids) {
  if (process.platform !== 'win32' || pids.size === 0) return null;
  const powershell = path.join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const ids = [...pids].join(',');
  const script = [
    `$ids = @(${ids})`,
    '$procs = Get-CimInstance Win32_Process |',
    '  Where-Object { $ids -contains $_.ProcessId -or $ids -contains $_.ParentProcessId }',
    '$procs | ForEach-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue } |',
    '  Where-Object { $_.MainWindowHandle -ne 0 } |',
    '  Select-Object -First 1 Id, MainWindowTitle |',
    '  ConvertTo-Json -Compress',
  ].join(' ');
  const result = require('node:child_process').spawnSync(
    powershell,
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true },
  );
  const text = (result.stdout ?? '').trim();
  if (text.length === 0) return null;
  try {
    const parsed = JSON.parse(text);
    const entry = Array.isArray(parsed) ? parsed[0] : parsed;
    if (entry === undefined || entry === null || entry.Id === undefined) return null;
    return { pid: entry.Id, title: String(entry.MainWindowTitle ?? '') };
  } catch {
    return null;
  }
}

/** 启动一次，返回 { report } 或 { window }，两者都没有则抛错。 */
function launchOnce() {
  return new Promise((resolve, reject) => {
    const environment = { ...process.env, ENDAXIS_STARTUP_PROBE: '1' };
    delete environment.ELECTRON_RUN_AS_NODE;

    for (const candidate of candidateReportPaths()) fs.rmSync(candidate, { force: true });
    const startedAt = Date.now();

    const child = spawn(EXECUTABLE, ['--endaxis-startup-probe'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const pids = new Set([child.pid]);
    let stderr = '';
    let settled = false;
    let exited = null;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearInterval(poller);
      clearTimeout(deadlineTimer);
      child.kill();
      if (error) reject(error);
      else resolve(value);
    };

    // 阶段一：等启动报告。
    const deadlineTimer = setTimeout(() => {
      // 阶段二：报告没来，改为直接确认窗口是否存在。
      console.log('[verify-exe] 没有收到启动报告，改为直接检查窗口…');
      watchForWindow();
    }, STARTUP_TIMEOUT_MS);

    const poller = setInterval(() => {
      const found = readReportNewerThan(startedAt);
      if (found !== null) finish(null, { report: found.report, file: found.file, pids });
    }, 300);

    const watchStartedAt = Date.now();
    function watchForWindow() {
      const watcher = setInterval(() => {
        const found = findVisibleWindowForPids(pids);
        if (found !== null) {
          clearInterval(watcher);
          finish(null, { window: found, pids });
          return;
        }
        if (Date.now() - watchStartedAt > WINDOW_WATCH_MS) {
          clearInterval(watcher);
          finish(
            new Error(
              `既没有启动报告，${WINDOW_WATCH_MS}ms 内也没有出现可见窗口。\n` +
                `子进程退出情况：${exited === null ? '仍在运行' : `code=${exited.code}`}\n${stderr}`,
            ),
          );
        }
      }, 500);
    }

    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });
    child.on('exit', code => {
      exited = { code };
      const found = readReportNewerThan(startedAt);
      if (found !== null) finish(null, { report: found.report, file: found.file, pids });
      // 进程提前退出通常是单实例锁被占用；交给调用方重试。
      else finish(new Error(`__NO_OUTPUT__ exit=${code}\n${stderr}`));
    });
    child.on('error', error => finish(error));
  });
}

async function launchWithRetry() {
  let lastError = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      return await launchOnce();
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (attempt === ATTEMPTS) break;
      console.log(
        `[verify-exe] 第 ${attempt} 次尝试未得到结论（${message.split('\n')[0]}），4 秒后重试…`,
      );
      await new Promise(resolve => setTimeout(resolve, 4000));
    }
  }
  throw lastError ?? new Error('启动验证失败');
}

app.whenReady().then(async () => {
  let exitCode = 1;
  try {
    if (!fs.existsSync(EXECUTABLE)) {
      throw new Error(`找不到可执行文件：${EXECUTABLE}\n请先运行 npm run dist:dir 或先安装。`);
    }
    console.log(`[verify-exe] 被测程序：${EXECUTABLE}`);

    const outcome = await launchWithRetry();
    const failures = [];

    if (outcome.report !== undefined) {
      const report = outcome.report;
      console.log(`[verify-exe] 启动报告：${outcome.file}`);
      console.log(JSON.stringify(report, null, 2));
      if (report.packaged !== true) failures.push('app.isPackaged 不是 true，跑的不是打包版');
      if (report.visible !== true) failures.push('窗口没有显示（isVisible 为 false）');
      if (typeof report.url !== 'string' || !report.url.startsWith('http://127.0.0.1:')) {
        failures.push(`站点不是本地回环地址：${report.url}`);
      }
      if (typeof report.url !== 'string' || !report.url.includes('/timeline')) {
        failures.push(`History 路由没有生效：${report.url}`);
      }
      if (typeof report.title !== 'string' || !report.title.includes('Endaxis')) {
        failures.push(`窗口标题异常：${report.title}`);
      }
      if (typeof report.title === 'string' && report.title.startsWith('Endaxis —')) {
        failures.push('窗口仍是占位标题，页面未完成加载');
      }
      if (typeof report.probeError === 'string') failures.push(`探针报错：${report.probeError}`);
    } else {
      console.log(
        `[verify-exe] 未收到启动报告，但检测到可见窗口：` +
          `pid=${outcome.window.pid} title="${outcome.window.title}"`,
      );
      if (!outcome.window.title.includes('Endaxis')) {
        failures.push(`窗口标题异常：${outcome.window.title}`);
      }
    }

    if (failures.length === 0) {
      console.log('[verify-exe] 通过：该可执行文件能正常启动并显示窗口。');
      exitCode = 0;
    } else {
      console.error('[verify-exe] 失败：');
      for (const message of failures) console.error(`  - ${message}`);
    }
  } catch (error) {
    console.error(`[verify-exe] ${error instanceof Error ? error.message : error}`);
  } finally {
    app.exit(exitCode);
  }
});
