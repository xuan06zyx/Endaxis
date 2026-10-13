'use strict';

/**
 * 按"无代理用户"的真实场景验证镜像站。
 *
 * 为什么需要这个工具，而不只是 verify-mirrors.js：
 *   Electron 的 fetch 走 Chromium 网络栈，**不读 HTTP_PROXY 环境变量**；
 *   而开发机通常挂着代理。于是会出现"镜像连不上、GitHub 反而通"的假象——
 *   与真实用户（没代理、GitHub 不通、镜像通）恰好相反。
 *
 * 本工具显式清掉代理变量后测量，复现无代理用户的处境：
 *   - GitHub 不通是**预期**的（真实用户就是这样）；
 *   - 此时镜像站必须可用，否则"给无代理用户用"这个目标就没达成。
 *
 * 用法： node scripts/launch.mjs tools/verify-mirrors-noproxy.js
 */

const { app } = require('electron');

const PREFIX = 'NOPROXY ';
const failures = [];

app.whenReady().then(async () => {
  let exitCode = 1;
  try {
    // 关键：清掉所有代理变量，模拟没有代理的用户。
    for (const name of [
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'http_proxy',
      'https_proxy',
      'ALL_PROXY',
      'all_proxy',
      'NODE_USE_ENV_PROXY',
    ]) {
      delete process.env[name];
    }
    console.log(`${PREFIX}已清除代理环境变量，按无代理用户测量`);

    const { MIRRORS, applyMirror } = require('../src/main/mirrors');
    const { testMirrors } = require('../src/main/mirrorSpeedTest');

    const version = '1.0.6';
    const assetUrl =
      `https://github.com/xuan06zyx/Endaxis/releases/download/v${version}/` +
      `Endaxis-Setup-${version}-x64.exe`;
    const apiTarget = 'https://api.github.com/repos/xuan06zyx/Endaxis/releases/latest';

    console.log(`${PREFIX}测量各下载源（含直连 GitHub 作对照）…`);
    const results = await testMirrors(MIRRORS, assetUrl);
    const byId = new Map(results.map(result => [result.id, result]));

    for (const mirror of MIRRORS) {
      const result = byId.get(mirror.id);
      const speed =
        result.ok && Number.isFinite(result.speedBps)
          ? `${(result.speedBps / 1024 / 1024).toFixed(2)} MB/s`
          : '—';
      console.log(
        `${PREFIX}  ${mirror.id.padEnd(13)} 下载=${result.ok ? '可用' : '不可用'}` +
          `  延迟=${result.ttfbMs === null ? '—' : `${result.ttfbMs}ms`}` +
          `  速度=${speed}` +
          `${result.error === null ? '' : `  错误=${result.error}`}`,
      );
    }

    // GitHub 不通是预期；通了也只是说明这台机器能直连，不算失败。
    const github = byId.get('github');
    if (github.ok) {
      console.log(`${PREFIX}提示：本机在无代理下也能直连 GitHub，无法完全复现受限网络`);
    } else {
      console.log(`${PREFIX}GitHub 在无代理下不可用（符合受限网络用户的处境）`);
    }

    const mirrorsOnly = results.filter(result => result.id !== 'github');
    const usableMirrors = mirrorsOnly.filter(result => result.ok);
    console.log(`${PREFIX}可用镜像：${usableMirrors.length}/${mirrorsOnly.length}`);

    if (usableMirrors.length === 0) {
      failures.push('无代理环境下没有任何可用镜像——"给无代理用户用"的目标未达成');
    }

    // 查版本路径：至少要有一个「支持 API 的镜像」在无代理下可用，
    // 否则用户即使能下载也查不到新版本号。
    const apiMirrors = MIRRORS.filter(mirror => mirror.supportsApi && mirror.id !== 'github');
    let apiUsable = 0;
    for (const mirror of apiMirrors) {
      try {
        const response = await fetch(applyMirror(apiTarget, mirror), {
          headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'EndaxisVerify' },
        });
        if (response.ok) apiUsable += 1;
        console.log(
          `${PREFIX}  ${mirror.id} 查版本=${response.ok ? '可用' : `HTTP ${response.status}`}`,
        );
      } catch (error) {
        console.log(`${PREFIX}  ${mirror.id} 查版本失败=${error?.message ?? error}`);
      }
    }
    if (apiMirrors.length > 0 && apiUsable === 0) {
      failures.push('无代理环境下没有可用镜像能查版本——用户将收不到更新提醒');
    }

    console.log('');
    if (failures.length === 0) {
      console.log('通过：无代理用户可用镜像下载，且至少一个镜像能查版本。');
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
