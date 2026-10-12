'use strict';

/**
 * 自动更新端到端验证。
 *
 * 做真事：起一个本地静态更新源，用它替换被测程序的 app-update.yml，然后让
 * 旧版本（默认 release/win-unpacked）去检查更新、下载新版本、验证安装前的
 * 数据备份。**不执行安装**——安装会真的替换掉被测程序。
 *
 * 为什么不用 PowerShell 的 Start-Process：实测它不保证把环境变量传给子进程，
 * 会让"更新功能静默失效"这类问题看起来像"应用起不来"。这里全程用 spawn。
 *
 * 用法（需要先准备好两个版本的安装包，见 README「验证自动更新」）：
 *   node scripts/launch.mjs tools/verify-update.js \
 *        --baseline <旧版本目录> --feed <含 latest.yml 的目录> [--port 18377]
 */

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { app } = require('electron');

const PROBE_REPORT_NAME = 'update-probe.json';
const TRACE_NAME = 'endaxis-update-trace.log';
const TIMEOUT_MS = 300_000;
/**
 * 端口要避开 Windows 的保留区间（`netsh int ipv4 show excludedportrange`）。
 * 8294–9141 这段默认被 Hyper-V 占着，用它会直接 EACCES。
 */
const DEFAULT_PORT = 18377;

function readArgument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

const baselineDirectory = path.resolve(
  readArgument('baseline', path.join(__dirname, '..', 'release', 'win-unpacked')),
);
const feedDirectory = path.resolve(readArgument('feed', ''));
const port = Number.parseInt(readArgument('port', String(DEFAULT_PORT)), 10);
const probeReportPath = path.join(process.env.APPDATA ?? '', 'endaxis-desktop', PROBE_REPORT_NAME);
const tracePath = path.join(require('node:os').tmpdir(), TRACE_NAME);

/** 极简静态服务器：electron-updater 的 generic provider 只要普通 GET。 */
function startFeedServer(directory) {
  const server = http.createServer((request, response) => {
    const requested = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname);
    const target = path.resolve(directory, `.${path.posix.normalize(requested)}`);
    if (
      !target.startsWith(path.resolve(directory)) ||
      !fs.existsSync(target) ||
      !fs.statSync(target).isFile()
    ) {
      response.writeHead(404).end('not found');
      return;
    }
    const size = fs.statSync(target).size;
    console.log(`  [feed] 200 ${requested} (${(size / 1024 / 1024).toFixed(1)} MB)`);
    response.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': size,
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(target).pipe(response);
  });
  return new Promise(resolve => {
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function locateElectronRuntime() {
  const candidates = [
    path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron.exe'),
    path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron'),
  ];
  return candidates.find(candidate => fs.existsSync(candidate)) ?? null;
}

app.whenReady().then(async () => {
  let exitCode = 1;
  let server = null;
  let child = null;

  try {
    const executable = path.join(baselineDirectory, 'Endaxis.exe');
    if (!fs.existsSync(executable)) {
      throw new Error(
        `找不到被测程序：${executable}\n请先用 --baseline 指定旧版本目录（含 Endaxis.exe）。`,
      );
    }
    if (!fs.existsSync(path.join(feedDirectory, 'latest.yml'))) {
      throw new Error(
        `更新源目录里没有 latest.yml：${feedDirectory}\n请用 --feed 指定含 latest.yml 与新安装包的目录。`,
      );
    }

    const latest = fs.readFileSync(path.join(feedDirectory, 'latest.yml'), 'utf8');
    const feedVersion = /^version:\s*(.+)$/m.exec(latest)?.[1]?.trim() ?? '(未知)';
    console.log(`[verify-update] 被测程序：${executable}`);
    console.log(`[verify-update] 更新源：${feedDirectory}（提供版本 ${feedVersion}）`);

    // 把被测程序的更新源指向本地服务器（只动副本，不动用户的安装）。
    const updateConfig = path.join(baselineDirectory, 'resources', 'app-update.yml');
    fs.writeFileSync(
      updateConfig,
      `provider: generic\nurl: http://127.0.0.1:${port}/\nupdaterCacheDirName: endaxis-desktop-updater\n`,
      'utf8',
    );
    console.log(`[verify-update] 已重写 ${updateConfig}`);

    server = await startFeedServer(feedDirectory);
    console.log(`[verify-update] 本地更新源已就绪：http://127.0.0.1:${port}/`);

    // 清掉上次的痕迹，避免读到旧报告当成新结果。
    fs.rmSync(probeReportPath, { force: true });
    fs.rmSync(tracePath, { force: true });

    // 必须显式把 environment 传给 spawn：早期版本漏了这一项，环境变量根本没到
    // 子进程，表现就是"更新探针永远不写报告"。
    const environment = { ...process.env, ENDAXIS_UPDATE_PROBE: '1' };
    delete environment.ELECTRON_RUN_AS_NODE;
    console.log('[verify-update] 启动被测程序（更新探针模式：自动检查 + 下载 + 备份，不安装）…');
    child = spawn(executable, [], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });

    const deadline = Date.now() + TIMEOUT_MS;
    let report = null;
    while (Date.now() < deadline) {
      if (fs.existsSync(probeReportPath)) {
        try {
          report = JSON.parse(fs.readFileSync(probeReportPath, 'utf8'));
          break;
        } catch {
          // 可能正写到一半。
        }
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    if (fs.existsSync(tracePath)) {
      console.log('\n[verify-update] 更新链路轨迹：');
      for (const line of fs.readFileSync(tracePath, 'utf8').trim().split('\n')) {
        console.log(`  ${line}`);
      }
    }

    if (report === null) {
      throw new Error(`等待更新探针报告超时（${TIMEOUT_MS}ms）。\nstderr:\n${stderr}`);
    }

    console.log('\n[verify-update] 探针报告：');
    console.log(JSON.stringify(report, null, 2));

    const failures = [];
    if (report.packaged !== true) failures.push('被测程序不是打包版');
    if (report.availableVersion === null || report.availableVersion === undefined) {
      failures.push('没有发现新版本（可用版本为空）');
    } else if (report.availableVersion !== feedVersion) {
      failures.push(`发现的版本 ${report.availableVersion} 与更新源声明的 ${feedVersion} 不一致`);
    }
    if (report.downloaded !== true) failures.push('更新包没有下载完成（可能校验失败）');
    if (report.backup === null || report.backup?.ok !== true) {
      failures.push(`安装前数据备份失败：${JSON.stringify(report.backup)}`);
    } else if (!(report.backup.fileCount > 0)) {
      failures.push('备份目录是空的');
    }
    if (typeof report.error === 'string' && report.error.length > 0) {
      failures.push(`更新过程报错：${report.error}`);
    }

    if (failures.length === 0) {
      console.log('\n[verify-update] 通过：检查更新 → 下载校验 → 安装前备份 全部走通。');
      console.log(
        `[verify-update] 备份位置：${report.backup.directory}（${report.backup.fileCount} 个文件）`,
      );
      exitCode = 0;
    } else {
      console.error('\n[verify-update] 失败：');
      for (const message of failures) console.error(`  - ${message}`);
    }
  } catch (error) {
    console.error(`[verify-update] ${error instanceof Error ? error.message : error}`);
  } finally {
    child?.kill();
    server?.close();
    app.exit(exitCode);
  }
});
