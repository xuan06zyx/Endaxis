'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

/**
 * 本地静态服务器。
 *
 * 为什么不用 `file://`：Vite 产物使用 `/assets/...` 绝对路径，且项目路由是
 * `createWebHistory('/')`（仅 Android 容器走 hash 路由）。只有真正的 HTTP 源
 * 才能让绝对路径、History API 与 IndexedDB/localStorage 都按浏览器语义工作。
 *
 * 服务器只绑定 127.0.0.1 的临时端口，不对外网暴露。
 */

const MIME_TYPES = new Map(
  Object.entries({
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.txt': 'text/plain; charset=utf-8',
    '.wasm': 'application/wasm',
    '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4',
  }),
);

function setCommonHeaders(res, statusCode, contentType) {
  res.statusCode = statusCode;
  if (contentType) res.setHeader('Content-Type', contentType);
  // 图标等资源按内容类型强约定，禁止嗅探。
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // 本地应用不需要 referrer；避免把内部端口写进任何外发信息。
  res.setHeader('Referrer-Policy', 'no-referrer');
}

function sendText(res, statusCode, text) {
  setCommonHeaders(res, statusCode, 'text/plain; charset=utf-8');
  res.end(text);
}

/** 未命中真实文件时回落到 SPA 入口（History 路由需要）。 */
async function sendIndexHtml(res, root) {
  const indexPath = path.join(root, 'index.html');
  let html;
  try {
    html = await fsp.readFile(indexPath);
  } catch {
    sendText(res, 500, 'index.html 缺失，请先执行 npm run build:web 与 npm run prepare:dist');
    return;
  }
  setCommonHeaders(res, 200, MIME_TYPES.get('.html'));
  res.setHeader('Cache-Control', 'no-cache');
  res.end(html);
}

function isWithinRoot(root, candidate) {
  if (candidate === root) return true;
  return candidate.startsWith(root + path.sep);
}

async function serveFile(req, res, filePath) {
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;

  const extension = path.extname(filePath).toLowerCase();
  setCommonHeaders(res, 200, MIME_TYPES.get(extension) ?? 'application/octet-stream');
  // Vite 产物文件名带内容哈希，可长期缓存；HTML 除外。
  res.setHeader('Cache-Control', 'public, max-age=3600');
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }

  try {
    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(filePath);
      stream.on('error', reject);
      stream.on('end', resolve);
      // 客户端提前断开（例如切换路由）时结束即可，不算错误。
      res.on('close', () => stream.destroy());
      stream.pipe(res);
    });
  } catch {
    if (!res.headersSent) sendText(res, 500, '读取文件失败');
    else res.destroy();
  }
  return true;
}

function decodeRequestPath(rawUrl) {
  try {
    return decodeURIComponent(new URL(rawUrl, 'http://127.0.0.1').pathname);
  } catch {
    return null;
  }
}

/**
 * 固定端口。
 *
 * **这是持久化能工作的前提，不要改回随机端口。**
 * 项目的自动保存用 IndexedDB，而浏览器按 **origin**（协议+主机+端口）隔离存储。
 * 端口每次都变 = 每次启动都是全新 origin = 上一次的项目数据变成孤儿再也读不到。
 * 实测表现就是"设置好干员，关掉再打开又回到初始状态"。
 *
 * 因此端口被占用时**绝不换端口**：换端口同样会让用户读不到自己的项目。
 * 这里只在固定端口上重试（另一个实例可能正在退出，通常几秒内释放），
 * 仍失败就报错让用户处理，而不是悄悄换一个端口继续跑。
 * 详见 startStaticServer 的返回值。
 */
const FIXED_PORT = 17321;
/** 重试节奏：覆盖"上一个实例正在退出"这种短暂占用，约 12 秒。 */
const PORT_RETRY_DELAYS_MS = [200, 400, 800, 1200, 1600, 2000, 2000, 2000, 2000];
/** 测试/诊断可指定端口。 */
function resolveFixedPort() {
  const requested = Number.parseInt(process.env.ENDAXIS_SERVER_PORT ?? '', 10);
  if (Number.isInteger(requested) && requested > 0 && requested <= 65535) return requested;
  return FIXED_PORT;
}

/** 端口占用时落盘记一笔，方便排查"为什么数据没保留"。 */
function logPortFallback(message) {
  try {
    fs.appendFileSync(
      path.join(require('node:os').tmpdir(), 'endaxis-server-port.log'),
      `[${new Date().toISOString()}] ${message}\n`,
      'utf8',
    );
  } catch {
    // 记录失败不影响启动。
  }
}

/**
 * 在固定端口上监听：先试一次，被占用则按节奏重试（上一个实例可能正在退出）。
 *
 * @returns {Promise<number|null>} 成功返回端口；端口被占用返回 null；其它错误抛出。
 */
async function listenOnFixedPort(server) {
  const port = resolveFixedPort();
  const attempts = PORT_RETRY_DELAYS_MS.length + 1;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const outcome = await new Promise(resolve => {
      const onError = error => {
        server.removeListener('listening', onListening);
        resolve(error);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve(true);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    });

    if (outcome === true) return port;
    const code = outcome?.code;
    if (code !== 'EADDRINUSE' && code !== 'EACCES') throw outcome;
    if (attempt === attempts - 1) return null;
    logPortFallback(
      `端口 ${port} 被占用（${code}），${PORT_RETRY_DELAYS_MS[attempt]}ms 后重试（第 ${attempt + 1} 次）`,
    );
    await new Promise(resolve => setTimeout(resolve, PORT_RETRY_DELAYS_MS[attempt]));
  }
  return null;
}

/**
 * 固定端口被长期占用。
 *
 * 用专门的错误类型而不是返回 null：调用方（含各种验证/诊断脚本）大多直接
 * 使用返回值，抛错能让它们自然失败并报出原因，不需要每处都加判空。
 */
class PortUnavailableError extends Error {
  constructor(port) {
    super(`端口 ${port} 被占用，无法启动本地服务`);
    this.name = 'PortUnavailableError';
    this.port = port;
  }
}

/**
 * @param {string} distDirectory 站点根目录的绝对路径
 * @returns {Promise<{ origin: string, port: number, close: () => Promise<void> }>}
 * @throws {PortUnavailableError} 固定端口被长期占用时。**绝不换端口继续启动**：
 *   换端口等于换 origin，用户会读不到自己的项目（详见文件顶部注释）。
 */
async function startStaticServer(distDirectory) {
  const root = path.resolve(distDirectory);

  const server = http.createServer((req, res) => {
    handleRequest(req, res, root).catch(() => {
      if (!res.headersSent) sendText(res, 500, '内部错误');
      else res.destroy();
    });
  });

  // 不要因为单个请求报错就拖垮整个壳。
  server.on('clientError', (_error, socket) => socket.destroy());

  const port = await listenOnFixedPort(server);
  if (port === null) {
    // 关键：**不退回随机端口**。换端口意味着换 origin，用户读不到自己的项目，
    // 比"起不来"更糟——起不来至少能看见错误。
    logPortFallback(
      `端口 ${resolveFixedPort()} 持续被占用，拒绝启动（不换端口，以免丢失项目可见性）`,
    );
    throw new PortUnavailableError(resolveFixedPort());
  }

  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    close: () =>
      new Promise(resolve => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

async function handleRequest(req, res, root) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    setCommonHeaders(res, 405, 'text/plain; charset=utf-8');
    res.setHeader('Allow', 'GET, HEAD');
    res.end('Method Not Allowed');
    return;
  }

  const requestPath = decodeRequestPath(req.url ?? '/');
  if (requestPath === null) {
    sendText(res, 400, '错误的请求路径');
    return;
  }

  // 解析后仍在根目录内，才允许读写磁盘；否则一律回落到 SPA 入口。
  const resolved = path.resolve(root, `.${path.posix.normalize(requestPath)}`);
  const candidate = isWithinRoot(root, resolved) ? resolved : null;

  if (candidate !== null && (await serveFile(req, res, candidate))) return;

  // 目录请求与未知路径都交给前端路由处理。
  await sendIndexHtml(res, root);
}

module.exports = {
  startStaticServer,
  MIME_TYPES,
  FIXED_PORT,
  resolveFixedPort,
  PortUnavailableError,
};
