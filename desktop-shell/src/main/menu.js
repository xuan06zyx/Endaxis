'use strict';

const { Menu, shell, app, dialog } = require('electron');
const { selectStrings } = require('./strings');
const { APP_NAME } = require('./config');

/**
 * 构建应用内菜单栏。
 *
 * 不隐藏菜单栏：`Alt` 只是快捷键，而“打开数据目录 / 关于 / 重新加载”是本地版
 * 用户唯一可见的入口，隐藏后没有替代路径。
 */

/**
 * @param {object} options
 * @param {import('electron').BrowserWindow} options.window
 * @param {boolean} options.isDevelopment
 * @param {string} [options.websiteUrl]
 * @param {() => void} [options.onCheckForUpdates]
 */
function buildApplicationMenu({ window, isDevelopment, websiteUrl, onCheckForUpdates }) {
  const text = selectStrings(app.getLocale());
  const { webContents } = window;

  const aboutDetail = text.aboutDetail + (isDevelopment ? text.aboutDetailDev : '');

  const template = [
    {
      label: text.file,
      submenu: [{ role: 'quit', label: text.close }],
    },
    {
      label: text.edit,
      submenu: [
        { role: 'undo', label: 'Undo' },
        { role: 'redo', label: 'Redo' },
        { type: 'separator' },
        { role: 'cut', label: 'Cut' },
        { role: 'copy', label: 'Copy' },
        { role: 'paste', label: 'Paste' },
        { role: 'selectAll', label: 'Select All' },
      ],
    },
    {
      label: text.view,
      submenu: [
        { label: text.reload, accelerator: 'CmdOrCtrl+R', click: () => webContents.reload() },
        {
          label: text.forceReload,
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => webContents.reloadIgnoringCache(),
        },
        { type: 'separator' },
        {
          label: text.toggleDevTools,
          accelerator: 'CmdOrCtrl+Shift+I',
          click: () => webContents.toggleDevTools(),
        },
        { type: 'separator' },
        {
          label: text.resetZoom,
          accelerator: 'CmdOrCtrl+0',
          click: () => webContents.setZoomLevel(0),
        },
        {
          label: text.zoomIn,
          accelerator: 'CmdOrCtrl+Plus',
          click: () => stepZoom(webContents, 0.5),
        },
        {
          label: text.zoomOut,
          accelerator: 'CmdOrCtrl+-',
          click: () => stepZoom(webContents, -0.5),
        },
        { type: 'separator' },
        { label: text.toggleFullScreen, role: 'togglefullscreen' },
      ],
    },
    {
      label: text.window,
      submenu: [
        { label: text.minimize, role: 'minimize' },
        { label: text.close, role: 'close' },
      ],
    },
    {
      label: text.help,
      submenu: [
        ...(onCheckForUpdates
          ? [{ label: text.checkUpdates, click: () => onCheckForUpdates() }, { type: 'separator' }]
          : []),
        ...(websiteUrl
          ? [
              {
                label: text.openInBrowser,
                click: () => void shell.openExternal(websiteUrl),
              },
            ]
          : []),
        {
          label: text.openUserData,
          click: async () => {
            const failure = await shell.openPath(app.getPath('userData'));
            if (failure) {
              dialog.showErrorBox(APP_NAME, `${text.userDataError}\n${failure}`);
            }
          },
        },
        { type: 'separator' },
        {
          label: text.about,
          click: () => {
            dialog.showMessageBox(window, {
              type: 'info',
              title: text.about,
              message: APP_NAME,
              detail: aboutDetail,
              buttons: [text.ok],
              noLink: true,
            });
          },
        },
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}

/** 每次 0.5 级，并夹在 Electron 允许的缩放区间内。 */
function stepZoom(webContents, delta) {
  const next = Math.min(3, Math.max(-3, webContents.getZoomLevel() + delta));
  webContents.setZoomLevel(next);
}

module.exports = { buildApplicationMenu };
