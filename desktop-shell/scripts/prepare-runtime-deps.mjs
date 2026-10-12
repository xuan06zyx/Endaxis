#!/usr/bin/env node
/**
 * 把生产依赖装进 webapp/ 旁边的一个干净目录，供 electron-builder 打包。
 *
 * 为什么需要这一步：
 *   1. 打包时需要的只有 `dependencies`（运行时要 require 的东西），
 *      而 `devDependencies`（electron / electron-builder / sharp）绝不能进包；
 *   2. electron-builder 默认只收集它自己解析出来的生产依赖，本项目
 *      files 里的 src/** 又会触发 !**&#47;node_modules/** 默认排除，
 *      结果 electron-updater 一直没被打进 asar（真机上表现为更新功能静默失效）；
 *   3. `npm install --omit=dev` 会得到一棵包含嵌套依赖的完整树，
 *      比手写 glob 可靠得多（electron-updater 内部就嵌套了 semver）。
 *
 * 产物：desktop-shell/app-runtime/node_modules/**（已在 .gitignore 中忽略）
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const shellRoot = path.resolve(here, '..');
const target = path.join(shellRoot, 'app-runtime');

const manifest = JSON.parse(fs.readFileSync(path.join(shellRoot, 'package.json'), 'utf8'));
const productionDependencies = Object.keys(manifest.dependencies ?? {});

if (productionDependencies.length === 0) {
  console.log('[app-runtime] 没有生产依赖，跳过。');
  process.exit(0);
}

fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });
fs.writeFileSync(
  path.join(target, 'package.json'),
  JSON.stringify(
    {
      name: 'endaxis-desktop-runtime',
      version: manifest.version,
      private: true,
      // 必须显式声明依赖，npm 才会去解析整棵树。
      dependencies: manifest.dependencies,
    },
    null,
    2,
  ),
  'utf8',
);

console.log(`[app-runtime] 安装生产依赖：${productionDependencies.join(', ')}`);
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
// Windows 上必须 shell:true：npm 其实是 npm.cmd 这个批处理，
// 不经 shell 直接 exec 会失败（status=null）。dev.mjs 那边是另一回事——
// 那里踩的坑是"把带空格的 Node 路径交给 shell"，两处需求不同，别混。
const result = spawnSync(
  npmCommand,
  ['install', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts'],
  { cwd: target, stdio: 'inherit', shell: process.platform === 'win32' },
);

if (result.status !== 0) {
  console.error(`[app-runtime] 安装失败，退出码 ${result.status}`);
  process.exit(result.status ?? 1);
}

// 装完删掉自己的 package.json / lock：asar 根目录要放外壳自己的 package.json。
fs.rmSync(path.join(target, 'package.json'), { force: true });
fs.rmSync(path.join(target, 'package-lock.json'), { force: true });

let count = 0;
const walk = directory => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) walk(path.join(directory, entry.name));
    else count += 1;
  }
};
walk(target);

console.log(`[app-runtime] 就绪：${count} 个文件 → app-runtime/node_modules/`);