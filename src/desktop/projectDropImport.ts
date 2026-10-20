/**
 * 拖入项目文件导入。
 *
 * 把 `.json`（或 `.png` 项目码）拖到窗口任意位置即可导入排轴。
 *
 * ── 为什么不自己解析文件 ──────────────────────────────────────────────
 * 应用本来就有一整套打开流程（`openProjectContent`）：JSON 校验、PNG 项目码解码、
 * 旧版本自动转换确认、部分方案的追加/替换选择、游戏数据加载顺序……重写一遍必然
 * 与上游行为不一致，而且上游每改进一次导入就得跟一次。
 *
 * 所以这里只做**投递**：把拖入的文件塞进既有的 `<input type="file">` 并派发
 * `change` 事件，剩下的全部交给上游原有逻辑。这也意味着**不需要改上游任何文件**。
 *
 * ── 依赖的 DOM 契约 ──────────────────────────────────────────────────
 * 上游的导入入口是 `TimelineEditor.vue` 里的
 * `input.project-file-input[type="file"]`（带 `@change` 处理）。
 * 这是唯一耦合点：上游若改了类名，拖放会失效（但不会报错崩坏）。
 * `tools/verify-drop-import.js` 会端到端守住这条契约。
 */

/** 跟随界面语言显示提示：上游的 i18n 在应用外拿不到，这里按浏览器语言判断。 */
const IS_CHINESE = typeof navigator !== 'undefined' && /^zh/i.test(navigator.language);
/** 本功能自带的文案。 */
const TEXT = IS_CHINESE
  ? {
      hint: '释放文件以导入（.json / .png）',
      unsupported: '只支持拖入 .json 或 .png 项目文件',
      noInput: '没有找到导入入口，请改用「打开项目」菜单',
    }
  : {
      hint: 'Drop to import (.json / .png)',
      unsupported: 'Only .json or .png project files can be dropped',
      noInput: 'Import entry not found; use the Open Project menu instead',
    };

/** 上游导入入口的选择器。 */
const FILE_INPUT_SELECTOR = 'input.project-file-input[type="file"]';
/** 上游的 input 只接受这两种。 */
const ACCEPTED_FILE = /\.(json|png)$/i;

let dragDepth = 0;
let hint: HTMLElement | null = null;

/** 只处理"从系统拖入文件"，不要干扰页面内部的元素拖拽。 */
function carriesFiles(event: DragEvent): boolean {
  const types = event.dataTransfer?.types;
  if (types === undefined) return false;
  return Array.from(types).includes('Files');
}

/** 从拖入的文件里挑第一个可导入的。 */
function pickProjectFile(transfer: DataTransfer | null): File | null {
  if (transfer === null) return null;
  const files = Array.from(transfer.files);
  const accepted = files.find(file => ACCEPTED_FILE.test(file.name));
  return accepted ?? null;
}

/**
 * 把文件投递给上游的导入入口。
 *
 * 用 DataTransfer 构造 FileList 再赋给 input.files —— 这是在不触发文件选择对话框的
 * 前提下，让既有 `change` 处理器拿到文件的唯一办法。
 *
 * @returns 是否找到了入口并成功派发
 */
function dispatchToImportInput(file: File): boolean {
  const input = document.querySelector<HTMLInputElement>(FILE_INPUT_SELECTOR);
  if (input === null) return false;
  const transfer = new DataTransfer();
  transfer.items.add(file);
  input.files = transfer.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

// ── 拖入提示与错误提示（自己画，不依赖应用的组件库）────────────────────

function ensureHint(): HTMLElement {
  if (hint !== null && hint.isConnected) return hint;
  const element = document.createElement('div');
  element.setAttribute('data-endaxis-drop-hint', '');
  Object.assign(element.style, {
    position: 'fixed',
    top: '16px',
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: '2147483000',
    padding: '12px 20px',
    borderRadius: '10px',
    background: 'rgba(22, 24, 29, 0.96)',
    border: '1px solid rgba(120, 170, 255, 0.55)',
    boxShadow: '0 10px 30px rgba(0, 0, 0, 0.45)',
    color: '#e8eaed',
    font: '13px/1.5 "Microsoft YaHei", "Segoe UI", system-ui, sans-serif',
    pointerEvents: 'none',
    display: 'none',
    whiteSpace: 'nowrap',
  });
  document.body.appendChild(element);
  hint = element;
  return element;
}

function showHint(): void {
  const element = ensureHint();
  element.textContent = TEXT.hint;
  element.style.display = 'block';
}

function hideHint(): void {
  if (hint !== null) hint.style.display = 'none';
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;

function showToast(message: string): void {
  if (typeof document === 'undefined' || document.body === null) return;
  let element = document.querySelector<HTMLElement>('[data-endaxis-drop-toast]');
  if (element === null) {
    element = document.createElement('div');
    element.setAttribute('data-endaxis-drop-toast', '');
    Object.assign(element.style, {
      position: 'fixed',
      bottom: '72px',
      left: '50%',
      transform: 'translateX(-50%)',
      zIndex: '2147483000',
      maxWidth: '70vw',
      padding: '9px 16px',
      borderRadius: '8px',
      background: 'rgba(42, 31, 31, 0.97)',
      border: '1px solid #5a2f2e',
      color: '#ffd9d6',
      font: '13px/1.5 "Microsoft YaHei", "Segoe UI", system-ui, sans-serif',
      pointerEvents: 'none',
    });
    document.body.appendChild(element);
  }
  element.textContent = message;
  element.style.display = 'block';
  if (toastTimer !== null) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    if (element !== null) element.style.display = 'none';
  }, 4000);
}

/**
 * 安装拖放导入。重复调用是安全的（只装一次监听）。
 *
 * 为什么用模块级自注册、而不是让 `TimelineEditor.vue` 显式调用：
 * 桌面壳已经在上游文件里挂了唯一一个钩子（`browserSaveBridge`），其它增强都由
 * 那里引导加载，上游文件的改动点因此保持在 2 行以内。
 */
let installed = false;

export function installProjectDropImport(): void {
  if (installed || typeof window === 'undefined' || typeof document === 'undefined') return;
  installed = true;

  window.addEventListener('dragenter', event => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    dragDepth += 1;
    showHint();
  });

  window.addEventListener('dragover', event => {
    if (!carriesFiles(event)) return;
    // 必须阻止默认行为，否则 Chromium 会直接把文件打开成新页面，应用被替换掉。
    event.preventDefault();
    if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'copy';
  });

  window.addEventListener('dragleave', event => {
    if (!carriesFiles(event)) return;
    // dragenter/dragleave 会随鼠标经过子元素反复触发，用深度计数避免闪烁。
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) hideHint();
  });

  window.addEventListener('drop', event => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    hideHint();

    const file = pickProjectFile(event.dataTransfer);
    if (file === null) {
      showToast(TEXT.unsupported);
      return;
    }
    if (!dispatchToImportInput(file)) {
      showToast(TEXT.noInput);
    }
  });
}

installProjectDropImport();
