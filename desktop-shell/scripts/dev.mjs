#!/usr/bin/env node
/**
 * 开发模式：先起 Vite 开发服务器，再把它的地址交给 Electron。
 *
 * 直接复用项目自己的 vite 配置（含 @ 别名、vue 插件、manualChunks），
 * 因此开发时看到的界面和 `npm run dev` 完全一致，只是多了一层桌面窗口。
 *
 * 实现注意：这里一律**直接 spawn 可执行文件**，不经过 shell。
 * 本机 Node 装在 `C:\Program Files\nodejs`，带空格的路径一旦走 `shell: true`
 * 就会被 cmd 拆开（报 “'C:\Program' 不是内部或外部命令”）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const shellRoot = path.resolve(here, '..');
const repositoryRoot = path.resolve(shellRoot, '..', 'Endaxis');
const launcherPath = path.join(shellRoot, 'scripts', 'launch.mjs');

const children = new Set();
let shuttingDown = false;

function launch(command, args, options = {}) {
  const child = spawn(command, args, { stdio: 'inherit', ...options });
  children.add(child);
  child.on('exit', code => {
    children.delete(child);
    // 关掉最后一个窗口就结束整个开发会话，不留下孤立的 Vite。
    if (!shuttingDown && options.isElectron === true) shutdown(code ?? 0);
  });
  child.on('error', error => {
    children.delete(child);
    console.error(`[dev] 无法启动 ${path.basename(command)}：${error.message}`);
    shutdown(1);
  });
  return child;
}

function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  process.exit(exitCode);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

/** 定位 Vite 的可执行入口，避开 npm/shell 的中转。 */
function resolveViteEntry() {
  const projectRequire = createRequire(path.join(repositoryRoot, 'package.json'));
  try {
    const packageJsonPath = projectRequire.resolve('vite/package.json');
    const packageDirectory = path.dirname(packageJsonPath);
    const manifest = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const declared = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.vite;
    const candidates = [
      declared === undefined ? null : path.join(packageDirectory, declared),
      path.join(packageDirectory, 'bin', 'vite.js'),
    ].filter(value => value !== null);
    const found = candidates.find(value => fs.existsSync(value));
    if (found === undefined) {
      throw new Error(`在 ${packageDirectory} 里找不到 vite 可执行入口`);
    }
    return found;
  } catch (error) {
    console.error(
      `[dev] 读取不到 Vite：${error.message}\n` +
        `[dev] 请先到 ${repositoryRoot} 执行 npm install。`,
    );
    process.exit(1);
  }
}

/**
 * Vite 端口被占用时会自动换端口，因此从它的输出里读真实地址。
 */
function startVite(viteEntry) {
  return new Promise((resolve, reject) => {
    const vite = launch(process.execPath, [viteEntry, '--host', '127.0.0.1'], {
      cwd: repositoryRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let buffer = '';
    const timeout = setTimeout(() => {
      reject(new Error('等待 Vite 开发服务器超时（60 秒）。'));
    }, 60_000);

    const inspect = chunk => {
      const text = chunk.toString();
      // 直接把 Vite 的输出转发到当前终端，保持和 npm run dev 一致的观感。
      process.stdout.write(text);
      buffer += text;
      const match = buffer.match(/https?:\/\/127\.0\.0\.1:(\d+)\/?/);
      if (match === null) return;
      clearTimeout(timeout);
      resolve(match[0].replace(/\/$/, ''));
    };

    vite.stdout.on('data', inspect);
    vite.stderr.on('data', chunk => process.stderr.write(chunk.toString()));
    vite.on('exit', code => {
      clearTimeout(timeout);
      reject(new Error(`Vite 开发服务器退出，退出码 ${code}。`));
    });
  });
}

const devServerUrl = await startVite(resolveViteEntry());
console.log(`[dev] Vite 已就绪：${devServerUrl}`);
launch(process.execPath, [launcherPath, '.'], {
  env: { ...process.env, ENDAXIS_DEV_URL: devServerUrl },
  isElectron: true,
});
