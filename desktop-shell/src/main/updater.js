'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');

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
    send('update:status', { state });
  });

  autoUpdater.on('update-available', info => {
    state = 'available';
    lastVersion = info?.version ?? null;
    send('update:status', { state, version: lastVersion });
    if (updateProbe) return; // 探针模式：不弹窗，交给 checkForUpdatesManually 自动下载。
    void promptForUpdate(info);
  });

  autoUpdater.on('update-not-available', info => {
    state = 'idle';
    // 记一行：静默检查"已是最新"时若不记录，日志里就只剩"检查开始"，
    // 无法区分"检查成功且最新"和"检查压根没跑完"（排查时踩过）。
    trace(`update-not-available（线上最新 ${info?.version ?? '?'}，当前 ${app.getVersion()}）`);
    send('update:status', { state });
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
    state = 'idle';
    lastError = String(error?.message ?? error);
    send('update:status', { state, error: lastError });
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
    send('update:status', { state, percent });
  });

  autoUpdater.on('update-downloaded', info => {
    state = 'downloaded';
    setProgressFeedback(null);
    lastVersion = info?.version ?? lastVersion;
    send('update:status', { state, version: lastVersion });
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

  /**
   * API 被限流时，改用 Releases 的 Atom feed 判断有没有新版本。
   *
   * electron-updater 走 api.github.com，而**匿名请求只有 60 次/小时**，共享出口
   * IP（公司/校园网/运营商 NAT）很容易打满，表现为"检查更新静默失败"，用户
   * 完全看不出原因。这个 feed 没有限流、同样不需要凭据；代价是只有版本号，
   * 没有 sha512——真正的下载与校验仍由 electron-updater 负责。
   *
   * @returns {Promise<boolean>} 是否成功给出结论（已弹窗）
   */
  async function recoverFromApiRateLimit() {
    const feed = resolveReleaseFeedUrl();
    if (feed === null) return false;

    let latestTag = null;
    try {
      const response = await fetch(feed, {
        headers: {
          Accept: 'application/atom+xml',
          'User-Agent': `EndaxisDesktop/${app.getVersion()}`,
        },
      });
      if (!response.ok) return false;
      const xml = await response.text();
      // feed 按时间倒序，取第一个 entry 的 title 作为最新 tag。
      latestTag = /<entry>[\s\S]*?<title>([^<]+)<\/title>/.exec(xml)?.[1]?.trim() ?? null;
    } catch {
      return false;
    }
    if (latestTag === null) return false;

    const latestVersion = normalizeVersion(latestTag);
    const currentVersion = normalizeVersion(app.getVersion());
    if (latestVersion === null || currentVersion === null) return false;

    const isNewer = compareVersions(latestVersion, currentVersion) > 0;
    trace(`限流回退：feed 最新 ${latestTag}，当前 ${currentVersion}，有更新=${isNewer}`);

    if (isNewer) {
      await dialog.showMessageBox(window, {
        type: 'info',
        title: text().availableTitle,
        message: text().availableBody(latestTag, app.getVersion()),
        detail: text().rateLimitedHint,
        buttons: [text().later],
        noLink: true,
      });
    } else {
      await dialog.showMessageBox(window, {
        type: 'info',
        title: text().upToDateTitle,
        message: text().upToDateBody(app.getVersion()),
        buttons: [text().ok ?? 'OK'],
        noLink: true,
      });
    }
    return true;
  }

  return {
    /**
     * 手动检查（菜单触发），会给出明确反馈。
     *
     * electron-updater 走 api.github.com，而**匿名请求只有 60 次/小时**，共享出口
     * IP（公司/校园网/运营商 NAT）很容易打满，表现为"检查更新静默失败"——用户
     * 完全看不出原因。所以这里在它失败后回退到 Releases 的 Atom feed：
     * 那个端点没有限流，且同样不需要凭据，只是没有 sha512（那条校验仍由
     * electron-updater 在真正下载时负责）。
     */
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
      autoUpdater.checkForUpdates().catch(async error => {
        // error 事件已经处理过提示；这里只补一次"限流时改走 feed"的机会。
        const recovered = await recoverFromApiRateLimit();
        if (recovered) manualCheck = false;
        void error;
      });
    },
    /** 启动后静默检查：失败不打扰用户。 */
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
      autoUpdater.checkForUpdates().catch(() => {
        // 静默检查失败就算了，用户可用菜单手动检查。
      });
    },
    getState: () => state,
  };
}

/** 统计备份目录里的文件数，供探针确认备份不是空的。 */
function countFiles(directory) {
  let count = 0;
  const walk = current => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else count += 1;
    }
  };
  walk(directory);
  return count;
}

/** releaseNotes 里可能带 HTML，弹窗里展示前去掉标签。 */
function stripHtml(value) {
  return value.replace(/<[^>]*>/g, '').replace(/\n{3,}/g, '\n\n');
}

/**
 * 拼出 Releases 的 Atom feed 地址。
 *
 * 优先用环境变量覆盖（自建源场景），否则读 electron-builder 写进包的
 * `app-update.yml` 里的 owner/repo。
 */
function resolveReleaseFeedUrl() {
  const override = process.env.ENDAXIS_UPDATE_URL?.trim();
  if (override) return `${override.replace(/\/$/, '')}/releases.atom`;

  try {
    const configPath = path.join(process.resourcesPath, 'app-update.yml');
    const config = fs.readFileSync(configPath, 'utf8');
    const owner = /^owner:\s*(\S+)/m.exec(config)?.[1];
    const repo = /^repo:\s*(\S+)/m.exec(config)?.[1];
    if (owner && repo) return `https://github.com/${owner}/${repo}/releases.atom`;
  } catch {
    // 读不到配置就没有回退可用。
  }
  return null;
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
