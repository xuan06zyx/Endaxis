'use strict';

/**
 * 桌面壳的本地偏好设置（当前只存更新源镜像的选择）。
 *
 * 为什么单独一个文件：镜像选择必须跨启动保留——无法直连 GitHub 的用户如果每次
 * 开程序都要手动切一次镜像，那等于这个功能没做。
 *
 * 刻意做得很"钝"：同步读写、失败就回退默认值、绝不抛错。偏好文件损坏或权限
 * 异常都不该影响更新功能可用性；宁可退回直连，也不能让程序起不来。
 */

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

function preferencesPath() {
  return path.join(app.getPath('userData'), 'desktop-preferences.json');
}

/**
 * @returns {{mirrorId?: string}} 读取失败或文件不存在时返回空对象。
 */
function readPreferences() {
  try {
    const raw = fs.readFileSync(preferencesPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 合并写入。写入失败只记不抛：偏好丢了顶多是回到默认源，用户还能手动再选。
 *
 * @param {object} patch
 * @returns {boolean} 是否写入成功
 */
function writePreferences(patch) {
  try {
    const merged = { ...readPreferences(), ...patch };
    fs.mkdirSync(path.dirname(preferencesPath()), { recursive: true });
    fs.writeFileSync(preferencesPath(), `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

module.exports = { readPreferences, writePreferences, preferencesPath };
