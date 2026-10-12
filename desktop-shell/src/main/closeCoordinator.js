'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ipcMain } = require('electron');

/**
 * 关窗时等待项目保存落地。
 *
 * 背景（这是真实踩过的数据丢失）：项目自动保存是**合并写入**的，改动会先在
 * 渲染进程里排队最多 1.2 秒。用户改完立刻关程序时，渲染进程会在 IndexedDB
 * 事务提交之前就被销毁，那次改动直接消失——重新打开还是旧内容。
 *
 * 光靠渲染进程的 `beforeunload` 不够：它只能**发起**写入，没法阻止自己随后
 * 被销毁。所以这里由主进程接管关闭流程：
 *
 *   1. 窗口要关时先拦下来（推迟关闭）；
 *   2. 让渲染进程把排队的改动交出去，并等它把全部写入完成；
 *   3. 再真正关闭窗口。
 *
 * 渲染进程通过 preload 回报 `flush-done`（渲染侧见 src/preload.js）。
 */

/** 等待上限：即使渲染进程没回应，也不能让用户关不掉窗口。 */
const FLUSH_TIMEOUT_MS = 4000;

const CHANNEL_FLUSH_REQUEST = 'endaxis:flush-saves';
const CHANNEL_FLUSH_DONE = 'endaxis:flush-saves-done';

/** 诊断落盘：只在探针模式下写，用来追"关窗丢数据"这类问题。 */
function trace(step) {
  if (process.env.ENDAXIS_CLOSE_TRACE !== '1') return;
  try {
    fs.appendFileSync(
      path.join(os.tmpdir(), 'endaxis-close-trace.log'),
      `[${new Date().toISOString()}] coordinator: ${step}\n`,
      'utf8',
    );
  } catch {
    // 记录失败不影响关闭流程。
  }
}

function createCloseCoordinator() {
  /** 同一时刻只可能有一个窗口在关闭。 */
  let pending = null;

  ipcMain.on(CHANNEL_FLUSH_DONE, (event, payload) => {
    const detail = typeof payload === 'string' ? payload : '(无说明)';
    if (detail === 'handler-registered') {
      // 桥注册成功，不算一次 flush 完成。
      trace('渲染进程已注册 flush 处理函数');
      return;
    }
    trace(`收到 flush-done：${detail}（sender=${event.sender.id}）`);
    if (pending === null || pending.webContentsId !== event.sender.id) return;
    const entry = pending;
    pending = null;
    clearTimeout(entry.timer);
    entry.resolve(true);
  });

  return {
    /**
     * 请渲染进程把排队/进行中的保存写完。
     * @returns {Promise<boolean>} true = 写入已完成；false = 超时（仍然关闭）。
     */
    flushSaves(window) {
      if (window === null || window.isDestroyed()) return Promise.resolve(true);
      const webContents = window.webContents;
      if (webContents === undefined || webContents.isDestroyed()) return Promise.resolve(true);
      if (typeof webContents.send !== 'function') return Promise.resolve(true);

      return new Promise(resolve => {
        const entry = { webContentsId: webContents.id, resolve, timer: null };
        entry.timer = setTimeout(() => {
          if (pending === entry) pending = null;
          trace('等待保存超时，放行关闭');
          resolve(false);
        }, FLUSH_TIMEOUT_MS);
        pending = entry;
        trace(`请求渲染进程写完保存（webContents=${webContents.id}）`);
        webContents.send(CHANNEL_FLUSH_REQUEST);
      });
    },
  };
}

module.exports = {
  createCloseCoordinator,
  /**
   * 给窗口挂上"关窗前等保存落地"的行为。
   *
   * 抽成函数是为了让工具也能复用**完全相同**的逻辑：只是渲染页面、
   * 不复刻主进程行为的测试，会测出虚假的"写入丢失"（第一版验证脚本就栽在这里）。
   *
   * @param {import('electron').BrowserWindow} window
   * @param {{ onTimeout?: () => void }} [options]
   */
  attachCloseFlush(window, options = {}) {
    let forceClosing = false;
    const coordinator = createCloseCoordinator();

    window.on('close', event => {
      if (forceClosing) return;
      event.preventDefault();
      void (async () => {
        const flushed = await coordinator.flushSaves(window);
        if (!flushed) options.onTimeout?.();
        forceClosing = true;
        if (!window.isDestroyed()) window.close();
      })();
    });

    return coordinator;
  },
  CHANNEL_FLUSH_REQUEST,
  CHANNEL_FLUSH_DONE,
  FLUSH_TIMEOUT_MS,
};
