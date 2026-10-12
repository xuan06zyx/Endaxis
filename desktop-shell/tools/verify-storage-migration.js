'use strict';

/**
 * 验证"清理历史孤儿存档库"的行为。
 *
 * 在临时目录里造出一批假的 origin 目录（含孤儿、固定端口、当前端口、
 * 以及无关目录），跑一次清理，断言：
 *   - 只删掉随机端口的孤儿；
 *   - 当前端口的库、所有固定端口的库、无关目录**原样保留**；
 *   - 第二次运行不再重复处理（标记生效）。
 *
 * 用法： npm run verify:storage-migration
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');

const { cleanupOrphanedStorage, PREFERRED_PORTS } = require('../src/main/storageMigration');

const CURRENT_PORT = 17321;

/** 造一个像样的 leveldb 目录（带点内容，顺便验证体积统计）。 */
function makeOrigin(directory, name, bytes) {
  const target = path.join(directory, name);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'CURRENT'), 'MANIFEST-000001\n', 'utf8');
  fs.writeFileSync(path.join(target, '000003.log'), 'x'.repeat(bytes), 'utf8');
  return target;
}

const failures = [];
const record = (condition, message) => {
  if (!condition) failures.push(message);
};

app.whenReady().then(() => {
  let exitCode = 1;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'endaxis-migration-'));

  try {
    const indexedDb = path.join(scratch, 'IndexedDB');
    fs.mkdirSync(indexedDb, { recursive: true });

    const orphans = [
      'http_127.0.0.1_4491.indexeddb.leveldb',
      'http_127.0.0.1_8006.indexeddb.leveldb',
      'http_127.0.0.1_1234.indexeddb.leveldb',
    ];
    const mustKeep = [
      `http_127.0.0.1_${CURRENT_PORT}.indexeddb.leveldb`,
      // 其它固定端口的库也要留着：用户可能正常用过其中之一。
      `http_127.0.0.1_${PREFERRED_PORTS[1]}.indexeddb.leveldb`,
      // 不是本项目产生的目录名，一律不碰。
      'https_example_com_0.indexeddb.leveldb',
      'not-an-origin-directory',
    ];

    for (const name of orphans) makeOrigin(indexedDb, name, 2048);
    for (const name of mustKeep) makeOrigin(indexedDb, name, 1024);

    console.log(`[migration-test] 临时目录：${scratch}`);
    console.log(`[migration-test] 造出 ${orphans.length} 个孤儿 + ${mustKeep.length} 个应保留目录`);

    const first = cleanupOrphanedStorage({
      userDataDirectory: scratch,
      currentPort: CURRENT_PORT,
      force: true,
    });
    console.log(`[migration-test] 第一次清理：${JSON.stringify(first)}`);

    record(first.status === 'completed', `第一次清理状态异常：${first.status}`);
    record(
      first.removed.length === orphans.length,
      `删除数量不符：期望 ${orphans.length}，实际 ${first.removed.length}`,
    );
    for (const name of orphans) {
      record(!fs.existsSync(path.join(indexedDb, name)), `孤儿目录没被删除：${name}`);
    }
    for (const name of mustKeep) {
      record(fs.existsSync(path.join(indexedDb, name)), `不该删的目录被删掉了：${name}`);
    }

    // 第二次运行：标记已写，应直接跳过。
    const second = cleanupOrphanedStorage({
      userDataDirectory: scratch,
      currentPort: CURRENT_PORT,
    });
    console.log(`[migration-test] 第二次清理：${JSON.stringify(second)}`);
    record(second.status === 'already-done', `第二次应跳过，实际：${second.status}`);

    // 随机端口回退时：一个都不许删。
    const scratchFallback = fs.mkdtempSync(path.join(os.tmpdir(), 'endaxis-migration-fb-'));
    const fallbackIndexedDb = path.join(scratchFallback, 'IndexedDB');
    fs.mkdirSync(fallbackIndexedDb, { recursive: true });
    const fallbackOrphan = 'http_127.0.0.1_4491.indexeddb.leveldb';
    makeOrigin(fallbackIndexedDb, fallbackOrphan, 512);
    const fallback = cleanupOrphanedStorage({
      userDataDirectory: scratchFallback,
      currentPort: 4444,
      force: true,
    });
    console.log(`[migration-test] 随机端口回退时：${JSON.stringify(fallback)}`);
    record(fallback.status === 'skipped', `随机端口回退时应跳过，实际：${fallback.status}`);
    record(
      fs.existsSync(path.join(fallbackIndexedDb, fallbackOrphan)),
      '随机端口回退时删除了目录（危险：可能删掉当前数据）',
    );
    fs.rmSync(scratchFallback, { recursive: true, force: true });

    if (failures.length === 0) {
      console.log('[migration-test] 通过：孤儿被清理，当前/固定端口的库与无关目录全部保留。');
      exitCode = 0;
    } else {
      console.error('[migration-test] 失败：');
      for (const message of failures) console.error(`  - ${message}`);
    }
  } catch (error) {
    console.error(`[migration-test] ${error instanceof Error ? error.stack : error}`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
    app.exit(exitCode);
  }
});
