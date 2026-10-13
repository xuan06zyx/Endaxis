'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const {
  MIRRORS,
  MIRROR_LIST_URL,
  DEFAULT_MIRROR_ID,
  applyMirror,
  findMirror,
} = require('./mirrors');
const { testMirrors } = require('./mirrorSpeedTest');
const { readPreferences, writePreferences } = require('./preferences');

/**
 * 更新链路的落盘日志。
 *
 * 每次运行都覆盖写一份到手边的临时目录：这个文件是排查"更新没反应"的唯一线索，
 * 而更新失败往往发生在用户机器上、没有控制台可看。只有几行文本，不占空间。
 *
 * 早期版本把这里做成"仅探针模式才写"，结果探针自己出问题时反而什么都看不到，
 * 排查时被误导过——诊断信息的价值就在于它总是存在。
 */
function trace(step) {
  try {
    const line = `[${new Date().toISOString()}] ${step}\n`;
    if (traceStarted) fs.appendFileSync(TRACE_PATH, line, 'utf8');
    else {
      traceStarted = true;
      fs.writeFileSync(TRACE_PATH, line, 'utf8');
    }
  } catch {
    // 记录失败不影响流程。
  }
}

const TRACE_PATH = path.join(require('node:os').tmpdir(), 'endaxis-update-trace.log');
let traceStarted = false;

/** 探针模式开关（模块级常量，任何地方都读同一个值）。 */
const UPDATE_PROBE_ENABLED = process.env.ENDAXIS_UPDATE_PROBE === '1';

/**
 * Release 坐标（owner/repo），来自打包时写入的 `resources/app-update.yml`。
 *
 * 为什么读它而不是写死：更新源由 package.json 的 build.publish 决定，
 * 这里跟着走就不会出现"改了发布目标、代码却还指着旧仓库"的漂移。
 * 读不到时回退到默认值，保证功能整体不至于不可用。
 */
function resolveReleaseCoordinates() {
  const fallback = { owner: 'xuan06zyx', repo: 'Endaxis' };
  try {
    const raw = fs.readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf8');
    const owner = /^owner:\s*(\S+)/m.exec(raw)?.[1];
    const repo = /^repo:\s*(\S+)/m.exec(raw)?.[1];
    if (owner !== undefined && repo !== undefined) return { owner, repo };
  } catch {
    // 开发模式或配置缺失：用默认值。
  }
  return fallback;
}

const RELEASE_COORDINATES = resolveReleaseCoordinates();
const RELEASE_OWNER = RELEASE_COORDINATES.owner;
const RELEASE_REPO = RELEASE_COORDINATES.repo;

/**
 * 自动更新。
 *
 * 三个既定选择：
 *   1. 更新源 = GitHub Releases（package.json 的 build.publish 配置）；
 *   2. **不静默替换**：后台只做检查，下载与安装都要用户点确认。
 *      本程序没有代码签名，静默替换用户机器上的程序风险太高；
 *   3. 安装前自动备份项目数据（见 backupUserData）。
 *
 * 全部走 electron-updater；它负责下载、校验 sha512、调用安装程序。
 */

/** 主进程自己的更新文案（与菜单文案分开：这里句子更长）。 */
const STRINGS = {
  'zh-CN': {
    ok: '确定',
    checkFailedTitle: '检查更新失败',
    checkFailedBody: '无法连接更新服务器。',
    upToDateTitle: '已是最新版本',
    upToDateBody: version => `当前版本 ${version} 已是最新。`,
    availableTitle: '发现新版本',
    availableBody: (version, current) => `新版本 ${version}（当前 ${current}）已发布。`,
    /**
     * GitHub 接口限流时的提示。
     * 这时只拿到了版本号、没能走常规检查流程，必须说清楚，否则用户会以为
     * 程序坏了，或者点了"下载"却发现没反应。
     */
    rateLimitedHint:
      'GitHub 接口暂时不可用（通常是同一网络下请求过多）。\n\n' +
      '这里只能确认有新版本存在，无法直接下载。请点"稍后"，然后到\n' +
      '菜单「帮助 → 检查更新」重试，或前往 GitHub Releases 手动下载。',
    releaseNotes: '更新说明',
    download: '下载并安装',
    later: '稍后',
    skipVersion: '跳过此版本',
    downloading: '正在下载更新…',
    downloadFailedTitle: '下载更新失败',
    downloadFailedBody: '更新包下载失败，可以稍后重试。',
    installTitle: '更新已就绪',
    installBody: version => `版本 ${version} 已下载完成。现在重启并安装吗？`,
    installNow: '重启并安装',
    installLater: '稍后（下次启动时安装）',
    installNote: '安装前会自动备份你的排轴项目数据。',
    backedUp: dir => `已备份项目数据到：\n${dir}`,
    backupFailed: '项目数据备份失败（不影响安装，但请自行留意数据安全）。',
    checkNow: '检查更新…',
    checking: '正在检查更新…',
    devMode: '开发模式下不检查更新。',
  },
  'en-US': {
    ok: 'OK',
    checkFailedTitle: 'Update check failed',
    checkFailedBody: 'Could not reach the update server.',
    upToDateTitle: 'Up to date',
    upToDateBody: version => `Version ${version} is the latest.`,
    availableTitle: 'Update available',
    availableBody: (version, current) => `Version ${version} is available (you have ${current}).`,
    rateLimitedHint:
      'The GitHub API is temporarily unavailable (usually too many requests from this network).\n\n' +
      'A newer version exists, but it cannot be downloaded from here. Choose "Later", then retry via ' +
      'Help → Check for Updates, or download manually from GitHub Releases.',
    releaseNotes: 'Release notes',
    download: 'Download and install',
    later: 'Later',
    skipVersion: 'Skip this version',
    downloading: 'Downloading update…',
    downloadFailedTitle: 'Update download failed',
    downloadFailedBody: 'The update could not be downloaded. Please try again later.',
    installTitle: 'Update ready',
    installBody: version => `Version ${version} has been downloaded. Restart and install now?`,
    installNow: 'Restart and install',
    installLater: 'Later (installs on next launch)',
    installNote: 'Your timeline projects will be backed up before installing.',
    backedUp: dir => `Project data backed up to:\n${dir}`,
    backupFailed: 'Backing up project data failed (install continues, but check your data).',
    checkNow: 'Check for Updates…',
    checking: 'Checking for updates…',
    devMode: 'Update checks are disabled in development.',
  },
};

function selectStrings(locale) {
  return locale && locale.toLowerCase().startsWith('zh') ? STRINGS['zh-CN'] : STRINGS['en-US'];
}

/**
 * 需要备份的目录：只含真正的用户数据。
 *
 * 明确排除 Cache / GPUCache / Code Cache / *ShaderCache / DawnWebGPUCache 等：
 * 实测 userData 有 307 MB，其中 298 MB 是缓存，真正的项目数据只有约 0.2 MB。
 * 把它们备进来会让每次更新多拷几百 MB，毫无意义。
 */
const BACKUP_DIRECTORIES = ['IndexedDB', 'Local Storage', 'Session Storage', 'WebStorage'];
/** 这些是 Chromium 的运行时状态，也是"锦上添花"：失败就跳过，不让备份整体失败。 */
const OPTIONAL_BACKUP_DIRECTORIES = ['blob_storage', 'Network', 'Shared Dictionary'];

/** 备份放在 userData 内：安装到 LOCALAPPDATA 时卸载不会连带删掉 APPDATA 里的数据。 */
const BACKUP_ROOT_NAME = 'data-backups';
const BACKUP_TIMESTAMP_FILE = 'backup-info.json';
/** 只保留最近几次，避免长期堆积。 */
const MAX_BACKUPS = 3;
/** 更新探针的结果文件名（见 runUpdateProbe）。 */
const UPDATE_PROBE_REPORT_NAME = 'update-probe.json';

function createUpdater({ window, isDevelopment, getStrings }) {
  trace('createUpdater 被调用');
  const text = getStrings ?? (() => selectStrings(app.getLocale()));
  let manualCheck = false;
  let state = 'idle';
  let lastVersion = null;
  let lastError = null;
  let lastLoggedPercent = -1;

  /**
   * 当前选中的更新源镜像。
   *
   * 默认直连 GitHub。用户可在"检查更新"窗口里测速后切换；选择会写进配置文件，
   * 下次启动沿用（无法直连 GitHub 的用户不该每次都要手动切）。
   */
  let selectedMirror = findMirror(readPreferences().mirrorId) ?? findMirror(DEFAULT_MIRROR_ID);
  /** 最近一次测速结果，供窗口展示；null 表示还没测过。 */
  let lastSpeedTest = null;
  let speedTestInFlight = null;

  /**
   * 更新探针：`npm run verify:update` 用。
   *
   * 存在的理由：更新链路的每一步（查 feed → 下载 → 校验 → 就绪）都依赖网络和
   * 弹窗，没法靠肉眼反复点。探针模式下跳过所有弹窗、自动下载，最后把结果写成
   * JSON 供测试脚本断言。日常运行完全不走这条分支。
   */
  const updateProbe = UPDATE_PROBE_ENABLED;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  trace(`autoUpdater 已配置；autoDownload=${autoUpdater.autoDownload}`);

  // 允许用配置覆盖更新源（企业内网/自建服务器场景）。
  const feedOverride = process.env.ENDAXIS_UPDATE_URL?.trim();
  if (feedOverride) {
    autoUpdater.setFeedURL({ provider: 'generic', url: feedOverride });
  }

  const send = (channel, payload) => {
    if (window === null || window.isDestroyed()) return;
    window.webContents.send(channel, payload);
  };

  /**
   * 最近一次发出的更新状态，用于重发。
   *
   * 为什么要重发：渲染进程里的进度浮层是页面加载完成后才注入的，注入之前发的
   * 事件没人接。下载进度本来每秒来好几次，重发只是为了让"注入那一刻"立刻
   * 显示出正确的进度，而不是等到下一次进度事件。
   */
  let lastStatus = { state: 'idle' };
  /** 浮层里错误提示的停留时长：到点自动收起，避免旧错误常驻。 */
  const ERROR_LINGER_MS = 15_000;
  let errorShownAt = 0;
  const publishStatus = payload => {
    if (payload.state === 'error') errorShownAt = Date.now();
    lastStatus = payload;
    send('update:status', payload);
  };
  const statusReplayTimer = setInterval(() => {
    if (lastStatus.state === 'idle') return;
    // 错误提示只保留一段时间：否则重发会让浮层一直挂着一条旧错误。
    if (lastStatus.state === 'error' && Date.now() - errorShownAt > ERROR_LINGER_MS) {
      lastStatus = { state: 'idle' };
      send('update:status', lastStatus);
      return;
    }
    send('update:status', lastStatus);
  }, 1000);
  statusReplayTimer.unref?.();

  const setProgressFeedback = fraction => {
    if (window === null || window.isDestroyed()) return;
    if (fraction === null) {
      window.setProgressBar(-1);
      return;
    }
    window.setProgressBar(Math.min(1, Math.max(0, fraction)));
  };

  autoUpdater.on('checking-for-update', () => {
    state = 'checking';
    publishStatus({ state });
  });

  autoUpdater.on('update-available', info => {
    state = 'available';
    lastVersion = info?.version ?? null;
    publishStatus({ state, version: lastVersion });
    if (updateProbe) return; // 探针模式：不弹窗，交给 checkForUpdatesManually 自动下载。
    void promptForUpdate(info);
  });

  autoUpdater.on('update-not-available', info => {
    state = 'idle';
    // 记一行：静默检查"已是最新"时若不记录，日志里就只剩"检查开始"，
    // 无法区分"检查成功且最新"和"检查压根没跑完"（排查时踩过）。
    trace(`update-not-available（线上最新 ${info?.version ?? '?'}，当前 ${app.getVersion()}）`);
    publishStatus({ state });
    if (updateProbe) return;
    if (manualCheck) {
      manualCheck = false;
      void dialog.showMessageBox(window, {
        type: 'info',
        title: text().upToDateTitle,
        message: text().upToDateBody(app.getVersion()),
        buttons: [text().ok ?? 'OK'],
        noLink: true,
      });
    }
  });

  autoUpdater.on('error', error => {
    // 用 'error' 而不是 'idle'：浮层要显示"更新出错"，置为 idle 会让它直接隐藏，
    // 用户就完全看不到失败了。停留时间由 ERROR_LINGER_MS 控制。
    state = 'error';
    lastError = String(error?.message ?? error);
    publishStatus({ state, error: lastError });
    setProgressFeedback(null);
    if (updateProbe) return;
    if (manualCheck) {
      manualCheck = false;
      void dialog.showMessageBox(window, {
        type: 'warning',
        title: text().checkFailedTitle,
        message: text().checkFailedBody,
        detail: String(error?.message ?? error),
        buttons: [text().ok ?? 'OK'],
        noLink: true,
      });
    }
  });

  autoUpdater.on('download-progress', progress => {
    state = 'downloading';
    const percent = progress?.percent ?? 0;
    // 只在整 10% 处记录，避免刷爆日志。
    if (Math.floor(percent / 10) !== Math.floor(lastLoggedPercent / 10)) {
      lastLoggedPercent = percent;
      trace(`下载进度 ${percent.toFixed(1)}%`);
    }
    setProgressFeedback(percent / 100);
    // 带上字节数与速度：界面要显示"当前 / 总量"，只有百分比不够直观，
    // 速度则用来给用户一个"还要多久"的直觉。
    publishStatus({
      state,
      version: lastVersion,
      percent,
      transferred: progress?.transferred ?? null,
      total: progress?.total ?? null,
      bytesPerSecond: progress?.bytesPerSecond ?? null,
    });
  });

  autoUpdater.on('update-downloaded', info => {
    state = 'downloaded';
    setProgressFeedback(null);
    lastVersion = info?.version ?? lastVersion;
    // 带上版本号：浮层要显示"1.0.5 已就绪"。
    publishStatus({ state, version: lastVersion });
    if (updateProbe) return; // 探针模式：不安装，由测试脚本断言后收尾。
    void promptForInstall(info);
  });

  /** 有更新时先问用户，不擅自下载。 */
  async function promptForUpdate(info) {
    const version = info?.version ?? '?';
    const notes = typeof info?.releaseNotes === 'string' ? info.releaseNotes.trim() : '';
    const detail = notes.length > 0 ? `${text().releaseNotes}:\n\n${stripHtml(notes)}` : undefined;

    const { response } = await dialog.showMessageBox(window, {
      type: 'info',
      title: text().availableTitle,
      message: text().availableBody(version, app.getVersion()),
      ...(detail === undefined ? {} : { detail: detail.slice(0, 2000) }),
      buttons: [text().download, text().later, text().skipVersion],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });

    if (response === 1) {
      manualCheck = false;
      return;
    }
    if (response === 2) {
      manualCheck = false;
      // 说明：electron-updater 没有"跳过某版本"的持久化 API，
      // "跳过此版本"只对本次会话生效；下次启动仍会提示。
      // 这是刻意的取舍——不做额外的本地状态，避免和未来版本行为冲突。
      return;
    }

    manualCheck = false;
    await downloadUpdate();
  }

  async function downloadUpdate() {
    try {
      state = 'downloading';
      setProgressFeedback(0);
      await autoUpdater.downloadUpdate();
    } catch (error) {
      setProgressFeedback(null);
      // downloadUpdate 的失败也会触发 error 事件；这里只兜底弹一次。
      if (state === 'downloading') {
        state = 'idle';
        await dialog.showMessageBox(window, {
          type: 'warning',
          title: text().downloadFailedTitle,
          message: text().downloadFailedBody,
          detail: String(error?.message ?? error),
          buttons: [text().ok ?? 'OK'],
          noLink: true,
        });
      }
    }
  }

  /** 下载完成后确认安装；安装前备份数据。 */
  async function promptForInstall(info) {
    const version = info?.version ?? '?';
    const { response } = await dialog.showMessageBox(window, {
      type: 'info',
      title: text().installTitle,
      message: text().installBody(version),
      detail: text().installNote,
      buttons: [text().installNow, text().installLater],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });

    if (response !== 0) return;

    const backup = backupUserData();
    if (backup.ok) {
      // 备份结果用非阻塞方式告知，避免再挡一次安装。
      void dialog.showMessageBox(window, {
        type: 'info',
        title: text().installTitle,
        message: text().backedUp(backup.directory),
        buttons: [text().installNow],
        noLink: true,
      });
    } else if (backup.reason !== 'no-data') {
      void dialog.showMessageBox(window, {
        type: 'warning',
        title: text().installTitle,
        message: text().backupFailed,
        detail: String(backup.reason ?? ''),
        buttons: [text().installNow],
        noLink: true,
      });
    }

    setImmediate(() => autoUpdater.quitAndInstall(false, true));
  }

  /**
   * 探针模式：自动走完「检查 → 下载」，并验证数据备份，最后写 JSON 报告后退出。
   * 不执行安装（安装会把测试机的正式版本替换掉）。
   */
  async function runUpdateProbe() {
    trace('runUpdateProbe 开始');
    const report = {
      currentVersion: app.getVersion(),
      packaged: app.isPackaged,
      outcome: 'pending',
      availableVersion: null,
      downloaded: false,
      backup: null,
      error: null,
    };

    const writeReport = () => {
      try {
        fs.mkdirSync(app.getPath('userData'), { recursive: true });
        fs.writeFileSync(
          path.join(app.getPath('userData'), UPDATE_PROBE_REPORT_NAME),
          JSON.stringify(report, null, 2),
          'utf8',
        );
      } catch {
        // 写不出来就让测试脚本超时失败，不要影响退出。
      }
    };

    const waitFor = (predicate, timeoutMs) =>
      new Promise(resolve => {
        const startedAt = Date.now();
        const timer = setInterval(() => {
          if (predicate() || Date.now() - startedAt > timeoutMs) {
            clearInterval(timer);
            resolve(predicate());
          }
        }, 300);
      });

    try {
      trace(
        `开始检查更新；配置路径=${app.isPackaged ? path.join(process.resourcesPath, 'app-update.yml') : 'dev'}`,
      );
      autoUpdater.checkForUpdates().catch(error => {
        trace(`checkForUpdates 抛错：${error?.message ?? error}`);
        report.error = String(error?.message ?? error);
      });
      trace('checkForUpdates 已调用');

      const becameAvailable = await waitFor(
        () => state === 'available' || state === 'downloaded',
        30_000,
      );
      trace(
        `等待结果：available=${becameAvailable} state=${state} version=${lastVersion} error=${lastError}`,
      );
      report.availableVersion = lastVersion;
      if (!becameAvailable) {
        report.outcome = lastError === null ? 'no-update' : 'check-failed';
        report.error = lastError;
        writeReport();
        return report;
      }

      // 走一次真实的下载（sha512 校验也在这条路径上）。
      autoUpdater.autoDownload = true;
      trace('开始 downloadUpdate');
      await Promise.race([
        autoUpdater.downloadUpdate().catch(error => {
          trace(`downloadUpdate 抛错：${error?.message ?? error}`);
        }),
        // 不靠 downloadUpdate 的返回值判断成败：它以事件为准，
        // 这里只是给一个上限，真正的判据是下面的 downloaded 事件。
        new Promise(resolve => setTimeout(resolve, 300_000)),
      ]);
      trace(`downloadUpdate 返回，state=${state}`);

      const downloaded = await waitFor(() => state === 'downloaded', 60_000);
      report.downloaded = downloaded;
      trace(`下载结果：downloaded=${downloaded}`);

      // 验证安装前的数据备份确实能产出可用的目录。
      const backup = backupUserData();
      report.backup = backup.ok
        ? {
            ok: true,
            directory: backup.directory,
            fileCount: countFiles(backup.directory),
            skippedFiles: backup.skippedFiles.length,
          }
        : { ok: false, reason: backup.reason };

      report.outcome = downloaded ? 'downloaded' : 'download-failed';
      report.error = lastError;
    } catch (error) {
      report.outcome = 'error';
      report.error = String(error?.message ?? error);
    }

    writeReport();
    return report;
  }

  /** 与主进程其它地方一致的 UA，便于对方识别来源。 */
  function userAgent() {
    return `EndaxisDesktop/${app.getVersion()}`;
  }

  /** 把 tag（可能是 v1.0.1 / 1.0.1 / desktop-v1.0.1）规整成 1.0.1。 */
  function normalizeVersion(value) {
    const match = /(\d+)\.(\d+)\.(\d+)/.exec(value ?? '');
    return match === null ? null : `${match[1]}.${match[2]}.${match[3]}`;
  }

  /** 简易 semver 比较：仅比较数字段，足够判断"有没有更新"。 */
  function compareVersions(left, right) {
    const toNumbers = value => value.split('.').map(part => Number.parseInt(part, 10));
    const a = toNumbers(left);
    const b = toNumbers(right);
    for (let index = 0; index < 3; index += 1) {
      if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
    }
    return 0;
  }

  /** releaseNotes 里可能带 HTML，展示前去掉标签。 */
  function stripHtml(value) {
    return value.replace(/<[^>]*>/g, '').replace(/\n{3,}/g, '\n\n');
  }

  /**
   * 查线上最新版本号。**不依赖 electron-updater 内部的 API 调用**。
   *
   * 为什么自己查：electron-updater 固定走 api.github.com，既受匿名限流
   * （60 次/小时）又不支持走镜像；而"换镜像"恰恰是本项目要支持的场景
   * （无法直连 GitHub 的用户）。自己查之后，镜像选择对"查版本"和"下载"
   * 两条路都生效。
   *
   * 尝试顺序：先问支持 API 代理的镜像（每个都试，避免单点故障），
   * 再退到直连的 Releases Atom feed（实测没有镜像支持 atom，全是 403/404）。
   *
   * @returns {Promise<{version: string, source: string}|null>}
   */
  async function discoverLatestVersion() {
    const releaseApiUrl = `https://api.github.com/repos/${RELEASE_OWNER}/${RELEASE_REPO}/releases/latest`;

    for (const mirror of MIRRORS) {
      if (!mirror.supportsApi) continue;
      try {
        const response = await fetch(applyMirror(releaseApiUrl, mirror), {
          headers: { Accept: 'application/vnd.github+json', 'User-Agent': userAgent() },
        });
        if (!response.ok) {
          trace(`查版本失败（${mirror.id}）：HTTP ${response.status}`);
          continue;
        }
        const payload = await response.json();
        const version = normalizeVersion(payload?.tag_name ?? payload?.name ?? '');
        if (version === null) continue;
        trace(`查版本成功（${mirror.id}）：${version}`);
        return { version, source: mirror.id };
      } catch (error) {
        trace(`查版本异常（${mirror.id}）：${error?.message ?? error}`);
      }
    }

    // 直连 Atom feed 兜底。
    try {
      const feed = `https://github.com/${RELEASE_OWNER}/${RELEASE_REPO}/releases.atom`;
      const response = await fetch(feed, {
        headers: { Accept: 'application/atom+xml', 'User-Agent': userAgent() },
      });
      if (response.ok) {
        const xml = await response.text();
        const tag = /<entry>[\s\S]*?<title>([^<]+)<\/title>/.exec(xml)?.[1]?.trim() ?? null;
        const version = normalizeVersion(tag);
        if (version !== null) {
          trace(`查版本成功（atom feed）：${version}`);
          return { version, source: 'atom' };
        }
      }
    } catch (error) {
      trace(`atom feed 查版本异常：${error?.message ?? error}`);
    }

    trace('查版本失败：所有镜像与 feed 都不可用');
    return null;
  }

  /**
   * 把 electron-updater 的下载源指到"最新版本所在的目录"，并带上镜像前缀。
   *
   * generic provider 会在给定 URL 下找 `latest.yml` 与安装包，所以 base 必须
   * 精确到 `.../releases/download/v<版本>/`，不能只给 releases 页。
   *
   * @param {object|null} mirror
   * @returns {Promise<{ok: boolean, version?: string}>}
   */
  async function pointFeedAtLatest(mirror) {
    const discovered = await discoverLatestVersion();
    if (discovered === null) return { ok: false };
    const directory = `https://github.com/${RELEASE_OWNER}/${RELEASE_REPO}/releases/download/v${discovered.version}/`;
    const feedUrl = applyMirror(directory, mirror);
    autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl });
    trace(`下载源指向 ${feedUrl}（版本来源于 ${discovered.source}）`);
    return { ok: true, version: discovered.version };
  }

  /**
   * 测速：并发测所有镜像对**最新安装包**的下载表现。
   *
   * 用真实发布资产而不是 ping：用户关心的是"从哪个源下 117 MB 更快"，
   * 反代站常见"握手快但限速"，只看延迟会选错。
   */
  async function runSpeedTest() {
    if (speedTestInFlight !== null) return speedTestInFlight;
    speedTestInFlight = (async () => {
      const discovered = await discoverLatestVersion();
      const version = discovered?.version ?? normalizeVersion(app.getVersion()) ?? '0.0.0';
      const assetUrl =
        `https://github.com/${RELEASE_OWNER}/${RELEASE_REPO}/releases/download/` +
        `v${version}/Endaxis-Setup-${version}-x64.exe`;
      trace(`开始测速，样本 v${version}`);
      const results = await testMirrors(MIRRORS, assetUrl);
      lastSpeedTest = { at: Date.now(), version, results };
      for (const result of results) {
        trace(
          `测速 ${result.id}：ok=${result.ok} ttfb=${result.ttfbMs ?? '-'}ms ` +
            `speed=${result.speedBps === null ? '-' : `${Math.round(result.speedBps / 1024)}KB/s`}` +
            `${result.error === null ? '' : ` 错误=${result.error}`}`,
        );
      }
      return results;
    })();
    try {
      return await speedTestInFlight;
    } finally {
      speedTestInFlight = null;
    }
  }

  /**
   * 切换更新源镜像并持久化。
   *
   * 持久化是必须的：无法直连 GitHub 的用户如果每次开程序都要手动切一次，
   * 等于这个功能没做。
   */
  function selectMirror(mirrorId) {
    const mirror = findMirror(mirrorId);
    if (mirror === null) return { ok: false };
    selectedMirror = mirror;
    writePreferences({ mirrorId: mirror.id });
    trace(`更新源已切换为 ${mirror.name}`);
    return { ok: true, mirror: { id: mirror.id, name: mirror.name } };
  }

  /** 供界面读取的完整状态（镜像列表 + 选中项 + 上次测速 + 官方发布页）。 */
  function describeSources() {
    return {
      currentVersion: app.getVersion(),
      mirrors: MIRRORS.map(mirror => ({
        id: mirror.id,
        name: mirror.name,
        description: mirror.description,
        supportsApi: mirror.supportsApi,
      })),
      selectedId: selectedMirror?.id ?? DEFAULT_MIRROR_ID,
      speedTest: lastSpeedTest,
      listUrl: MIRROR_LIST_URL,
    };
  }

  /**
   * electron-updater 检查失败时的兜底：自己查版本并给出结论。
   *
   * 典型触发场景是 api.github.com 匿名限流（60 次/小时，共享出口 IP 很容易
   * 打满），表现为"检查更新静默失败"，用户完全看不出原因。
   *
   * @returns {Promise<boolean>} 是否成功给出结论
   */
  async function recoverFromApiRateLimit() {
    const discovered = await discoverLatestVersion();
    const currentVersion = normalizeVersion(app.getVersion());
    if (discovered === null || currentVersion === null) return false;

    const isNewer = compareVersions(discovered.version, currentVersion) > 0;
    trace(`兜底结论：最新 ${discovered.version}，当前 ${currentVersion}，有更新=${isNewer}`);

    if (!isNewer) {
      publishStatus({ state: 'up-to-date', version: currentVersion });
      return true;
    }

    // 有新版本：把下载源指过去，然后按正常流程（用户确认后）下载。
    lastVersion = discovered.version;
    await pointFeedAtLatest(selectedMirror);
    publishStatus({ state: 'available', version: discovered.version });
    if (manualCheck) {
      manualCheck = false;
      const { response } = await dialog.showMessageBox(window, {
        type: 'info',
        title: text().availableTitle,
        message: text().availableBody(discovered.version, app.getVersion()),
        detail: text().rateLimitedHint,
        buttons: [text().download, text().later],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (response === 0) await downloadUpdate();
    }
    return true;
  }

  return {
    /** 手动检查（菜单触发），会给出明确反馈。 */
    checkForUpdatesManually() {
      if (isDevelopment) {
        void dialog.showMessageBox(window, {
          type: 'info',
          title: text().checkNow,
          message: text().devMode,
          buttons: [text().ok ?? 'OK'],
          noLink: true,
        });
        return;
      }
      manualCheck = true;
      autoUpdater.checkForUpdates().catch(async () => {
        const recovered = await recoverFromApiRateLimit();
        if (recovered) manualCheck = false;
      });
    },
    /** 启动后静默检查：失败不打扰用户，结果只走右下角浮层。 */
    checkForUpdatesSilently() {
      trace(`checkForUpdatesSilently: isDevelopment=${isDevelopment} updateProbe=${updateProbe}`);
      if (isDevelopment) return;
      if (updateProbe) {
        void runUpdateProbe().then(report => {
          trace(`探针结束：${JSON.stringify(report)}`);
          console.log('ENDAXIS_UPDATE_PROBE ' + JSON.stringify(report));
          setTimeout(() => app.exit(0), 200);
        });
        return;
      }
      manualCheck = false;
      // 先把下载源指到最新版本目录（走当前镜像），再做常规检查。
      void (async () => {
        publishStatus({ state: 'checking' });
        const pointed = await pointFeedAtLatest(selectedMirror);
        if (!pointed.ok) {
          // 查不到版本时仍让 electron-updater 试一次（可能直连可用）。
          trace('未能预先定位版本目录，回退到 electron-updater 默认检查');
        }
        autoUpdater.checkForUpdates().catch(error => {
          // 静默检查失败就算了，用户可用菜单手动检查。
          trace(`静默检查失败：${error?.message ?? error}`);
          publishStatus({ state: 'idle' });
        });
      })();
    },
    getState: () => state,
    /** 界面用：镜像列表、当前选择、上次测速结果、官方地址发布页。 */
    describeSources,
    /** 界面用：切换更新源镜像（会持久化）。 */
    selectMirror,
    /** 界面用：主动测速（并发测所有镜像的下载表现）。 */
    runSpeedTest,
    /** 界面用：镜像列表、当前选择、上次测速结果。 */
    describeSources,
    /** 界面用：切换镜像。 */
    selectMirror,
    /** 界面用：主动测速。 */
    runSpeedTest,
    /** 界面用：查询最新版本（不下载）。 */
    async queryLatest() {
      const discovered = await discoverLatestVersion();
      const current = normalizeVersion(app.getVersion());
      if (discovered === null) return { ok: false };
      return {
        ok: true,
        latest: discovered.version,
        current,
        source: discovered.source,
        hasUpdate: current !== null && compareVersions(discovered.version, current) > 0,
      };
    },
    /** 界面用：开始下载（用户确认后）。 */
    async startDownload() {
      const pointed = await pointFeedAtLatest(selectedMirror);
      if (!pointed.ok) return { ok: false, reason: 'discover-failed' };
      publishStatus({ state: 'downloading', version: pointed.version, percent: 0 });
      await downloadUpdate();
      return { ok: true, version: pointed.version };
    },
    /** 界面用：下载完成后重启安装。 */
    installNow() {
      state = 'idle';
      const backup = backupUserData();
      trace(`手动安装：备份 ok=${backup.ok} reason=${backup.reason ?? '-'}`);
      void dialog
        .showMessageBox(window, {
          type: backup.ok || backup.reason === 'no-data' ? 'info' : 'warning',
          title: text().installTitle,
          message:
            backup.ok && backup.directory
              ? text().backedUp(backup.directory)
              : text().installBody(lastVersion ?? ''),
          buttons: [text().installNow],
          noLink: true,
        })
        .then(() => {
          setImmediate(() => autoUpdater.quitAndInstall(false, true));
        });
      return { ok: true };
    },
    /** 退出前清理重发定时器，避免留下悬空 interval。 */
    dispose() {
      clearInterval(statusReplayTimer);
    },
  };
}

/**
 * 把用户数据复制到 userData/data-backups/<时间戳>/。
 *
 * 关键点：**跳过被占用的文件，而不是让整个备份失败**。
 * 应用还在运行时 Chromium 会持续占用 Network/ 下的 Cookies、Network Persistent
 * State 等文件，`fs.cpSync` 遇到它们会直接抛 EACCES（实测踩过）。丢掉这些文件
 * 没有影响——它们是运行时会话状态，应用下次启动会自己重建；真正要保住的是
 * IndexedDB / Local Storage 里的项目数据。
 *
 * @returns {{ok: true, directory: string, copiedFiles: number, skippedFiles: string[]} | {ok: false, reason: string}}
 */
function backupUserData() {
  const userData = app.getPath('userData');
  const copiedFiles = [];
  const skippedFiles = [];

  const copyTree = (source, destination) => {
    fs.mkdirSync(destination, { recursive: true });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      const from = path.join(source, entry.name);
      const to = path.join(destination, entry.name);
      if (entry.isDirectory()) {
        copyTree(from, to);
        continue;
      }
      try {
        fs.copyFileSync(from, to);
        copiedFiles.push(from);
      } catch (error) {
        // 占用/权限问题都只影响单个文件：记录下来继续。
        skippedFiles.push(`${from} (${error?.code ?? error?.message ?? 'unknown'})`);
      }
    }
  };

  const required = BACKUP_DIRECTORIES.filter(name => fs.existsSync(path.join(userData, name)));
  if (required.length === 0) return { ok: false, reason: 'no-data' };

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupRoot = path.join(userData, BACKUP_ROOT_NAME);
  const target = path.join(backupRoot, stamp);

  try {
    fs.mkdirSync(target, { recursive: true });

    // 必须成功：项目数据就在这里，拷不动就没有备份的意义。
    for (const name of required) {
      copyTree(path.join(userData, name), path.join(target, name));
    }
    // 尽力而为：失败不影响备份结论。
    const optional = OPTIONAL_BACKUP_DIRECTORIES.filter(name =>
      fs.existsSync(path.join(userData, name)),
    );
    for (const name of optional) {
      copyTree(path.join(userData, name), path.join(target, name));
    }

    fs.writeFileSync(
      path.join(target, BACKUP_TIMESTAMP_FILE),
      JSON.stringify(
        {
          createdAt: new Date().toISOString(),
          appVersion: app.getVersion(),
          requiredDirectories: required,
          optionalDirectories: optional,
          copiedFiles: copiedFiles.length,
          skippedFiles: skippedFiles.length,
        },
        null,
        2,
      ),
      'utf8',
    );
    trace(`备份完成：${copiedFiles.length} 个文件，跳过 ${skippedFiles.length} 个（占用/权限）`);
    for (const skipped of skippedFiles.slice(0, 10)) trace(`  跳过 ${skipped}`);

    pruneBackups(backupRoot);
    return {
      ok: true,
      directory: target,
      copiedFiles: copiedFiles.length,
      skippedFiles,
    };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** 只保留最近 MAX_BACKUPS 份。 */
function pruneBackups(backupRoot) {
  let entries;
  try {
    entries = fs
      .readdirSync(backupRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort();
  } catch {
    return;
  }
  for (const name of entries.slice(0, Math.max(0, entries.length - MAX_BACKUPS))) {
    try {
      fs.rmSync(path.join(backupRoot, name), { recursive: true, force: true });
    } catch {
      // 清理失败不影响本次备份。
    }
  }
}

module.exports = { createUpdater, backupUserData, selectUpdaterStrings: selectStrings };
