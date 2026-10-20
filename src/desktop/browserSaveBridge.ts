import type { EndaxisProjectDocument } from '../core/project/schema';
import { saveBrowserProject } from '../data/browserProjectStorage';

/**
 * 浏览器自动保存的合并写入（防抖）与关窗落盘。
 *
 * ── 为什么单独一个文件 ──────────────────────────────────────────────
 * 这段逻辑原本直接写在上游的 `src/ui/timeline/projectFileSession.ts` 里，让该文件
 * 多了 130 行改动。后果是上游一旦重构这个文件就产生冲突 —— 实际上已经冲突过两次
 * （其中一次是上游把 `selectProjectExportScope` 搬到新模块）。
 *
 * 现在改成：逻辑放这里（新文件，上游永不触碰），上游那边只保留**一处调用**
 * `queueBrowserSave(snapshot.project)`。补丁面从 130 行降到 1 行调用 + 1 行导入。
 *
 * ── 合并写入的两个参数 ─────────────────────────────────────────────
 * 1. 防抖窗口：每次提交都立刻写 IndexedDB，拖拽和连续输入会产生大量短事务。
 * 2. 最长等待：只有防抖不够 —— 持续编辑会一直"又改了"，写入被无限推迟。
 *    超过上限就强制落盘一次，保证保存进度始终在推进。
 *
 * ── 关窗落盘 ──────────────────────────────────────────────────────
 * 渲染进程会在 IndexedDB 事务提交之前被销毁，所以"发起写入"不等于"写进磁盘"。
 * 桌面壳关窗前会通过 preload 调用这里，等真正写完才放行关闭。
 */

/** 连续编辑的合并窗口：宁可晚 1.2 秒落盘，也不要每帧都开事务。 */
const DEBOUNCE_MS = 1200;
/** 最长等待：持续编辑时强制落盘的兜底上限。 */
const MAX_WAIT_MS = 15_000;
/**
 * 关窗等待上限。
 *
 * 比桌面壳那边的等待（4 秒）短一点，保证壳等我们、我们不拖住壳。
 * 本地 IndexedDB 写入通常几毫秒，超时只是兜底，避免"关不掉的窗口"。
 */
const FLUSH_TIMEOUT_MS = 3_000;

interface Waiter {
  resolve: () => void;
  reject: (error: Error) => void;
}

/** 已合并但尚未写盘的文档。 */
let queuedProject: EndaxisProjectDocument | null = null;
/** 等待这批改动落盘的调用方（每笔编辑一个 Promise）。 */
let queuedWaiters: Waiter[] = [];
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let firstQueuedAt = 0;
/**
 * 上一次真正开始写入的时间。
 *
 * 用来实现首写优先 + 冷却：一次新编辑若距上次写入不足一个防抖窗口，就走合并路径，
 * 而不是又开一次事务。没有这个冷却，拖拽时每帧都会命中"空闲"分支，合并形同虚设。
 */
let lastWriteStartedAt = 0;
/** 正在进行的写入数量（用于关窗前等待）。 */
let inFlight = 0;

function clearTimer(): void {
  if (debounceTimer === null) return;
  clearTimeout(debounceTimer);
  debounceTimer = null;
}

/**
 * 把排队的改动立刻写盘。
 *
 * 没有排队时什么也不做 —— 调用方可能只是想"顺手 flush 一下"。
 */
export async function flushBrowserSave(): Promise<void> {
  clearTimer();
  const project = queuedProject;
  const waiters = queuedWaiters;
  if (project === null) return;

  queuedProject = null;
  queuedWaiters = [];
  firstQueuedAt = 0;

  inFlight += 1;
  lastWriteStartedAt = Date.now();
  try {
    await saveBrowserProject(project);
    for (const waiter of waiters) waiter.resolve();
  } catch (error) {
    // 统一成 Error 再交给上游：上游的 .then(ok, error) 会读 error.message。
    const failure = error instanceof Error ? error : new Error(String(error));
    for (const waiter of waiters) waiter.reject(failure);
  } finally {
    inFlight -= 1;
  }
}

/**
 * 关窗前调用：把排队的改动交出去，并**等它真正写完**。
 *
 * 返回的 Promise 一定 resolve（超时也放行），因为"关不掉的窗口"比丢数据更难解释，
 * 而且此时已经尽力写过一次了。
 *
 * 注意这里**不能只 await 那次写入**：IndexedDB 卡死时它永不结算，于是"关窗等待"
 * 就变成"永不返回"。桌面壳虽然有自己的超时兜底，但等待上限应当由本模块自己保证。
 */
export async function flushBrowserSaveAndWait(): Promise<void> {
  const deadline = Date.now() + FLUSH_TIMEOUT_MS;
  const write = flushBrowserSave().catch(() => {
    // 写失败也要放行关闭：上游会把错误显示给用户，卡住窗口没有意义。
  });

  let timer: ReturnType<typeof setTimeout> | null = null;
  const timedOut = new Promise<void>(resolve => {
    timer = setTimeout(resolve, FLUSH_TIMEOUT_MS);
  });
  try {
    await Promise.race([write, timedOut]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }

  // 即使写超时，也把已经结束的写入机会等到上限为止。
  while (inFlight > 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

/**
 * 提交一次自动保存。
 *
 * 两条路径，行为差别是刻意的：
 *
 * 1. **队列空闲时立刻写，并原样返回 `saveBrowserProject` 的 Promise**。
 *    上游的代码与测试都锚定"提交后立即落盘"的微任务时序；只要我们多包装一层，
 *    时序就会错开一个微任务，上游的测试会挂，而且这种"就差一拍"的问题极难排查。
 *    直接返回原 Promise 可以让第一次编辑的时序与上游完全一致。
 *
 * 2. **队列非空时走合并**：连续编辑（拖拽、连续输入）只会产生一次写入，
 *    这才是减少 IndexedDB 短事务的关键。
 */
export function queueBrowserSave(project: EndaxisProjectDocument): Promise<void> {
  const idle = queuedProject === null && debounceTimer === null && inFlight === 0;
  // 冷却窗口内不再开新事务，交给尾部的合并写入。
  const coolingDown = Date.now() - lastWriteStartedAt < DEBOUNCE_MS;
  if (idle && !coolingDown) {
    lastWriteStartedAt = Date.now();
    return trackInFlight(saveBrowserProject(project));
  }

  queuedProject = project;
  if (firstQueuedAt === 0) firstQueuedAt = Date.now();

  const promise = new Promise<void>((resolve, reject) => {
    queuedWaiters.push({ resolve, reject });
  });

  clearTimer();
  const waited = Date.now() - firstQueuedAt;
  if (waited >= MAX_WAIT_MS) {
    // 已经等太久，立刻落盘，别再往后拖。
    void flushBrowserSave();
    return promise;
  }
  debounceTimer = setTimeout(
    () => void flushBrowserSave(),
    Math.min(DEBOUNCE_MS, MAX_WAIT_MS - waited),
  );
  return promise;
}

/**
 * 登记一次进行中的写入，但不改变调用方拿到的 Promise。
 *
 * 关窗等待需要知道"还有写入没结束"，可这个信息不能靠包装返回值获得 ——
 * 包装会改变微任务时序（见 queueBrowserSave 注释）。
 */
function trackInFlight(write: Promise<void>): Promise<void> {
  inFlight += 1;
  const done = () => {
    inFlight -= 1;
  };
  // 这个分支只用于计计数，失败已经由调用方处理，不能再抛出去。
  write.then(done, done);
  return write;
}

/** 是否有尚未落盘的改动（供离页保护判断）。 */
export function hasPendingBrowserSave(): boolean {
  return queuedProject !== null || inFlight > 0;
}

/**
 * 与桌面壳接线 + 离页保护。
 *
 * 用模块级副作用，而不是让 `TimelineEditor.vue` 显式注册：
 * - preload 只能注册一个回调；若组件多次挂载（路由重建、热更新），后注册的会覆盖
 *   前面的，而旧实例队列是空的 —— 关窗时"看起来写完了"，实际那笔改动还在新实例里
 *   没交出去。模块级单例不存在这个陷阱。
 * - 上游 `TimelineEditor.vue` 因此**不需要任何改动**。
 */
function installBridge(): void {
  if (typeof window === 'undefined') return;

  const desktopBridge = (
    window as unknown as {
      EndaxisDesktop?: { onFlushSaves?: (handler: () => Promise<void>) => void };
    }
  ).EndaxisDesktop;
  desktopBridge?.onFlushSaves?.(() => flushBrowserSaveAndWait());

  // 浏览器场景兜底：还有没落盘的改动就拦住离开，并先尝试写一次。
  // 桌面壳关闭窗口走主进程的 close 协调器，会在关窗前先 flush，
  // 到这里时队列已空，因此不会误拦。
  window.addEventListener('beforeunload', event => {
    if (!hasPendingBrowserSave()) return;
    void flushBrowserSave();
    event.preventDefault();
    event.returnValue = '';
  });
}

installBridge();
