'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { screen } = require('electron');

/**
 * 记住窗口大小、位置与最大化状态。
 * 位置保存的是 DIP（设备无关像素），不同 DPI 显示器之间切换也保持一致。
 */

const STATE_FILE_NAME = 'window-state.json';
const DEFAULT_BOUNDS = { width: 1600, height: 950 };
const MINIMUM_SIZE = { width: 960, height: 640 };

function sanitizeBounds(candidate) {
  if (typeof candidate !== 'object' || candidate === null) return null;
  const { x, y, width, height } = candidate;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  const safe = {
    width: Math.max(MINIMUM_SIZE.width, Math.round(width)),
    height: Math.max(MINIMUM_SIZE.height, Math.round(height)),
  };
  if (Number.isFinite(x) && Number.isFinite(y)) {
    safe.x = Math.round(x);
    safe.y = Math.round(y);
  }
  return safe;
}

/** 位置必须与某块屏幕的工作区有足够交集，否则丢弃位置只在主屏居中。 */
function isOnSomeDisplay(bounds) {
  if (bounds.x === undefined || bounds.y === undefined) return false;
  const visible = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
  return screen.getAllDisplays().some(display => {
    const area = display.workArea;
    const overlapX =
      Math.min(visible.x + visible.width, area.x + area.width) - Math.max(visible.x, area.x);
    const overlapY =
      Math.min(visible.y + visible.height, area.y + area.height) - Math.max(visible.y, area.y);
    return overlapX >= 120 && overlapY >= 80;
  });
}

function readWindowState(userDataDirectory) {
  const file = path.join(userDataDirectory, STATE_FILE_NAME);
  let stored;
  try {
    stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { bounds: { ...DEFAULT_BOUNDS }, maximized: false };
  }

  const bounds = sanitizeBounds(stored?.bounds) ?? { ...DEFAULT_BOUNDS };
  const usable = isOnSomeDisplay(bounds) ? bounds : { width: bounds.width, height: bounds.height };
  return { bounds: usable, maximized: stored?.maximized === true };
}

function createWindowStateWriter(userDataDirectory) {
  const file = path.join(userDataDirectory, STATE_FILE_NAME);
  let pending = null;
  let timer = null;

  const flush = () => {
    timer = null;
    if (pending === null) return;
    const snapshot = pending;
    pending = null;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(snapshot, null, 2), 'utf8');
    } catch {
      // 窗口状态只是体验优化，写失败不能影响使用。
    }
  };

  return {
    /** 防抖保存：拖动窗口时不会每帧写盘。 */
    save(state) {
      pending = state;
      if (timer !== null) return;
      timer = setTimeout(flush, 400);
      timer.unref?.();
    },
    flushNow: flush,
  };
}

/** 采集当前窗口状态；最大化/全屏时保留普通态尺寸，恢复后不会变小。 */
function captureWindowState(browserWindow) {
  const maximized = browserWindow.isMaximized();
  const normal =
    maximized || browserWindow.isFullScreen()
      ? browserWindow.getNormalBounds()
      : browserWindow.getBounds();
  return { bounds: sanitizeBounds(normal) ?? { ...DEFAULT_BOUNDS }, maximized };
}

module.exports = {
  DEFAULT_BOUNDS,
  MINIMUM_SIZE,
  readWindowState,
  createWindowStateWriter,
  captureWindowState,
};
