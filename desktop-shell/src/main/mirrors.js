'use strict';

/**
 * GitHub 镜像站支持。
 *
 * 为什么需要：部分用户无法直连 GitHub，更新功能会整体失效。这里提供几个公开
 * 反代，并允许用户在"检查更新"窗口里测速后自行选择。
 *
 * ── 实测结论（改这个文件前先读，别凭猜测加镜像）──────────────────────────
 * 三类 URL 的支持情况**并不一致**，且各家不同：
 *
 *   | 能力                        | ghfast.top | gh-proxy.com | ghproxy.net |
 *   |-----------------------------|-----------|--------------|-------------|
 *   | releases/download 资产       | ✅        | ✅           | ✅          |
 *   | raw.githubusercontent 文件   | ✅        | ✅           | 未测        |
 *   | api.github.com（查版本）     | ❌ 403    | ✅           | 未测        |
 *   | releases.atom（订阅源）      | ❌ 403    | ❌ 404       | ❌ 403      |
 *
 * 由此得出两个设计约束：
 *   1. **不能靠 atom feed 兜底**（没有镜像支持它）。版本发现在镜像是走
 *      `api.github.com` 代理；这也是为什么"能查版本"要单独作为一个能力标记。
 *   2. 各家能力不同，所以每条镜像显式声明 `supportsApi`，而不是假定一致。
 *
 * 维护提醒：镜像站会失效。`MIRROR_LIST_URL` 指向官方发布页，界面上给出入口，
 * 让用户能自己去查最新可用地址，而不是只能等我们发新版。
 *
 * ── 各镜像的实际稳定性（实测，供排查参考）────────────────────────────
 *   gh-proxy.com ：54 ms 握手，稳定可用；且支持 API 代理（能查版本）。
 *   ghproxy.net  ：TCP 偶发 4 秒超时，速度偏低（约 0.5 MB/s）。
 *   ghfast.top   ：**不稳定**。曾观察到握手 1.2 s、两次 10 s 连接超时后
 *                  第三次 6.5 s 才成功。保留它是因为部分网络下它是唯一可用的；
 *                  正因为如此，"测速让用户自己选"是必需功能而不是锦上添花。
 */

/** 官方"最新地址发布页"：镜像换域名时用户可来这里查。 */
const MIRROR_LIST_URL = 'https://ghproxy.link/';

/**
 * 内置镜像列表。顺序即界面默认顺序。
 *
 * `prefix` 为 null 表示直连 GitHub 原站；否则把完整 GitHub URL 接在其后。
 */
const MIRRORS = [
  {
    id: 'github',
    name: 'GitHub 原站',
    description: '官方地址，海外网络最快',
    prefix: null,
    supportsApi: true,
  },
  {
    id: 'ghfast',
    name: 'ghfast.top',
    description: '国内常用反代，支持下载与 raw 文件',
    prefix: 'https://ghfast.top/',
    supportsApi: false,
  },
  {
    id: 'ghproxy-com',
    name: 'gh-proxy.com',
    description: '支持 API 查询，国内可直连查版本',
    prefix: 'https://gh-proxy.com/',
    supportsApi: true,
  },
  {
    id: 'ghproxy-net',
    name: 'ghproxy.net',
    description: '备用反代',
    prefix: 'https://ghproxy.net/',
    supportsApi: false,
  },
];

/** 默认选择：直连可用就用直连，否则交给测速决定。 */
const DEFAULT_MIRROR_ID = 'github';

/**
 * 把 GitHub URL 转成经指定镜像访问的 URL。
 *
 * @param {string} url 形如 https://github.com/owner/repo/...
 * @param {object|null} mirror
 * @returns {string}
 */
function applyMirror(url, mirror) {
  if (mirror === null || mirror === undefined || mirror.prefix === null) return url;
  // 已经是镜像地址就不重复叠加（用户可能在测速结果里反复切换）。
  if (url.startsWith(mirror.prefix)) return url;
  return `${mirror.prefix}${url}`;
}

/**
 * @param {string} id
 * @returns {object|null} 找不到时返回 null，调用方回退到直连。
 */
function findMirror(id) {
  return MIRRORS.find(mirror => mirror.id === id) ?? null;
}

module.exports = {
  MIRRORS,
  MIRROR_LIST_URL,
  DEFAULT_MIRROR_ID,
  applyMirror,
  findMirror,
};
