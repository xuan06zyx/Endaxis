import { onScopeDispose, ref } from 'vue';
import type { ProjectEditorSession } from '../../application/editor/projectEditorSession';
import type { EndaxisProjectDocument } from '../../core/project/schema';
import { serializeProjectDocument } from '../../core/project/serialization';
import { saveBrowserProject } from '../../data/browserProjectStorage';
import { decompressProjectCode, downloadBlob, projectFilename } from './timelineExport';
import {
  selectProjectExportScope,
  type ExportScenarioScope,
} from '../../application/editor/projectTransfer';
export { selectProjectExportScope } from '../../application/editor/projectTransfer';
import { readProjectCodeFromPng } from './pngProjectData';

/**
 * 连续编辑的合并窗口。
 *
 * 每次提交都立刻写 IndexedDB 会让拖拽和连续输入产生大量短事务。这里把窗口内的
 * 改动合并成一次写入；宁可晚 1.2 秒落盘，也不要每帧都开事务。
 */
const BROWSER_SAVE_DEBOUNCE_MS = 1200;
/**
 * 最长等待时间。
 *
 * 只有防抖是不够的：持续拖拽会一直"又改了"，写入会被无限推迟。超过这个时间
 * 就强制落盘一次，保证保存进度始终在推进。
 */
const BROWSER_SAVE_MAX_WAIT_MS = 15_000;
/**
 * `flushBrowserSaveAndWait` 的等待上限。
 *
 * 比桌面壳那边的等待上限（4 秒）短一点，保证壳等我们、我们不拖住壳。
 * 本地 IndexedDB 写入通常几毫秒，超时只是兜底，避免"关不掉的窗口"。
 */
const BROWSER_SAVE_FLUSH_TIMEOUT_MS = 3_000;

/**
 * 供桌面壳调用：把当前会话里排队的保存写落地。
 *
 * 通过模块级登记处取最新会话，而不是让调用方持有旧闭包（见 closeFlushHandler 注释）。
 */
export function flushActiveProjectSave(): Promise<void> {
  return closeFlushHandler === null ? Promise.resolve() : closeFlushHandler();
}

/** 项目会话负责浏览器自动保存、文件读取代次和保存未完成时的离页保护。 */
/**
 * 关窗时"把保存写落地"的登记处。
 *
 * 放在模块级而不是每个会话各存一份：桌面壳的 preload 只能注册一个回调，
 * 如果组件挂载多次（路由重建、热更新），旧实例会把回调覆盖成自己的闭包——
 * 而旧实例的队列是空的，于是关窗时"看起来写完了"，实际那笔改动还在新实例里
 * 没交出去，数据照样丢。这里只保留**最新**会话的处理函数。
 */
let closeFlushHandler: (() => Promise<void>) | null = null;

export function useProjectFileSession(
  projectSession: ProjectEditorSession,
  options: { persistToBrowser?: boolean } = {},
) {
  const browserSaveError = ref<string | null>(null);
  let pendingBrowserSaves = 0;
  /**
   * 已合并但尚未写盘的改动。
   *
   * 它同时是"有没有脏数据"的唯一判据：只要它不为 null，关闭窗口前就必须提醒
   * 用户，而不是静默丢弃。
   */
  let queuedProject: EndaxisProjectDocument | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let firstQueuedAt = 0;
  const projectFileReader = createProjectFileReader(() => projectSession.snapshot.revision);

  function writeProject(project: EndaxisProjectDocument): void {
    pendingBrowserSaves += 1;
    void saveBrowserProject(project).then(
      () => {
        browserSaveError.value = null;
        pendingBrowserSaves -= 1;
      },
      error => {
        browserSaveError.value = error instanceof Error ? error.message : '浏览器项目自动保存失败';
        pendingBrowserSaves -= 1;
      },
    );
  }

  function clearDebounceTimer(): void {
    if (debounceTimer === null) return;
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }

  /** 把排队的改动立刻写盘；没有排队就什么也不做。 */
  function flushQueuedSave(): void {
    clearDebounceTimer();
    if (queuedProject === null) return;
    const project = queuedProject;
    queuedProject = null;
    firstQueuedAt = 0;
    writeProject(project);
  }

  const unsubscribe = projectSession.subscribe(snapshot => {
    if (!options.persistToBrowser) return;
    queuedProject = snapshot.project;
    if (firstQueuedAt === 0) firstQueuedAt = Date.now();
    // 连续编辑期间每次都重置防抖；只有超过最长等待才强制写一次。
    clearDebounceTimer();
    const waited = Date.now() - firstQueuedAt;
    if (waited >= BROWSER_SAVE_MAX_WAIT_MS) {
      flushQueuedSave();
      return;
    }
    const delay = Math.min(BROWSER_SAVE_DEBOUNCE_MS, BROWSER_SAVE_MAX_WAIT_MS - waited);
    debounceTimer = setTimeout(flushQueuedSave, delay);
  });
  /**
   * 关窗前调用：把排队的改动交出去，并**等它真正写完**。
   *
   * 这一步是必要的，不能只依赖 beforeunload：渲染进程会在 IndexedDB 事务提交
   * 之前被销毁，光"发起"写入并不能保证数据落到磁盘。桌面壳（desktop-shell）
   * 会通过 preload 调用本方法，写完才放行窗口关闭。
   */
  async function flushBrowserSaveAndWait(): Promise<void> {
    if (!options.persistToBrowser) return;
    flushQueuedSave();
    const deadline = Date.now() + BROWSER_SAVE_FLUSH_TIMEOUT_MS;
    while (pendingBrowserSaves > 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }

  /** 注册到"关窗前落盘"登记处；桌面壳的 preload 会调用它。 */
  closeFlushHandler = flushBrowserSaveAndWait;
  onScopeDispose(() => {
    // 只有还指向自己时才注销，避免把新实例的处理函数清掉。
    if (closeFlushHandler === flushBrowserSaveAndWait) closeFlushHandler = null;
  });

  function exportProjectFile(filename?: string, scope: ExportScenarioScope = 'all') {
    const project = selectProjectExportScope(projectSession.snapshot.project, scope);
    const content = serializeProjectDocument(project, true);
    const activeScenario = project.scenarios.find(value => value.id === project.activeScenarioId);
    const fileBase = (activeScenario?.name ?? project.activeScenarioId)
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '');
    downloadProjectJson(
      content,
      filename === undefined ? `${fileBase || 'endaxis-project'}.json` : projectFilename(filename),
    );
  }
  /**
   * 离页保护。
   *
   * 合并写入带来了一个新的风险：关窗时可能还有窗口内的改动没落盘。所以这里
   * 一旦发现有排队或进行中的写入，就**先落盘再弹确认**——用确认框换一次写入
   * 的机会，用户点"离开"时数据已经交出去了，不会出现"静默丢掉最后几秒编辑"。
   */
  function protectPendingBrowserSave(event: BeforeUnloadEvent) {
    if (!options.persistToBrowser) return;
    flushQueuedSave();
    if (pendingBrowserSaves === 0 && browserSaveError.value === null) return;
    event.preventDefault();
    event.returnValue = '';
  }
  window.addEventListener('beforeunload', protectPendingBrowserSave);
  onScopeDispose(() => {
    unsubscribe();
    clearDebounceTimer();
    // 作用域销毁（切换路由等）也要把最后一批改动交出去。
    flushQueuedSave();
    projectFileReader.dispose();
    window.removeEventListener('beforeunload', protectPendingBrowserSave);
  });
  return {
    browserSaveError,
    projectFileReader,
    exportProjectFile,
    flushBrowserSaveAndWait,
  };
}

/** File selection is replaceable work: only the newest read may reach project parsing.
 * A revision protects intervening edits, including an undo back to the same document object. */
export function createProjectFileReader(getProjectRevision: () => number) {
  let generation = 0;
  let disposed = false;
  async function readUsing(readContent: () => Promise<string>): Promise<string | null> {
    if (disposed) return null;
    const request = ++generation;
    const revision = getProjectRevision();
    const current = () => !disposed && request === generation;
    let content: string;
    try {
      content = await readContent();
    } catch (error) {
      if (!current()) return null;
      throw error;
    }
    if (!current()) return null;
    if (revision !== getProjectRevision()) {
      throw new Error('读取文件期间当前项目已变化，请重新加载');
    }
    return content;
  }
  return {
    read(file: Pick<File, 'text'>): Promise<string | null> {
      return readUsing(() => file.text());
    },
    readPng(file: Blob): Promise<string | null> {
      return readUsing(async () => {
        const code = await readProjectCodeFromPng(file);
        if (code === null) throw new Error('这张 PNG 图片没有 Endaxis 项目数据');
        return decompressProjectCode(code);
      });
    },
    dispose(): void {
      disposed = true;
      generation += 1;
    },
  };
}

/** 触发浏览器下载，不把点击等同于持久化备份；对象 URL 保留到浏览器消费后再释放。 */
export function downloadProjectJson(content: string, filename: string): void {
  downloadBlob(new Blob([content], { type: 'application/json' }), filename);
}
