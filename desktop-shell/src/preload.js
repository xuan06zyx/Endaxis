'use strict';

/**
 * 桌面壳的 preload。
 *
 * 只做一件事：在窗口关闭时，配合主进程把项目自动保存**真正写进磁盘**。
 *
 * 为什么需要它：项目自动保存是合并写入的（防抖），改动会在渲染进程里排队。
 * 用户改完立刻关程序时，渲染进程会先于 IndexedDB 事务提交被销毁，那次改动就丢了。
 * 渲染进程自己拦不住这件事，必须由主进程推迟关闭、等待写入完成——这里的
 * `window.EndaxisDesktop` 就是双方约定的接口。
 *
 * ── 沙箱约束（踩过两次，改这里之前务必先读）────────────────────────────
 * 本文件运行在 `sandbox: true` 的预加载环境里，**只能 `require('electron')`**：
 *
 *   - `require('node:fs')` → "module not found: node:fs"
 *   - `require('./main/closeCoordinator')` → "module not found: ..."
 *
 * 两种写法都会让 preload **整个静默失效**，只在主进程的 `preload-error`
 * 事件里留一行线索；表现出来就是"关窗依然丢数据"，极难定位。
 * 所以：频道名在这里写成字面量，两侧的一致性由
 * tools/verify-close-flush.js 端到端守住（它是真的关掉再重开一次进程）。
 *
 * 注意：**不注入**上游 `window.EndaxisNative` 那套原生桥接。那套只在 UA 带
 * `EndaxisApp/` 标记时才被调用，而本壳刻意不声明该标记（声明了时间轴会被强制
 * 切成移动工作台），所以不需要、也不应该提供。
 */

const { contextBridge, ipcRenderer } = require('electron');

/** 与 src/main/closeCoordinator.js 里的同名常量必须一致。 */
const CHANNEL_FLUSH_REQUEST = 'endaxis:flush-saves';
const CHANNEL_FLUSH_DONE = 'endaxis:flush-saves-done';

/** 与 src/main/updater.js 里的同名常量必须一致。 */
const CHANNEL_UPDATE_STATUS = 'update:status';

/** 与 tools/update-overlay.js 约定：浮层把结果写在这里，不暴露任何可调用方法。 */
const OVERLAY_ROOT_ID = '__endaxis_update_overlay__';

/**
 * 把更新状态推给页面里的浮层。
 *
 * 刻意**不**通过 contextBridge 暴露任何方法：那样页面（也就是上游前端）就能
 * 调用主进程能力，一旦前端被注入恶意代码即可提权。这里只做单向数据推入——
 * 把状态写进 DOM 的 data-* 属性再派发一个事件，浮层只管显示，没有任何权力。
 *
 * 浮层脚本还没执行时事件会丢，所以主进程每 1 秒重发一次当前状态；
 * 浮层一出现就会拿到最新值（下载进度变化本来就比这密）。
 */
function pushUpdateStatus(payload) {
  try {
    const root = document.getElementById(OVERLAY_ROOT_ID);
    if (root === null) return;
    // 用 setAttribute 而不是 dataset：contextIsolation 下两个世界共享 DOM，
    // 属性的读写一定生效，而 dataset 依赖 DOMStringMap 包装对象，跨世界不保险。
    root.setAttribute('data-version', payload?.version ?? '');
    root.setAttribute('data-percent', String(payload?.percent ?? ''));
    root.setAttribute('data-transferred', String(payload?.transferred ?? ''));
    root.setAttribute('data-total', String(payload?.total ?? ''));
    root.setAttribute('data-speed', String(payload?.bytesPerSecond ?? ''));
    root.setAttribute('data-error', payload?.error ?? '');
    root.setAttribute('data-state', payload?.state ?? 'idle');
    root.dispatchEvent(new CustomEvent('endaxis:update-status'));
  } catch {
    // document 还不存在等情况，忽略即可——主进程会重发。
  }
}

ipcRenderer.on(CHANNEL_UPDATE_STATUS, (_event, payload) => {
  pushUpdateStatus(payload);
});

/** 由渲染进程（TimelineEditor）注册进来：把排队的保存写落地并等它写完。 */
let flushHandler = null;

contextBridge.exposeInMainWorld('EndaxisDesktop', {
  /**
   * @param {() => Promise<void>} handler
   */
  onFlushSaves(handler) {
    if (typeof handler !== 'function') return;
    flushHandler = handler;
  },
});

ipcRenderer.on(CHANNEL_FLUSH_REQUEST, () => {
  const finish = () => {
    try {
      ipcRenderer.send(CHANNEL_FLUSH_DONE);
    } catch {
      // 主进程可能已经在退出，忽略。
    }
  };
  // 即使没有 handler 也必须回报，否则主进程只能干等到超时。
  if (flushHandler === null) {
    finish();
    return;
  }
  // 成功或失败都要回报，避免把关闭流程拖到超时。
  Promise.resolve()
    .then(() => flushHandler())
    .catch(() => {})
    .then(finish);
});
