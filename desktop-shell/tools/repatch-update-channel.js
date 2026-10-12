'use strict';

/**
 * 把已安装程序的更新源改指到自己的 fork，用于**实测更新提醒**。
 *
 * 做法：asar 是「头部 JSON + 顺序拼接的文件内容」，直接改写某个文件的内容时
 * 必须保持字节长度不变，否则后续所有文件的偏移都会错位。这里利用
 * `Lieyuan621`(10) → `xuan06zyx `(10，尾部补一个空格；YAML 视尾随空格为无物)
 * 等长替换，安全且可逆。
 *
 * 用法： node scripts/launch.mjs tools/repatch-update-channel.js <安装目录> <owner> <repo>
 */

const fs = require('node:fs');
const path = require('node:path');

const [installDirectory, owner, repo] = process.argv.slice(2);
if (!installDirectory || !owner || !repo) {
  console.error('用法：repatch-update-channel.js <安装目录> <owner> <repo>');
  process.exit(2);
}

const asarPath = path.join(installDirectory, 'resources', 'app.asar');
const backupPath = `${asarPath}.orig`;

if (!fs.existsSync(asarPath)) {
  console.error(`找不到 ${asarPath}`);
  process.exit(1);
}
// 只备份一次，避免把已打补丁的版本当成原始版本。
if (!fs.existsSync(backupPath)) {
  fs.copyFileSync(asarPath, backupPath);
  console.log(`已备份原始 asar → ${path.basename(backupPath)}`);
}

const buffer = fs.readFileSync(asarPath);

/** 找出 app-update.yml 在 asar 里的字节区间。 */
function locate(targetPath) {
  // asar 头部：8 字节 pickle 前缀 + JSON 长度，然后接 JSON。
  const jsonSize = buffer.readUInt32LE(12);
  const headerJson = buffer.subarray(16, 16 + jsonSize).toString('utf8');
  const header = JSON.parse(headerJson);
  const walk = (node, prefix) => {
    if (node.files === undefined) return null;
    for (const [name, child] of Object.entries(node.files)) {
      const childPath = prefix === '' ? name : `${prefix}/${name}`;
      if (childPath === targetPath && typeof child.offset === 'string') {
        return { offset: Number.parseInt(child.offset, 10), size: child.size };
      }
      const found = walk(child, childPath);
      if (found !== null) return found;
    }
    return null;
  };
  return walk(header, '');
}

const location = locate('resources/app-update.yml');
if (location === null) {
  console.error('asar 里找不到 resources/app-update.yml');
  process.exit(1);
}

const current = buffer.subarray(location.offset, location.offset + location.size).toString('utf8');
console.log('--- 当前内容 ---');
console.log(current.trim());
console.log('----------------');

const replaced = current.replace(/owner:\s*(\S+)/, (_match, previousOwner) => {
  if (previousOwner.length !== owner.length) {
    throw new Error(
      `owner 长度不一致（${previousOwner.length} → ${owner.length}），等长替换才能安全改写 asar`,
    );
  }
  return `owner: ${owner}`;
});

if (replaced === current) {
  console.log('无需改动（owner 已经是目标值）');
  process.exit(0);
}

const patched = Buffer.from(replaced, 'utf8');
if (patched.length !== location.size) {
  throw new Error(`改写后长度变化（${location.size} → ${patched.length}），拒绝写入以免破坏 asar`);
}
patched.copy(buffer, location.offset);
fs.writeFileSync(asarPath, buffer);

const verify = fs
  .readFileSync(asarPath)
  .subarray(location.offset, location.offset + location.size)
  .toString('utf8');
console.log('--- 改写后 ---');
console.log(verify.trim());
console.log('----------------');
console.log(`更新源已指向 ${owner}/${repo}（恢复原状：把 app.asar.orig 覆盖回 app.asar）`);
