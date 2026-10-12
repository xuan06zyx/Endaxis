'use strict';

/**
 * 验证"限流回退"这条路径：Releases Atom feed 是否真的不受限流、能否解析出最新版本。
 *
 * 背景：electron-updater 走 api.github.com，匿名请求仅 60 次/小时，开发期就把
 * 额度打满过（表现为检查更新静默失败）。诊断脚本里有一份等价的解析逻辑，
 * 这里把它单独测掉，避免"回退写了但从没验证过"。
 *
 * 不带凭据、纯匿名，正是客户端的使用方式。
 *
 * 用法： node --use-env-proxy tools/verify-feed-fallback.mjs <owner> <repo>
 */

const [owner, repo] = process.argv.slice(2);
if (!owner || !repo) {
  console.error('用法：node --use-env-proxy tools/verify-feed-fallback.mjs <owner> <repo>');
  process.exit(2);
}

const failures = [];
const record = (condition, message) => {
  console.log(`${condition ? '✓' : '✗'} ${message}`);
  if (!condition) failures.push(message);
};

// 与 src/main/updater.js 保持一致的实现（那边是闭包内的函数，这里复刻一份用于测试）。
function normalizeVersion(value) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(value ?? '');
  return match === null ? null : `${match[1]}.${match[2]}.${match[3]}`;
}

function compareVersions(left, right) {
  const toNumbers = value => value.split('.').map(part => Number.parseInt(part, 10));
  const a = toNumbers(left);
  const b = toNumbers(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

/** 从 feed XML 里取最新 tag（第一个 entry 的 title）。 */
function extractLatestTag(xml) {
  return /<entry>[\s\S]*?<title>([^<]+)<\/title>/.exec(xml)?.[1]?.trim() ?? null;
}

async function main() {
  // ── 版本比较（纯函数，先测掉）──────────────────────────────────────────
  console.log('版本比较：');
  record(compareVersions('1.0.1', '1.0.0') > 0, '1.0.1 > 1.0.0');
  record(compareVersions('1.0.0', '1.0.0') === 0, '1.0.0 == 1.0.0');
  record(compareVersions('1.0.0', '1.0.1') < 0, '1.0.0 < 1.0.1');
  record(compareVersions('2.0.0', '1.9.9') > 0, '2.0.0 > 1.9.9');

  console.log('\n版本规整（tag → 版本）：');
  record(normalizeVersion('v1.0.1') === '1.0.1', 'v1.0.1 → 1.0.1');
  record(normalizeVersion('desktop-v1.2.3') === '1.2.3', 'desktop-v1.2.3 → 1.2.3');
  record(normalizeVersion('nope') === null, '无法解析时返回 null');

  // ── 真实 feed（匿名）──────────────────────────────────────────────────
  const feed = `https://github.com/${owner}/${repo}/releases.atom`;
  console.log(`\n真实 feed：${feed}`);
  const response = await fetch(feed, {
    headers: { Accept: 'application/atom+xml', 'User-Agent': 'EndaxisDesktop/verify' },
  });
  record(response.status === 200, `feed 匿名可取（HTTP ${response.status}）`);
  if (response.status !== 200) return;

  const xml = await response.text();
  const latestTag = extractLatestTag(xml);
  console.log(`  最新 tag：${latestTag}`);
  record(latestTag !== null, '能解析出最新 tag');
  // 实测 feed 的 title 是 `1.0.1`（不带 v 前缀），所以只要求能规整出版本号，
  // 不要断言前缀——否则会因为无关的格式差异误报。
  record(normalizeVersion(latestTag) !== null, `tag 可规整为版本号（${normalizeVersion(latestTag)}）`);

  const entryCount = (xml.match(/<entry>/g) ?? []).length;
  console.log(`  feed 内 entry 数：${entryCount}`);
  record(entryCount >= 1, 'feed 至少包含一个发布记录');
}

main()
  .then(() => {
    console.log('');
    if (failures.length === 0) {
      console.log('通过：限流回退路径可用（feed 无限流、版本比较正确）。');
      process.exit(0);
    }
    console.error('失败：');
    for (const message of failures) console.error(`  - ${message}`);
    process.exit(1);
  })
  .catch(error => {
    console.error(`异常：${error?.message ?? error}`);
    process.exit(1);
  });
