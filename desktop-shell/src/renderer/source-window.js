'use strict';

/**
 * "检查更新"窗口的渲染逻辑。
 *
 * 设计要点：
 *   - 打开窗口**不自动检查**。用户先看测速结果、选好下载源，再点"检查更新"。
 *     自动检查会让无法直连 GitHub 的用户先白等一次超时。
 *   - 测速与检查是两个独立动作：测速只测下载性能，不查版本；检查更新才查版本。
 *   - 全程不做模态阻塞：结果写在窗口内的状态区，用户可以随时关掉窗口。
 *
 * 与主进程的全部通信都走 preload 暴露的白名单方法（见 source-preload.js）。
 */

const api = window.EndaxisSource;

const elements = {
  currentVersion: document.getElementById('currentVersion'),
  mirrorRows: document.getElementById('mirrorRows'),
  testButton: document.getElementById('testButton'),
  checkButton: document.getElementById('checkButton'),
  hint: document.getElementById('hint'),
  status: document.getElementById('status'),
  progress: document.getElementById('progress'),
  progressBar: document.getElementById('progressBar'),
  listLink: document.getElementById('listLink'),
};

/** 各镜像的最新测速结果，key = mirrorId。 */
let speedResults = new Map();
/** 镜像清单，init 时从主进程取一次并缓存。
 *
 *  不要在 render 里再调 getState()：它返回 Promise，`api.getState().mirrors`
 *  永远是 undefined（实测报 "api.getState.mirrors is not iterable"）。
 *  清单是静态的，取一次即可。 */
let mirrors = [];
let selectedId = null;
let testing = false;
let checking = false;

function formatSpeed(bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '—';
  const mb = bytesPerSecond / 1024 / 1024;
  if (mb >= 1) return `${mb.toFixed(2)} MB/s`;
  return `${Math.round(bytesPerSecond / 1024)} KB/s`;
}

function formatLatency(ttfbMs) {
  if (!Number.isFinite(ttfbMs)) return '—';
  return `${ttfbMs} ms`;
}

function stateOf(mirrorId) {
  if (testing && !speedResults.has(mirrorId)) return { cls: 'testing', label: '测速中…' };
  const result = speedResults.get(mirrorId);
  if (result === undefined) return { cls: 'unknown', label: '未测速' };
  if (!result.ok) return { cls: 'bad', label: result.error ?? '不可用' };
  return { cls: 'ok', label: '' };
}

function render() {
  elements.mirrorRows.replaceChildren();
  for (const mirror of mirrors) {
    const result = speedResults.get(mirror.id);
    const status = stateOf(mirror.id);

    const row = document.createElement('tr');
    row.className = mirror.id === selectedId ? 'selected' : '';
    row.addEventListener('click', () => {
      selectedId = mirror.id;
      void api.selectMirror(mirror.id).then(render);
    });

    const nameCell = document.createElement('td');
    const dot = document.createElement('span');
    dot.className = `dot ${status.cls}`;
    nameCell.append(dot);
    nameCell.append(document.createTextNode(mirror.name));
    if (status.label) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = status.label;
      nameCell.append(tag);
    }
    if (mirror.supportsApi) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = '可查版本';
      nameCell.append(tag);
    }

    const latencyCell = document.createElement('td');
    latencyCell.className = 'num';
    latencyCell.textContent = result?.ok ? formatLatency(result.ttfbMs) : '—';

    const speedCell = document.createElement('td');
    speedCell.className = 'num';
    if (result?.ok) {
      speedCell.textContent = formatSpeed(result.speedBps);
      // 重试才成功的站照实标注：它可用，但不如一次就通的稳定。
      if (result.unstable === true) {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = '不稳定';
        speedCell.append(tag);
      }
    } else {
      speedCell.textContent = '—';
    }

    const descCell = document.createElement('td');
    descCell.className = 'muted';
    descCell.textContent = mirror.description;

    row.append(nameCell, latencyCell, speedCell, descCell);
    elements.mirrorRows.append(row);
  }
}

function setStatus(message, kind = '') {
  elements.status.textContent = message;
  elements.status.className = `show ${kind}`;
}

function clearStatus() {
  elements.status.className = '';
  elements.status.textContent = '';
}

function setBusy({ test, check }) {
  if (test !== undefined) testing = test;
  if (check !== undefined) checking = check;
  elements.testButton.disabled = testing || checking;
  elements.checkButton.disabled = testing || checking;
  elements.testButton.textContent = testing ? '测速中…' : '测速';
  elements.checkButton.textContent = checking ? '检查中…' : '检查更新';
  render();
}

async function runSpeedTest() {
  setBusy({ test: true });
  clearStatus();
  setStatus('正在测速：并发测试各下载源，约需十几秒。');
  try {
    const results = await api.testMirrors();
    speedResults = new Map(results.map(result => [result.id, result]));
    const usable = results.filter(result => result.ok);
    if (usable.length === 0) {
      setStatus('所有下载源都不可用。请检查网络，或稍后重试（镜像站地址可能会变动）。', 'error');
    } else {
      // 自动把最快的一个设为选中，省掉用户自己比较的一步。
      const fastest = usable
        .filter(result => Number.isFinite(result.speedBps))
        .sort((a, b) => b.speedBps - a.speedBps)[0];
      if (fastest !== undefined && fastest.id !== selectedId) {
        await api.selectMirror(fastest.id);
        selectedId = fastest.id;
        setStatus(`测速完成，已自动选择最快的下载源（${formatSpeed(fastest.speedBps)}）。`, 'ok');
      } else {
        setStatus('测速完成。', 'ok');
      }
    }
  } catch (error) {
    setStatus(`测速失败：${error?.message ?? error}`, 'error');
  } finally {
    setBusy({ test: false });
  }
}

async function runCheck() {
  setBusy({ check: true });
  clearStatus();
  setStatus('正在查询最新版本…');
  try {
    const result = await api.queryLatest();
    if (!result?.ok) {
      setStatus(
        '查询失败：所有下载源与 GitHub 都无法访问。可先测速并选择一个可用镜像后重试。',
        'error',
      );
      return;
    }
    if (!result.hasUpdate) {
      setStatus(`已是最新版本（${result.current}）。`, 'ok');
      return;
    }
    setStatus(`发现新版本 ${result.latest}（当前 ${result.current}）。开始下载…`, 'ok');
    await downloadAndPrompt(result.latest);
  } catch (error) {
    setStatus(`检查失败：${error?.message ?? error}`, 'error');
  } finally {
    setBusy({ check: false });
  }
}

/** 下载并显示进度；完成后询问是否立即安装。 */
async function downloadAndPrompt(version) {
  elements.progress.className = 'progress show';
  const unsubscribe = api.onProgress(payload => {
    const percent = Number.isFinite(payload?.percent) ? payload.percent : 0;
    elements.progressBar.style.width = `${Math.min(100, Math.max(0, percent))}%`;
    if (payload?.state === 'downloading') {
      setStatus(`正在下载 ${version}：${percent.toFixed(1)}%`, 'ok');
    }
  });

  try {
    const result = await api.startDownload();
    if (!result?.ok) {
      setStatus('下载失败：无法定位更新包。请先测速并选择可用下载源。', 'error');
      return;
    }
    elements.progressBar.style.width = '100%';
    setStatus(`${version} 下载完成。点"立即安装"将备份项目数据后重启安装。`, 'ok');
    elements.checkButton.textContent = '立即安装';
    elements.checkButton.disabled = false;
    elements.checkButton.onclick = async () => {
      elements.checkButton.disabled = true;
      await api.installNow();
    };
  } catch (error) {
    setStatus(`下载失败：${error?.message ?? error}`, 'error');
  } finally {
    unsubscribe?.();
  }
}

async function init() {
  // 必须 await：getState 走 ipcRenderer.invoke，返回的是 Promise。
  // 漏掉 await 会让 state.mirrors 变成 undefined，整个表格渲染不出来
  // （实测报 "api.getState.mirrors is not iterable"）。
  const state = await api.getState();
  // 缓存镜像清单：render 是同步的，不能在里面 await。
  mirrors = Array.isArray(state?.mirrors) ? state.mirrors : [];
  selectedId = state.selectedId;
  elements.currentVersion.textContent = state.currentVersion;
  // 沿用上次的测速结果，用户不必每次重测。
  if (state.speedTest?.results) {
    speedResults = new Map(state.speedTest.results.map(result => [result.id, result]));
  }
  elements.listLink.addEventListener('click', event => {
    event.preventDefault();
    void api.openMirrorList();
  });
  elements.testButton.addEventListener('click', () => void runSpeedTest());
  elements.checkButton.addEventListener('click', () => void runCheck());
  render();
}

void init();
