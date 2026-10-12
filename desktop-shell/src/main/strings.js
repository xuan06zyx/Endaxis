'use strict';

/**
 * 桌面壳自带的应用内菜单文案。
 * 只服务壳自身的菜单栏；网页内容本身的界面语言由项目内的 vue-i18n 管理。
 */

const STRINGS = {
  'zh-CN': {
    file: '文件',
    edit: '编辑',
    view: '视图',
    window: '窗口',
    help: '帮助',
    reload: '重新加载',
    forceReload: '强制重新加载',
    toggleDevTools: '开发者工具',
    resetZoom: '实际大小',
    zoomIn: '放大',
    zoomOut: '缩小',
    toggleFullScreen: '切换全屏',
    minimize: '最小化',
    close: '关闭窗口',
    openInBrowser: '在系统浏览器中打开官网',
    openUserData: '打开数据目录',
    checkUpdates: '检查更新…',
    about: '关于 Endaxis 本地版',
    aboutDetail:
      'Endaxis 本地版桌面壳（Electron）\n\n' +
      'Endaxis —— 《明日方舟：终末地》排轴工具。\n' +
      '网页部分版权归原项目所有：https://github.com/Lieyuan621/Endaxis\n\n' +
      '本应用为粉丝自制工具，与游戏官方无关。',
    aboutDetailDev: '\n\n【开发模式】当前内容由 Vite 开发服务器提供。',
    userDataError: '无法打开数据目录。',
    ok: '确定',
  },
  'en-US': {
    file: 'File',
    edit: 'Edit',
    view: 'View',
    window: 'Window',
    help: 'Help',
    reload: 'Reload',
    forceReload: 'Force Reload',
    toggleDevTools: 'Developer Tools',
    resetZoom: 'Actual Size',
    zoomIn: 'Zoom In',
    zoomOut: 'Zoom Out',
    toggleFullScreen: 'Toggle Full Screen',
    minimize: 'Minimize',
    close: 'Close Window',
    openInBrowser: 'Open official site in browser',
    openUserData: 'Open data folder',
    checkUpdates: 'Check for Updates…',
    about: 'About Endaxis Desktop',
    aboutDetail:
      'Endaxis Desktop — an Electron shell around the Endaxis web app.\n\n' +
      'Endaxis is a timeline editor for Arknights: Endfield.\n' +
      'The web application belongs to the original project: https://github.com/Lieyuan621/Endaxis\n\n' +
      'Fan-made tool, not affiliated with the game publisher.',
    aboutDetailDev: '\n\n[Development] Content is served by the Vite dev server.',
    userDataError: 'Could not open the data folder.',
    ok: 'OK',
  },
};

/** 跟随系统语言选择菜单语言；未覆盖的语言回落英文。 */
function selectStrings(locale) {
  return locale && locale.toLowerCase().startsWith('zh') ? STRINGS['zh-CN'] : STRINGS['en-US'];
}

module.exports = { STRINGS, selectStrings };
