'use strict';

/**
 * 验证已发布的 GitHub Release 是否真的能被客户端用作更新源。
 *
 * 只做客户端会做的事：不带任何凭据访问公开下载地址，取 latest.yml、
 * 核对 sha512，并确认安装包可下载。**不下载整个安装包**，只取头部。
 *
 * 用法： node tools/verify-release.mjs <owner> <repo> <version>
 *   node tools/verify-release.mjs xuan06zyx Endaxis 1.0.1
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const [owner, repo, version] = process.argv.slice(2);
if (!owner || !repo || !version) {
  console.error('用法：node tools/verify-release.mjs <owner> <repo> <version>');
  process.exit(2);
}

const tag = `v${version}`;
const releaseBase = `https://github.com/${owner}/${repo}/releases/download/${tag}`;
const localReleaseDirectory = path.resolve(here, '..', 'release');

const failures = [];
const record = (condition, message) => {
  console.log(`${condition ? '✓' : '✗'} ${message}`);
  if (!condition) failures.push(message);
};

/** 计算本地文件的 sha512（base64），与 electron-builder 的写法一致。 */
function localSha512(filePath) {
  const hash = createHash('sha512');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('base64');
}

async function main() {
  console.log(`验证更新源：${releaseBase}\n`);

  // ── 1. latest.yml 必须匿名可取 ──────────────────────────────────────────
  // 带随机查询参数绕过 CDN 缓存：重复发布同一 tag 时，无参请求可能仍拿到旧清单，
  // 会把"上传成功但清单是旧的"这种真问题掩盖掉。
  const cacheBuster = `?cb=${Date.now()}`;
  const localManifestPath = path.join(localReleaseDirectory, 'latest.yml');
  const localManifest = fs.existsSync(localManifestPath)
    ? fs.readFileSync(localManifestPath, 'utf8')
    : '';
  const localReleaseDate = /^releaseDate:\s*'?([^'\n]+)'?$/m.exec(localManifest)?.[1]?.trim();

  const ymlResponse = await fetch(`${releaseBase}/latest.yml${cacheBuster}`, {
    redirect: 'follow',
    headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
  });
  record(ymlResponse.status === 200, `latest.yml 可匿名下载（HTTP ${ymlResponse.status}）`);
  if (ymlResponse.status !== 200) return;

  const yml = await ymlResponse.text();
  console.log('\n--- 线上 latest.yml ---');
  console.log(yml.trim());
  console.log('---\n');

  const manifestVersion = /^version:\s*(.+)$/m.exec(yml)?.[1]?.trim();
  const manifestPath = /^path:\s*(.+)$/m.exec(yml)?.[1]?.trim();
  const manifestSha = /^sha512:\s*(.+)$/m.exec(yml)?.[1]?.trim();
  const manifestSize = Number.parseInt(/^\s*size:\s*(\d+)$/m.exec(yml)?.[1] ?? '0', 10);
  const remoteReleaseDate = /^releaseDate:\s*'?([^'\n]+)'?$/m.exec(yml)?.[1]?.trim();

  record(manifestVersion === version, `清单版本是 ${version}（实际 ${manifestVersion}）`);
  record(typeof manifestPath === 'string' && manifestPath.length > 0, `清单声明了安装包：${manifestPath}`);
  record(typeof manifestSha === 'string' && manifestSha.length > 0, '清单包含 sha512');
  // 线上清单必须与本地刚构建的那份一致，否则说明线上是旧产物。
  if (localReleaseDate !== undefined && remoteReleaseDate !== undefined) {
    record(
      remoteReleaseDate === localReleaseDate,
      `线上清单与本地构建同批（线上 ${remoteReleaseDate} / 本地 ${localReleaseDate}）`,
    );
  }

  // ── 2. 线上清单声明的 sha512 必须等于本地那份安装包的实算值 ────────────
  // 注意比的是"线上清单 ↔ 本地文件"：这样才知道上传上去的到底是哪一份字节。
  const localInstaller = path.join(localReleaseDirectory, manifestPath ?? '');
  if (fs.existsSync(localInstaller)) {
    const actual = localSha512(localInstaller);
    const localSize = fs.statSync(localInstaller).size;
    record(
      actual === manifestSha,
      '线上清单的 sha512 与本地安装包实算值一致（上传的就是这一份字节）',
    );
    record(
      localSize === manifestSize,
      `线上清单的 size 与本地一致（清单 ${manifestSize} / 本地 ${localSize} 字节）`,
    );
  } else {
    console.log(`  （本地没有 ${manifestPath}，跳过比对）`);
  }
  void localSha512;

  // ── 3. 安装包必须可下载 ────────────────────────────────────────────────
  // 同样带缓存绕过参数：GitHub 的资产 CDN 会按文件名缓存，重复发布同一 tag 时
  // 无参请求可能返回**上一份**文件的长度，从而误报"大小与清单不符"（实测踩过）。
  const installerResponse = await fetch(
    `${releaseBase}/${manifestPath}${cacheBuster}`,
    { method: 'HEAD', redirect: 'follow', headers: { 'Cache-Control': 'no-cache' } },
  );
  record(
    installerResponse.status === 200,
    `安装包可匿名下载（HTTP ${installerResponse.status}）`,
  );
  const remoteLength = Number.parseInt(installerResponse.headers.get('content-length') ?? '0', 10);
  if (remoteLength > 0) {
    record(remoteLength === manifestSize, `远端大小与清单一致（${remoteLength} 字节）`);
  }

  // ── 4. blockmap 必须存在（增量下载用，缺了只能整包下）──────────────────
  const blockmapResponse = await fetch(
    `${releaseBase}/${manifestPath}.blockmap${cacheBuster}`,
    { method: 'HEAD', redirect: 'follow', headers: { 'Cache-Control': 'no-cache' } },
  );
  record(
    blockmapResponse.status === 200,
    `blockmap 可用（HTTP ${blockmapResponse.status}，缺失只是不能增量下载）`,
  );

  console.log('');
  if (failures.length === 0) {
    console.log(`通过：${owner}/${repo} 的 ${tag} 可作为更新源正常工作。`);
  } else {
    console.error('失败：');
    for (const message of failures) console.error(`  - ${message}`);
  }
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch(error => {
  console.error(`验证异常：${error?.message ?? error}`);
  process.exit(1);
});
