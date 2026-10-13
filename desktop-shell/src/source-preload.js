'use strict';

/**
 * "检查更新"窗口的 preload。
 *
 * 与主窗口的 preload 刻意不同：主窗口那个**不暴露任何方法**（因为页面是上游前端，
 * 暴露方法等于给它提权）；而这个窗口加载的是我们自己的本地页面，所以按白名单
 * 暴露一组最小能力是合适的。
 *
 * 沙箱约束同 src/preload.js：只 `require('electron')`。
 */

const { contextBridge, ipcRenderer } = require('electron');

/** 与 src/main/sourceWindow.js 里的常量必须一致。 */
const CHANNEL_GET_STATE = 'endaxis:source:get-state';
const CHANNEL_SELECT = 'endaxis:source:select';
const CHANNEL_TEST = 'endaxis:source:test';
const CHANNEL_QUERY = 'endaxis:source:query';
const CHANNEL_DOWNLOAD = 'endaxis:source:download';
const CHANNEL_INSTALL = 'endaxis:source:install';
const CHANNEL_OPEN_LIST = 'endaxis:source:open-list';
/** 主进程推送的更新状态（与浮层共用同一路事件）。 */
const CHANNEL_PROGRESS = 'update:status';

contextBridge.exposeInMainWorld('EndaxisSource', {
  getState: () => ipcRenderer.invoke(CHANNEL_GET_STATE),
  selectMirror: mirrorId => ipcRenderer.invoke(CHANNEL_SELECT, mirrorId),
  testMirrors: () => ipcRenderer.invoke(CHANNEL_TEST),
  queryLatest: () => ipcRenderer.invoke(CHANNEL_QUERY),
  startDownload: () => ipcRenderer.invoke(CHANNEL_DOWNLOAD),
  installNow: () => ipcRenderer.invoke(CHANNEL_INSTALL),
  openMirrorList: () => ipcRenderer.invoke(CHANNEL_OPEN_LIST),
  /**
   * 订阅下载进度。
   *
   * @param {(payload: object) => void} handler
   * @returns {() => void} 取消订阅
   */
  onProgress(handler) {
    if (typeof handler !== 'function') return () => {};
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on(CHANNEL_PROGRESS, listener);
    return () => ipcRenderer.removeListener(CHANNEL_PROGRESS, listener);
  },
});
