'use strict';

/**
 * 测试用 preload：统计 endaxis-timeline 库 projects 对象的写事务。
 *
 * 为什么需要 preload：页面脚本可能在 `did-start-navigation` 之前就取走了
 * `IDBDatabase` 实例，用主进程事后注入的方式挂钩不可靠。preload 在文档创建之前
 * 执行，能稳定覆盖到应用真正使用的那个实例。
 *
 * 只在 verify-autosave 里使用，不参与正式打包。
 */

const { contextBridge } = require('electron');

const INSTRUMENT = `
(() => {
  const state = { writes: [], reads: [] };
  window.__endaxisSaveProbe = state;
  const originalTransaction = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function (stores, mode, ...rest) {
    const names = Array.isArray(stores) ? stores : [stores];
    const isProjectStore = names.includes('projects');
    if (isProjectStore) {
      if (mode === 'readwrite') state.writes.push(Date.now());
      else state.reads.push(Date.now());
    }
    return originalTransaction.call(this, stores, mode, ...rest);
  };
})();
`;

try {
  // 主世界：应用代码运行的地方，必须挂在这里才拦得住。
  contextBridge.executeInMainWorld({ func: new Function(INSTRUMENT) });
  // 隔离世界：验证脚本走 executeJavaScript 读计数器用。
  new Function(INSTRUMENT)();
} catch (error) {
  console.error(`[autosave-probe] preload 注入失败：${error?.message ?? error}`);
}
