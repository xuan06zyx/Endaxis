'use strict';

/**
 * "检查更新"窗口：更新源（镜像）选择 + 测速 + 检查更新。
 *
 * 为什么单独一个窗口：这些是**用户主动操作**，需要表格、按钮和结果区；
 * 而主窗口右下角的浮层只负责"不打扰人"地显示进度。两者职责不同——
 * 早期版本把一切都塞进模态弹窗，会挡住用户刚打开程序就要做的事。
 *
 * 窗口是单例：重复点菜单只聚焦已有窗口，不叠加。
 */

const fs = require('node:fs');
const path = require('node:path');
const { BrowserWindow, shell } = require('electron');

/** 与 src/source-preload.js 里的常量必须一致。 */
const CHANNEL_GET_STATE = 'endaxis:source:get-state';
const CHANNEL_SELECT = 'endaxis:source:select';
const CHANNEL_TEST = 'endaxis:source:test';
const CHANNEL_QUERY = 'endaxis:source:query';
const CHANNEL_DOWNLOAD = 'endaxis:source:download';
const CHANNEL_INSTALL = 'endaxis:source:install';
const CHANNEL_OPEN_LIST = 'endaxis:source:open-list';

let sourceWindow = null;

/**
 * 打开（或聚焦）检查更新窗口。
 *
 * @param {object} options
 * @param {object} options.updater createUpdater 的返回值
 * @param {BrowserWindow|null} options.parent
 * @returns {BrowserWindow}
 */
function openSourceWindow({ updater, parent }) {
  if (sourceWindow !== null && !sourceWindow.isDestroyed()) {
    sourceWindow.focus();
    return sourceWindow;
  }

  const window = new BrowserWindow({
    width: 720,
    height: 560,
    minWidth: 640,
    minHeight: 480,
    title: '检查更新',
    parent: parent ?? undefined,
    // 不设 modal：用户可以开着它继续操作主窗口，符合"别挡路"的要求。
    modal: false,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#1b1d21',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      preload: path.join(__dirname, '..', 'source-preload.js'),
    },
  });

  const page = path.join(__dirname, '..', 'renderer', 'source-window.html');
  if (!fs.existsSync(page)) {
    window.destroy();
    throw new Error(`缺少检查更新页面：${page}`);
  }
  void window.loadFile(page);
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    sourceWindow = null;
  });

  // 只允许在系统浏览器里打开 http(s) 链接，不在应用内导航。
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL() && /^https?:\/\//i.test(url)) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  // ── IPC：全部按白名单绑定，不做动态频道转发 ─────────────────────────
  const { ipcMain } = require('electron');
  const handle = (channel, listener) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (_event, ...args) => listener(...args));
  };

  handle(CHANNEL_GET_STATE, () => updater.describeSources());
  handle(CHANNEL_SELECT, mirrorId => updater.selectMirror(String(mirrorId ?? '')));
  handle(CHANNEL_TEST, () => updater.runSpeedTest());
  handle(CHANNEL_QUERY, () => updater.queryLatest());
  handle(CHANNEL_DOWNLOAD, () => updater.startDownload());
  handle(CHANNEL_INSTALL, () => updater.installNow());
  handle(CHANNEL_OPEN_LIST, () => {
    const { MIRROR_LIST_URL } = require('./mirrors');
    void shell.openExternal(MIRROR_LIST_URL);
    return { ok: true };
  });

  sourceWindow = window;
  return window;
}

/** 主进程退出时调用，避免残留 handler 在测试里互相干扰。 */
function disposeSourceWindow() {
  if (sourceWindow !== null && !sourceWindow.isDestroyed()) sourceWindow.destroy();
  sourceWindow = null;
}

module.exports = { openSourceWindow, disposeSourceWindow };
