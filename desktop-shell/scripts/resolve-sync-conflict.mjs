// 解析 projectFileSession.ts 的合并冲突。
//
// 背景：上游把 selectProjectExportScope 从这个文件搬到了
// application/editor/projectTransfer.ts 并删除了原定义；而桌面壳的防抖补丁
// 恰好插在这个函数之后，于是 Git 判为冲突（删除 vs 修改，同一块）。
//
// 正确结果 = 我的补丁版 + 上游的搬迁：
//   1. 删除被搬走的函数定义（保留紧随其后的防抖代码）
//   2. 去掉只被该函数使用的 getProjectDefinitionLibrary 导入
//   3. 改为从新模块导入 selectProjectExportScope / ExportScenarioScope，
//      并 re-export，保持其它文件（TimelineEditor.vue）的既有导入路径可用
//
// 注意：仓库里这个文件是 CRLF 结尾（core.autocrlf=true）。第一版按 LF 匹配
// 直接找不到边界、白跑一次，所以这里先归一化处理，写回时还原原行尾符。
//
// 用法：node tools/resolve-sync-conflict.mjs <文件路径>

import fs from 'node:fs';

const target = process.argv[2];
if (!target) {
  console.error('用法：node resolve-sync-conflict.mjs <文件路径>');
  process.exit(2);
}

const original = fs.readFileSync(target, 'utf8');
const usesCrlf = original.includes('\r\n');
// 统一按 LF 处理，最后再还原，避免正则/索引被行尾符干扰。
let text = usesCrlf ? original.replace(/\r\n/g, '\n') : original;

function fail(message) {
  console.error(message);
  process.exit(1);
}

// ── 1. 删除被上游搬走的函数定义 ────────────────────────────────────────
const functionStart = text.indexOf('/** 单方案仍是完整项目');
const nextBlockMatch = /\/\*\*\n \* 连续编辑的合并窗口。/.exec(text);
if (functionStart < 0 || nextBlockMatch === null || nextBlockMatch.index <= functionStart) {
  fail('找不到函数边界，拒绝继续（避免误删补丁代码）');
}
const nextBlockStart = nextBlockMatch.index;
const removedLines = text.slice(functionStart, nextBlockStart).split('\n').length - 1;
text = text.slice(0, functionStart) + text.slice(nextBlockStart);
console.log(`1. 已删除 selectProjectExportScope 定义（${removedLines} 行）`);

// ── 2. 去掉只被该函数使用的导入 ────────────────────────────────────────
const deadImport = "import { getProjectDefinitionLibrary } from '../../core/project/projectDefinitionLibrary';\n";
if (!text.includes(deadImport)) fail('找不到 getProjectDefinitionLibrary 导入行，拒绝继续');
text = text.replace(deadImport, '');
console.log('2. 已移除 getProjectDefinitionLibrary 导入');

// ── 3. 把类型/函数改成从新模块导入，并 re-export ───────────────────────
const oldImport = "import type { ExportScenarioScope } from './components/TimelineExportDialog.vue';\n";
if (!text.includes(oldImport)) fail('找不到 ExportScenarioScope 导入行，拒绝继续');
const newImport = [
  'import {',
  '  selectProjectExportScope,',
  '  type ExportScenarioScope,',
  "} from '../../application/editor/projectTransfer';",
  "export { selectProjectExportScope } from '../../application/editor/projectTransfer';",
  '',
].join('\n');
text = text.replace(oldImport, newImport);
console.log('3. 已改为从 projectTransfer 导入并 re-export');

if (usesCrlf) text = text.replace(/\n/g, '\r\n');
fs.writeFileSync(target, text);

// ── 自检 ──────────────────────────────────────────────────────────────
const written = fs.readFileSync(target, 'utf8');
const checks = [
  ['防抖窗口常量', 'BROWSER_SAVE_DEBOUNCE_MS'],
  ['最长等待', 'BROWSER_SAVE_MAX_WAIT_MS'],
  ['等待写入出口', 'flushBrowserSaveAndWait'],
  ['关窗落盘登记处', 'closeFlushHandler'],
  ['主动 flush', 'flushActiveProjectSave'],
  ['新模块导入', "from '../../application/editor/projectTransfer'"],
  ['re-export', 'export { selectProjectExportScope }'],
  ['无冲突标记', null],
];
let bad = 0;
for (const [label, pattern] of checks) {
  const ok = pattern === null ? !/^(<{7}|={7}|>{7})/m.test(written) : written.includes(pattern);
  console.log(`   ${ok ? '✓' : '✗'} ${label}`);
  if (!ok) bad += 1;
}
const stillDefines = /export function selectProjectExportScope\(/.test(written);
console.log(`   ${stillDefines ? '✗ 旧定义仍存在' : '✓ 旧定义已移除'}`);
if (stillDefines) bad += 1;

if (bad > 0) fail(`\n自检失败 ${bad} 项，需人工检查`);
console.log('\n解析完成，自检全部通过');
