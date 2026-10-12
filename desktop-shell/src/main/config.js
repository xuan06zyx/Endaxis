'use strict';

const path = require('node:path');
const { app } = require('electron');

/**
 * 套壳配置：桌面壳的真实来源。
 *
 * 关键设计：**不**伪造 `EndaxisApp/` UA 标记。
 * `src/ui/timeline/timelineLayoutPolicy.ts` 规定“Endaxis 原生壳始终使用移动工作台”，
 * 详见 docs/architecture/runtime-environment.md。桌面壳若声明该标记，时间轴会被强制
 * 切成手机版工作台。因此这里只声明一个普通 Windows 桌面 Chrome 身份，让项目按自身
 * 规则选择桌面工作台；桥接能力（back / appReady）本壳也没有可以实现的原生语义。
 */
const APP_NAME = 'Endaxis';
const APP_ID = 'com.endaxis.desktop';

/**
 * 应用图标。
 *
 * 打包后由 extraResources 放到 `resources/icon.png`（exe 自身的图标由
 * electron-builder 写进 PE 资源）；开发时直接用 build/ 里生成的那张。
 */
function resolveAppIcon() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'icon.png');
  }
  return path.join(__dirname, '..', '..', 'build', 'icon.png');
}

/**
 * 去掉 Electron 与应用的 UA 标识，得到一个普通桌面 Chrome UA。
 * 保留 `Electron/x` 会让部分站点/库走特殊分支，这里不需要。
 */
function buildUserAgent() {
  const chromeVersion = process.versions.chrome ?? '120.0.0.0';
  return (
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    `(KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`
  );
}

/** 被 Electron 拒绝的权限（不向用户弹出无意义的系统授权框）。 */ const DENIED_PERMISSIONS =
  new Set([
    'geolocation',
    'midi',
    'midiSysex',
    'hid',
    'serial',
    'usb',
    'idle-detection',
    'storage-access',
    'top-level-storage-access',
  ]);

module.exports = {
  APP_NAME,
  APP_ID,
  buildUserAgent,
  resolveAppIcon,
  DENIED_PERMISSIONS,
};
