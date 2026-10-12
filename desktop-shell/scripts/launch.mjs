#!/usr/bin/env node
/**
 * 启动 Electron。
 *
 * 存在的理由：某些终端/工具链会在环境里设置 `ELECTRON_RUN_AS_NODE=1`
 * （本机 harness 就会），此时 electron.exe 会退化成普通 Node 解释器，
 * `require('electron')` 返回可执行文件路径而不是 API，应用直接崩溃。
 * 这里统一清掉该变量，保证 `npm start` 在任何终端里都能真正拉起窗口。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const shellRoot = path.resolve(here, '..');

const electronBinary = path.join(
  shellRoot,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron',
);

const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;

/**
 * 只用于端到端验证的便捷开关：`npm start -- --webapp=<目录>`。
 *
 * 让验证脚本直接加载构建好的 webapp，不必先覆盖 release/win-unpacked。
 * 功能目录里没有它时，常规参数写法（`npm start -- <脚本> <参数>`）仍照旧工作。
 */
for (const argument of process.argv.slice(2)) {
  if (!argument.startsWith('--webapp=')) continue;
  environment.ENDAXIS_DIST_DIR = path.resolve(argument.slice('--webapp='.length));
}

const child = spawn(electronBinary, process.argv.slice(2), {
  cwd: shellRoot,
  env: environment,
  stdio: 'inherit',
});

child.on('exit', code => {
  process.exit(code ?? 0);
});
child.on('error', error => {
  console.error(
    `[launch] 无法启动 Electron：${error.message}\n` +
      `[launch] 请先执行 npm install 下载 Electron 运行时。`,
  );
  process.exit(1);
});
