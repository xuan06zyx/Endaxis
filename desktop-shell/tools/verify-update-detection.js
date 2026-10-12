'use strict';

/**
 * 验证"客户端能否收到更新提醒"（更新检测逻辑 + 线上 Release 可用性）。
 *
 * 两个层次：
 *   1. **检测逻辑**：用本地源喂与 GitHub Release 完全相同的资产
 *      （release/latest.yml + 安装包），逐场景起独立进程检查版本比较是否正确；
 *   2. **线上可用性**（加 --online）：不带凭据读线上 Release，确认客户端真能拿到。
 *
 * 为什么每个场景要独立进程：electron-updater 会缓存检查结果，同进程内连续
 * 检查不同"当前版本"会拿到缓存——实测第二个场景起就失真。
 *
 * 只检查，不下载安装包，不安装。
 *
 * 用法： npm run verify:update-detection
 *       node scripts/launch.mjs tools/verify-update-detection.js --online xuan06zyx Endaxis
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { app } = require('electron');

const SHELL_ROOT = path.resolve(__dirname, '..');
const PROBE = path.join(__dirname, 'update-detection-probe.js');
const ELECTRON_BINARY = path.join(
  SHELL_ROOT,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron',
);
const RELEASE_DIRECTORY = path.join(SHELL_ROOT, 'release');
const PREFIX = 'DETECT_ONE ';
const CHILD_TIMEOUT_MS = 90_000;

const onlineIndex = process.argv.indexOf('--online');
const online =
  onlineIndex === -1
    ? null
    : { owner: process.argv[onlineIndex + 1], repo: process.argv[onlineIndex + 2] };

/** 起一个独立进程跑单个场景。 */
function runProbe(version, port) {
  return new Promise((resolve, reject) => {
    const environment = {
      ...process.env,
      ENDAXIS_SIMULATE_VERSION: version,
      ENDAXIS_FEED_PORT: String(port),
      ENDAXIS_RELEASE_DIR: RELEASE_DIRECTORY,
    };
    delete environment.ELECTRON_RUN_AS_NODE;

    const child = spawn(ELECTRON_BINARY, [PROBE], {
      cwd: SHELL_ROOT,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(
      () => finish(new Error(`场景 ${version} 超时\n${stdout}\n${stderr}`)),
      CHILD_TIMEOUT_MS,
    );

    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });
    child.on('error', error => finish(error));
    child.on('exit', () => {
      const line = stdout.split(/\r?\n/).find(value => value.startsWith(`${PREFIX}RESULT `));
      if (line === undefined) {
        finish(new Error(`场景 ${version} 没有输出结论\n${stdout}\n${stderr}`));
        return;
      }
      try {
        finish(null, JSON.parse(line.slice(`${PREFIX}RESULT `.length)));
      } catch {
        finish(new Error(`场景 ${version} 结论无法解析：${line}`));
      }
    });
  });
}

async function verifyDetection() {
  const manifestPath = path.join(RELEASE_DIRECTORY, 'latest.yml');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`缺少 ${manifestPath}，请先运行 npm run package:win`);
  }
  const manifestVersion = /^version:\s*(.+)$/m
    .exec(fs.readFileSync(manifestPath, 'utf8'))?.[1]
    ?.trim();
  console.log(`源版本：${manifestVersion}（取自 release/latest.yml）`);

  const cases = [
    { version: '0.0.1', expect: 'available', note: '旧版本应收到更新提醒' },
    { version: manifestVersion, expect: 'up-to-date', note: '同版本不应提醒' },
    { version: '9.9.9', expect: 'up-to-date', note: '更高版本不应被降级' },
  ];

  const failures = [];
  // 端口逐个递增，避免上个进程的 socket 还在 TIME_WAIT 里。
  let port = 28910;
  for (const testCase of cases) {
    port += 1;
    const result = await runProbe(testCase.version, port);
    const ok = result.outcome === testCase.expect;
    const extra =
      result.availableVersion === undefined ? '' : `（可更新到 ${result.availableVersion}）`;
    console.log(
      `${ok ? '✓' : '✗'} 当前 ${testCase.version} → ${result.outcome}${extra}  ${testCase.note}`,
    );
    if (!ok) {
      failures.push(
        `${testCase.version}: 期望 ${testCase.expect}，实际 ${result.outcome} ${result.error ?? ''}`,
      );
    }
    if (testCase.expect === 'available' && result.availableVersion !== manifestVersion) {
      failures.push(
        `${testCase.version}: 发现的版本 ${result.availableVersion} ≠ 源版本 ${manifestVersion}`,
      );
    }
  }
  return failures;
}

/** 线上可用性：客户端真的能匿名读到最新版本吗。 */
async function verifyOnline(owner, repo) {
  const failures = [];
  const listUrl = `https://api.github.com/repos/${owner}/${repo}/releases/latest`;
  console.log(`线上检查：${listUrl}`);
  try {
    const response = await fetch(listUrl, {
      headers: { 'User-Agent': 'endaxis-verify', Accept: 'application/vnd.github+json' },
    });
    if (response.status !== 200) {
      // 匿名限流（403）在开发期很常见，不算功能缺陷，但必须说清楚，别误判。
      const hint =
        response.status === 403
          ? '（多半是 GitHub 匿名 API 限流 60 次/小时；等额度重置或换网络再试）'
          : '';
      failures.push(`线上 Release 读取失败：HTTP ${response.status} ${hint}`);
      return failures;
    }
    const release = await response.json();
    console.log(
      `  最新 tag：${release.tag_name}  draft=${release.draft}  prerelease=${release.prerelease}`,
    );
    if (release.draft) failures.push('最新 Release 仍是 Draft，客户端看不到');
    const names = (release.assets ?? []).map(asset => asset.name);
    if (!names.includes('latest.yml')) failures.push('Release 缺少必需资产：latest.yml');
    if (!names.some(name => name.endsWith('.exe') && !name.endsWith('.blockmap'))) {
      failures.push('Release 缺少安装包');
    }
    if (!names.some(name => name.endsWith('.blockmap'))) {
      console.log('  （提示：缺 .blockmap 只是不能增量下载，不影响更新）');
    }
  } catch (error) {
    failures.push(`线上检查异常：${error?.message ?? error}`);
  }
  return failures;
}

app.whenReady().then(async () => {
  let exitCode = 1;
  try {
    const failures = await verifyDetection();
    if (online !== null) {
      console.log('');
      failures.push(...(await verifyOnline(online.owner, online.repo)));
    }
    console.log('');
    if (failures.length === 0) {
      console.log('通过：更新检测逻辑正确，客户端能正常收到更新提醒。');
      exitCode = 0;
    } else {
      console.error('失败：');
      for (const message of failures) console.error(`  - ${message}`);
    }
  } catch (error) {
    console.error(`异常：${error?.message ?? error}`);
  } finally {
    app.exit(exitCode);
  }
});
