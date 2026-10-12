'use strict';

/**
 * 验证：编辑之后**立刻**关闭程序，改动会不会丢。
 *
 * 这是"合并写入（防抖）"最危险的场景：改动还在窗口里没落盘，用户就关了程序。
 * 必须保证 `beforeunload` 的 flush 真的把它交出去。
 *
 * 为什么分两次启动子进程：只有一个窗口的应用，关掉窗口就等于退出进程，
 * 没法在同一个进程里既"关掉"又"重开"。所以这里起两次真实进程，
 * 中间那次关闭就是用户真实的关程序行为。
 *
 * 用法： npm run verify:closeflush
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { app } = require('electron');

const SHELL_ROOT = path.resolve(__dirname, '..');
const PROBE_SCRIPT = path.join(__dirname, 'close-flush-probe.js');
const ELECTRON_BINARY = path.join(
  SHELL_ROOT,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron',
);
const PROBE_PREFIX = 'CLOSE_FLUSH ';
const CHILD_TIMEOUT_MS = 90_000;
/** 关窗延迟：远小于 1.2 秒防抖窗口，确保关闭时写入还在排队。 */
const CLOSE_DELAY_MS = 200;
/**
 * 两个阶段必须用**同一个端口**：IndexedDB 按 origin 隔离，端口不同就是两个库，
 * "关掉再打开"读到的会是空库——那测出来的是假故障。
 */
const PROBE_PORT = 28457;

function runProbe(arguments_, label) {
  return new Promise((resolve, reject) => {
    const environment = { ...process.env, ENDAXIS_SERVER_PORT: String(PROBE_PORT) };
    delete environment.ELECTRON_RUN_AS_NODE;
    // 把 --webapp=... 透传给子进程：不传的话测的还是 release/win-unpacked 里的旧产物。
    const forwarded = process.argv.filter(value => value.startsWith('--webapp='));
    const child = spawn(ELECTRON_BINARY, [PROBE_SCRIPT, ...arguments_, ...forwarded], {
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
      clearTimeout(timeout);
      child.kill();
      if (error) reject(error);
      else resolve(value);
    };
    const timeout = setTimeout(() => {
      finish(new Error(`[${label}] 子进程超时（${CHILD_TIMEOUT_MS}ms）\n${stdout}\n${stderr}`));
    }, CHILD_TIMEOUT_MS);

    child.stdout.on('data', chunk => {
      const text = chunk.toString();
      stdout += text;
      for (const line of text.split(/\r?\n/)) {
        if (line.startsWith(PROBE_PREFIX))
          console.log(`  [${label}] ${line.slice(PROBE_PREFIX.length)}`);
      }
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });
    child.on('error', error => finish(error));
    child.on('exit', code => {
      finish(null, { code, stdout, stderr });
    });
  });
}

app.whenReady().then(async () => {
  let exitCode = 1;
  try {
    // 用独立的 userData，绝不碰用户真实的项目数据。
    const userDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'endaxis-closeflush-'));
    const userDataArgument = `--user-data-dir=${userDataDirectory}`;
    // 用固定的纯数字标记：应用里是数字输入框，写超长字符串会被拒绝，
    // 那样"改不动"就会被误判成"保存失败"（踩过）。
    const marker = '424242';
    console.log(`[verify:closeflush] 独立数据目录：${userDataDirectory}`);
    console.log(`[verify:closeflush] 标记值：${marker}`);

    console.log('\n[verify:closeflush] 阶段 1：编辑 → 200ms 后关窗');
    await runProbe(['--edit', marker, String(CLOSE_DELAY_MS), userDataArgument], 'edit');

    console.log('\n[verify:closeflush] 阶段 2：重新打开，检查改动是否保住');
    const check = await runProbe(['--check', marker, '0', userDataArgument], 'check');

    const line = check.stdout
      .split(/\r?\n/)
      .find(value => value.startsWith(`${PROBE_PREFIX}RESULT `));
    if (line === undefined) {
      throw new Error(`阶段 2 没有输出结果。\n${check.stdout}\n${check.stderr}`);
    }
    const result = JSON.parse(line.slice(`${PROBE_PREFIX}RESULT `.length));
    console.log(`\n[verify:closeflush] 存档检查：${JSON.stringify(result)}`);

    if (result.found === true) {
      console.log('[verify:closeflush] 通过：关窗瞬间的改动没有丢。');
      exitCode = 0;
    } else {
      console.error(
        '[verify:closeflush] 失败：关窗时排队的写入丢了（beforeunload 的 flush 没生效）。',
      );
    }

    fs.rmSync(userDataDirectory, { recursive: true, force: true });
  } catch (error) {
    console.error(`[verify:closeflush] ${error instanceof Error ? error.message : error}`);
  } finally {
    app.exit(exitCode);
  }
});
