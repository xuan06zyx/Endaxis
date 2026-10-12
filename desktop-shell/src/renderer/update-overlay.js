/**
 * 更新进度浮层。**在主世界里执行**（由主进程 executeJavaScript 注入）。
 *
 * 为什么放在主世界而不是 preload 的隔离世界：
 *   - contextIsolation: true 时，隔离世界往页面派发的 CustomEvent 主世界收不到，
 *     浮层没法自己监听状态；
 *   - 反过来，隔离世界能改共享 DOM，所以 preload 负责"推数据"，这里负责"显示"。
 *
 * 安全设计：本脚本**不持有任何特权**——不能发 IPC、不能碰文件系统，只读取
 * 主进程写进 data-* 属性的状态并渲染。这样即使上游前端将来被注入恶意代码，
 * 也拿不到任何额外能力。
 *
 * 样式全部用行内 style 赋值（不走 <style> 标签，避免受页面 CSP 影响）。
 */

(() => {
  const ROOT_ID = '__endaxis_update_overlay__';
  if (document.getElementById(ROOT_ID) !== null) return;

  const root = document.createElement('div');
  root.id = ROOT_ID;
  root.setAttribute('data-state', 'idle');

  Object.assign(root.style, {
    position: 'fixed',
    right: '20px',
    bottom: '20px',
    zIndex: '2147483000',
    minWidth: '300px',
    maxWidth: '380px',
    padding: '14px 16px',
    borderRadius: '10px',
    background: 'rgba(22, 24, 29, 0.96)',
    border: '1px solid rgba(255, 255, 255, 0.14)',
    boxShadow: '0 10px 30px rgba(0, 0, 0, 0.45)',
    color: '#e8eaed',
    font: '13px/1.5 "Microsoft YaHei", "Segoe UI", system-ui, sans-serif',
    display: 'none',
    userSelect: 'none',
  });

  // ── 顶部：标题 + 关闭 ────────────────────────────────────────────────
  const header = document.createElement('div');
  Object.assign(header.style, {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '10px',
    marginBottom: '10px',
  });

  const title = document.createElement('div');
  Object.assign(title.style, { fontWeight: '600', letterSpacing: '0.02em' });

  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = '✕';
  close.title = '收起（不影响下载）';
  Object.assign(close.style, {
    background: 'transparent',
    border: 'none',
    color: '#9aa0a6',
    font: 'inherit',
    cursor: 'pointer',
    padding: '2px 6px',
    borderRadius: '4px',
    lineHeight: '1',
  });
  close.addEventListener('mouseenter', () => {
    close.style.color = '#e8eaed';
    close.style.background = 'rgba(255,255,255,0.08)';
  });
  close.addEventListener('mouseleave', () => {
    close.style.color = '#9aa0a6';
    close.style.background = 'transparent';
  });
  let collapsed = false;
  close.addEventListener('click', () => {
    collapsed = true;
    body.style.display = 'none';
    close.style.display = 'none';
  });

  header.append(title, close);

  // ── 主体：说明 + 进度条 + 明细 ───────────────────────────────────────
  const body = document.createElement('div');

  const message = document.createElement('div');
  Object.assign(message.style, { color: '#c6c9ce', marginBottom: '8px' });

  const track = document.createElement('div');
  Object.assign(track.style, {
    position: 'relative',
    height: '8px',
    borderRadius: '999px',
    background: 'rgba(255, 255, 255, 0.12)',
    overflow: 'hidden',
  });

  const bar = document.createElement('div');
  Object.assign(bar.style, {
    position: 'absolute',
    inset: '0 auto 0 0',
    width: '0%',
    borderRadius: '999px',
    background: 'linear-gradient(90deg, #4c8dff, #7bd0ff)',
    // 进度条本身用 width 驱动；transition 让 1 秒一次的推送看起来连续。
    transition: 'width 0.4s ease-out',
  });
  track.append(bar);

  const detail = document.createElement('div');
  Object.assign(detail.style, {
    display: 'flex',
    justifyContent: 'space-between',
    gap: '12px',
    marginTop: '8px',
    color: '#9aa0a6',
    fontVariantNumeric: 'tabular-nums',
    fontSize: '12px',
  });
  const detailLeft = document.createElement('span');
  const detailRight = document.createElement('span');
  detail.append(detailLeft, detailRight);

  body.append(message, track, detail);
  root.append(header, body);
  document.body.appendChild(root);

  // ── 渲染 ─────────────────────────────────────────────────────────────
  const STATE_TEXT = {
    checking: '正在检查更新…',
    available: '发现新版本，准备下载…',
    downloading: '正在下载更新…',
    downloaded: '更新已就绪，重启后安装。',
    error: '更新出错',
  };

  /** 字节数转成 MB / KB，保留一位小数。 */
  function formatBytes(value) {
    if (!Number.isFinite(value) || value <= 0) return null;
    const mb = value / 1024 / 1024;
    if (mb >= 1) return `${mb.toFixed(1)} MB`;
    return `${(value / 1024).toFixed(0)} KB`;
  }

  /** 剩余时间按当前速度估算，给用户一个"还要多久"的直觉。 */
  function formatEta(remainingBytes, bytesPerSecond) {
    if (
      !Number.isFinite(remainingBytes) ||
      !Number.isFinite(bytesPerSecond) ||
      bytesPerSecond <= 0
    ) {
      return null;
    }
    const seconds = Math.round(remainingBytes / bytesPerSecond);
    if (seconds < 1) return '即将完成';
    if (seconds < 60) return `约 ${seconds} 秒`;
    return `约 ${Math.round(seconds / 60)} 分钟`;
  }

  function render() {
    const state = root.getAttribute('data-state') ?? 'idle';
    const version = root.getAttribute('data-version') ?? '';
    const percentRaw = Number.parseFloat(root.getAttribute('data-percent') ?? '');
    const transferred = Number.parseFloat(root.getAttribute('data-transferred') ?? '');
    const total = Number.parseFloat(root.getAttribute('data-total') ?? '');
    const speed = Number.parseFloat(root.getAttribute('data-speed') ?? '');
    const error = root.getAttribute('data-error') ?? '';

    if (state === 'idle' || state === 'up-to-date') {
      root.style.display = 'none';
      return;
    }
    if (collapsed) {
      root.style.display = 'none';
      return;
    }
    root.style.display = 'block';

    const percent = Number.isFinite(percentRaw) ? Math.min(100, Math.max(0, percentRaw)) : null;

    // 标题随状态给对方一个明确的"在做什么"。
    title.textContent =
      state === 'downloading' && percent !== null
        ? `下载更新 ${percent.toFixed(0)}%`
        : state === 'downloaded'
          ? `更新已就绪${version ? ` · ${version}` : ''}`
          : '软件更新';

    message.textContent = STATE_TEXT[state] ?? '';
    if (state === 'error' && error.length > 0) message.textContent = `更新出错：${error}`;

    // 进度条：下载中显示实际进度；其余状态给一个"进行中"的观感。
    if (state === 'downloading' && percent !== null) {
      bar.style.width = `${percent}%`;
    } else if (state === 'downloaded') {
      bar.style.width = '100%';
      bar.style.background = 'linear-gradient(90deg, #35c07a, #7ee2ab)';
    } else if (state === 'error') {
      bar.style.width = '100%';
      bar.style.background = 'linear-gradient(90deg, #d9534f, #f08b88)';
    } else {
      // 检查/准备阶段：不确定进度，用半条渐变表示"在动"。
      bar.style.width = '35%';
      bar.style.background = 'linear-gradient(90deg, #4c8dff, #7bd0ff)';
    }

    // 明细：左"当前 / 总量"（这是明确要求的一项），右"速度 · 剩余"。
    if (state === 'downloading' && percent !== null) {
      const done = formatBytes(transferred);
      const all = formatBytes(total);
      detailLeft.textContent =
        done !== null && all !== null ? `${done} / ${all}` : `${percent.toFixed(0)}%`;
      const parts = [];
      if (Number.isFinite(speed) && speed > 0) parts.push(`${formatBytes(speed)}/s`);
      const eta =
        Number.isFinite(total) && Number.isFinite(transferred)
          ? formatEta(total - transferred, speed)
          : null;
      if (eta !== null) parts.push(eta);
      detailRight.textContent = parts.join(' · ');
    } else if (state === 'downloaded') {
      detailLeft.textContent = formatBytes(total) ?? '下载完成';
      detailRight.textContent = '可关闭程序后自动安装';
    } else {
      detailLeft.textContent = '';
      detailRight.textContent = '';
    }
  }

  root.addEventListener('endaxis:update-status', render);
  render();
})();
