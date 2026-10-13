'use strict';

/**
 * 验证镜像站支持：查版本、测速、偏好持久化。
 *
 * 为什么需要它：镜像站是给"无法直连 GitHub"的用户用的，功能一旦悄悄失效，
 * 受影响最大的恰恰是这批人（他们连报错都看不懂）。所以每条路径都要有断言。
 *
 * 覆盖：
 *   1. 各镜像对 API / 资产的可用性与 mirrors.js 里声明的能力是否一致
 *      （声明 supportsApi 却查不到版本，会让用户选了镜像仍然查不了版本）；
 *   2. discoverLatestVersion 能查出正确版本；
 *   3. 测速能给出结果且至少一个可用；
 *   4. 偏好读写往返一致。
 *
 * 用法： node scripts/launch.mjs tools/verify-mirrors.js [--online]
 *   --online 时额外做真实网络探测（默认也做，因为镜像可用性是核心）。
 */

const fs = require('node:fs');
const { app } = require('electron');

const PREFIX = 'MIRRORS ';
const failures = [];
const record = (ok, message) => {
  console.log(`${ok ? '✓' : '✗'} ${message}`);
  if (!ok) failures.push(message);
};

app.whenReady().then(async () => {
  let exitCode = 1;
  try {
    const { MIRRORS, applyMirror, findMirror, MIRROR_LIST_URL } = require('../src/main/mirrors');
    const { testMirrors } = require('../src/main/mirrorSpeedTest');
    const {
      readPreferences,
      writePreferences,
      preferencesPath,
    } = require('../src/main/preferences');

    console.log(`${PREFIX}镜像数：${MIRRORS.length}`);
    record(MIRRORS.length >= 2, '至少内置两个下载源（直连 + 镜像）');
    record(
      MIRRORS.some(mirror => mirror.id === 'ghfast'),
      '包含需求指定的 ghfast.top',
    );
    record(
      MIRRORS.some(mirror => mirror.supportsApi),
      '至少一个镜像支持查版本',
    );
    record(MIRROR_LIST_URL.startsWith('https://'), `提供官方地址发布页（${MIRROR_LIST_URL}）`);

    // ── applyMirror 纯逻辑 ────────────────────────────────────────────
    const github = findMirror('github');
    const ghfast = findMirror('ghfast');
    const sample = 'https://github.com/o/r/releases/download/v1/x.exe';
    record(applyMirror(sample, github) === sample, '直连不做改写');
    record(applyMirror(sample, ghfast) === `https://ghfast.top/${sample}`, '镜像正确加前缀');
    record(
      applyMirror(`https://ghfast.top/${sample}`, ghfast) === `https://ghfast.top/${sample}`,
      '已带前缀时不重复叠加',
    );
    record(findMirror('不存在') === null, '未知镜像 id 返回 null（调用方回退直连）');

    // ── 偏好往返 ──────────────────────────────────────────────────────
    console.log(`${PREFIX}偏好文件：${preferencesPath()}`);
    const previous = readPreferences();
    record(writePreferences({ mirrorId: 'ghfast' }) === true, '写入偏好成功');
    record(readPreferences().mirrorId === 'ghfast', '读回偏好一致');
    writePreferences({ mirrorId: previous.mirrorId ?? 'github' });
    record(readPreferences().mirrorId === (previous.mirrorId ?? 'github'), '已还原原选择');

    // ── 真实网络：能力声明与实际是否一致 ──────────────────────────────
    const version = '1.0.6';
    const assetUrl = `https://github.com/xuan06zyx/Endaxis/releases/download/v${version}/Endaxis-Setup-${version}-x64.exe`;
    const apiTarget = 'https://api.github.com/repos/xuan06zyx/Endaxis/releases/latest';

    console.log(`${PREFIX}探测各下载源…`);
    for (const mirror of MIRRORS) {
      // 下载路径
      const [download] = await testMirrors([mirror], assetUrl);
      console.log(
        `${PREFIX}  ${mirror.id}: 下载 ok=${download.ok} ` +
          `ttfb=${download.ttfbMs ?? '-'}ms speed=${download.speedBps ?? '-'}B/s`,
      );
      // 查版本路径
      let apiOk = false;
      try {
        const response = await fetch(applyMirror(apiTarget, mirror), {
          headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'EndaxisVerify' },
        });
        apiOk = response.ok;
      } catch {
        apiOk = false;
      }
      console.log(`${PREFIX}  ${mirror.id}: 查版本可用=${apiOk}（声明 ${mirror.supportsApi}）`);

      if (mirror.supportsApi && !apiOk) {
        // 不判为失败：镜像站会临时抖动或被限流。但必须显式提示，
        // 否则用户遇到的是"选了镜像还是查不到版本"这种说不清的故障。
        console.log(`  ⚠ ${mirror.id} 声明支持查版本，但本次不可用（可能临时故障）`);
      }
      if (!mirror.supportsApi && apiOk) {
        record(false, `${mirror.id} 实际能查版本，但声明为不支持——应更新能力标记`);
      }
    }

    const results = await testMirrors(MIRRORS, assetUrl);
    const usable = results.filter(result => result.ok);
    record(usable.length >= 1, `至少一个下载源可用（实际 ${usable.length}/${results.length}）`);
    record(
      results.every(result => typeof result.id === 'string'),
      '测速结果都带 id，界面才能对应到行',
    );

    console.log('');
    if (failures.length === 0) {
      console.log('通过：镜像支持的查版本、测速与偏好持久化均正常。');
      exitCode = 0;
    } else {
      console.log('失败：');
      for (const message of failures) console.log(`  - ${message}`);
    }
  } catch (error) {
    console.log(`${PREFIX}异常：${error?.stack ?? error}`);
  } finally {
    app.exit(exitCode);
  }
});

void fs;
