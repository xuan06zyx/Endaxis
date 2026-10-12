'use strict';

/** 校验打包产物里确实带着这次修复（固定端口 + preload）。 */

const path = require('node:path');
const asar = require('@electron/asar');

const asarPath = process.argv[2];
const read = relative =>
  asar.extractFile(asarPath, relative.split('/').join(path.sep)).toString();

const server = read('src/main/server.js');
const preload = read('src/preload.js');
const index = read('src/main/index.js');

/**
 * 去掉注释再检查代码约束。
 *
 * 注释里会举例说明"不能写 require('node:fs')"，直接匹配源码会把说明文字
 * 当成违规——这个检查必须只看真正的代码。
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const preloadCode = stripComments(preload);

const checks = [
  ['server.js 固定端口常量', server.includes('FIXED_PORT = 17321')],
  ['server.js 说明按 origin 隔离', server.includes('origin')],
  [
    'server.js 端口占用时不换端口（抛错）',
    server.includes('PortUnavailableError') && server.includes('拒绝启动'),
  ],
  ['server.js 保留占用重试', server.includes('PORT_RETRY_DELAYS_MS')],
  ['preload.js 有 flush 频道', preloadCode.includes('endaxis:flush-saves')],
  [
    'preload.js 只 require electron',
    /require\('electron'\)/.test(preloadCode) &&
      !/require\(\s*['"](?!electron)/.test(preloadCode),
  ],
  ['index.js 挂了 preload', index.includes("'preload.js'")],
  ['index.js 关窗等待保存', index.includes('attachCloseFlush')],
  ['index.js 端口占用时有明确提示', index.includes('reportPortUnavailableError')],
];

let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? '✓' : '✗'} ${label}`);
  if (!ok) failed += 1;
}
console.log(failed === 0 ? '\n打包产物校验通过。' : `\n有 ${failed} 项未通过。`);
process.exit(failed === 0 ? 0 : 1);
