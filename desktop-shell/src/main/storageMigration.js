'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * 一次性清理历史遗留的孤儿存档库。
 *
 * 背景：早期版本用随机端口提供服务（`listen(0)`），而浏览器按 origin
 * （协议+主机+端口）隔离存储。于是每启动一次就新建一个
 * `IndexedDB/http_127.0.0.1_<端口>.indexeddb.leveldb`，上次的存档再也读不到
 * ——这就是"设置好干员、关掉再打开又回到初始状态"的根因。实测用户机器上
 * 积累了几十个这样的孤儿目录。
 *
 * 现在端口固定为 17321，孤儿目录只是垃圾，但删数据必须极度保守：
 *
 *   - **只删 IndexedDB 下形如 `http_127.0.0.1_<端口>.indexeddb.leveldb`
 *     的目录**，别的一律不碰；
 *   - 当前会话正在用的 origin 目录绝不删；
 *   - 所有"首选固定端口"的目录都不删（万一用户曾经正常用过其中之一）；
 *   - 只有**本次确实跑在固定端口上**才执行清理。若本次退回随机端口，
 *     说明环境里有端口冲突，此时无法可靠区分"孤儿"与"当前数据"，直接跳过。
 */

/** 与 src/main/server.js 的 PREFERRED_PORTS 保持一致。 */
const PREFERRED_PORTS = [17321, 27321, 37321, 47321, 57321];

const MARKER_NAME = 'storage-migration.json';
/** 只匹配回环地址 + 数字端口的 IndexedDB 目录名。 */
const ORIGIN_DIRECTORY_PATTERN = /^http_127\.0\.0\.1_(\d+)\.indexeddb\.leveldb$/;

function resolveMarkerPath(userDataDirectory) {
  return path.join(userDataDirectory, MARKER_NAME);
}

/** 是否已经迁移过（用户可能换版本重装，避免反复扫描/删除）。 */
function alreadyMigrated(userDataDirectory) {
  try {
    const raw = fs.readFileSync(resolveMarkerPath(userDataDirectory), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed?.completed === true;
  } catch {
    return false;
  }
}

function writeMarker(userDataDirectory, payload) {
  try {
    fs.mkdirSync(userDataDirectory, { recursive: true });
    fs.writeFileSync(
      resolveMarkerPath(userDataDirectory),
      JSON.stringify({ completed: true, at: new Date().toISOString(), ...payload }, null, 2),
      'utf8',
    );
  } catch {
    // 标记写失败只意味着下次会再扫一遍，不影响正确性。
  }
}

/**
 * 判断某个 origin 目录是否可以安全删除。
 *
 * @param {{ name: string }} entry
 * @param {number} currentPort 本次会话实际使用的端口
 */
function isRemovableOrphan(entry, currentPort) {
  const match = ORIGIN_DIRECTORY_PATTERN.exec(entry.name);
  if (match === null) return false;
  const port = Number.parseInt(match[1], 10);
  if (!Number.isInteger(port)) return false;
  // 当前会话的数据就在这里，删了就是删用户数据。
  if (port === currentPort) return false;
  // 固定端口的库一律保留：用户可能正常用过其中之一。
  if (PREFERRED_PORTS.includes(port)) return false;
  return true;
}

/**
 * 执行清理。**同步**调用即可（只在启动后跑一次，目录数量很少）。
 *
 * @param {object} options
 * @param {string} options.userDataDirectory
 * @param {number} options.currentPort 本次会话实际使用的端口
 * @param {boolean} [options.force] 忽略"已迁移"标记（测试用）
 * @returns {{status: string, removed?: string[], kept?: number, reason?: string, freedBytes?: number}}
 */
function cleanupOrphanedStorage({ userDataDirectory, currentPort, force = false }) {
  // 没跑在固定端口上就完全不碰：这种情况下无法安全区分孤儿与当前数据。
  if (!PREFERRED_PORTS.includes(currentPort)) {
    return { status: 'skipped', reason: `current-port-not-fixed(${currentPort})` };
  }
  if (!force && alreadyMigrated(userDataDirectory)) {
    return { status: 'already-done' };
  }

  const indexedDbDirectory = path.join(userDataDirectory, 'IndexedDB');
  let entries;
  try {
    entries = fs.readdirSync(indexedDbDirectory, { withFileTypes: true });
  } catch {
    // 还没有 IndexedDB 目录：全新安装，记一笔标记即可。
    writeMarker(userDataDirectory, { removed: [], note: 'no-indexeddb-directory' });
    return { status: 'nothing-to-do', removed: [] };
  }

  const removed = [];
  let kept = 0;
  let freedBytes = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!isRemovableOrphan(entry, currentPort)) {
      kept += 1;
      continue;
    }
    const target = path.join(indexedDbDirectory, entry.name);
    try {
      freedBytes += directorySize(target);
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 3 });
      removed.push(entry.name);
    } catch {
      // 单个目录删不掉（被占用等）不影响其它目录，留着下次再说。
      kept += 1;
    }
  }

  writeMarker(userDataDirectory, {
    removed,
    kept,
    freedBytes,
    currentPort,
    note: 'removed legacy random-port origins',
  });

  return { status: 'completed', removed, kept, freedBytes };
}

function directorySize(directory) {
  let total = 0;
  const walk = current => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        try {
          total += fs.statSync(full).size;
        } catch {
          // 忽略读不到的文件。
        }
      }
    }
  };
  walk(directory);
  return total;
}

module.exports = {
  cleanupOrphanedStorage,
  isRemovableOrphan,
  PREFERRED_PORTS,
  MARKER_NAME,
};
