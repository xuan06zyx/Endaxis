#!/usr/bin/env node
/**
 * 把 Endaxis 的 Vite 产物同步到 desktop-shell/webapp。
 *
 * 打包时 extraResources 会把 webapp/ 放进安装包，因此这一步决定了
 * 打包后的 App 里到底跑哪一份前端代码。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const shellRoot = path.resolve(here, '..');

/**
 * 前端产物（Vite 的 dist）的位置随目录布局变化，两种都要覆盖：
 *   - 嵌套布局（本仓库内）：desktop-shell/ 与 dist/ 同级 → ../dist
 *   - 同级布局（本地开发）：desktop-shell/ 与 Endaxis/ 同级 → ../Endaxis/dist
 * 漏掉嵌套布局会让 CI 上这一步直接失败（实测过一次同类问题）。
 */
const sourceCandidates = [
  process.env.ENDAXIS_DIST_DIR?.trim() || null,
  path.join(shellRoot, '..', 'dist'),
  path.join(shellRoot, '..', 'Endaxis', 'dist'),
].filter(candidate => candidate !== null);

const targetDirectory = path.join(shellRoot, 'webapp');
const targetIndex = path.join(targetDirectory, 'index.html');

function fail(message) {
  console.error(`[prepare-dist] ${message}`);
  process.exit(1);
}

const sourceDirectory = sourceCandidates.find(
  candidate => fs.existsSync(path.join(candidate, 'index.html')),
);
if (sourceDirectory === undefined) {
  fail(
    `没有找到构建产物，已尝试：\n  ${sourceCandidates.join('\n  ')}\n请先运行 npm run build:web。`,
  );
}

// 先删后拷会留下短暂的空目录；先拷到临时目录再原子替换更安全。
const stagingDirectory = path.join(shellRoot, '.webapp-staging');
fs.rmSync(stagingDirectory, { recursive: true, force: true });
fs.cpSync(sourceDirectory, stagingDirectory, { recursive: true });

fs.rmSync(targetDirectory, { recursive: true, force: true });
fs.renameSync(stagingDirectory, targetDirectory);

if (!fs.existsSync(targetIndex)) {
  fail('同步后仍然缺少 index.html，请检查磁盘状态。');
}

let fileCount = 0;
let totalBytes = 0;
const walk = directory => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile()) {
      fileCount += 1;
      totalBytes += fs.statSync(full).size;
    }
  }
};
walk(targetDirectory);

console.log(
  `[prepare-dist] 已同步 ${fileCount} 个文件（${(totalBytes / 1024 / 1024).toFixed(1)} MB）→ webapp/`,
);
