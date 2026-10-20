// 把 projectFileSession.ts 收敛成「上游原版 + 一处调用钩子」。
//
// 做法：先取上游原版内容（fbf6a292），再只做两件事：
//   1. 把 saveBrowserProject 的导入换成我们的桥接模块
//   2. 把 saveBrowserProject( 调用换成 queueBrowserSave(
//
// 其余一切（错误处理、未落盘计数、离页保护、作用域销毁）都保留上游原写法，
// 不引入任何我们自己的代码 —— 这样上游改动这个文件时几乎不会冲突。
//
// 用法：node tools/minimize-patch.mjs <上游提交>

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const upstreamRev = process.argv[2] ?? 'fbf6a292';
const target = 'src/ui/timeline/projectFileSession.ts';

const pristine = execFileSync('git', ['show', `${upstreamRev}:${target}`], { encoding: 'utf8' });
const usesCrlf = pristine.includes('\r\n');
let text = usesCrlf ? pristine.replace(/\r\n/g, '\n') : pristine;

const originalImport = "import { saveBrowserProject } from '../../data/browserProjectStorage';\n";
const bridgedImport = "import { queueBrowserSave } from '../../desktop/browserSaveBridge';\n";
if (!text.includes(originalImport)) {
  console.error('上游原版里找不到 saveBrowserProject 导入行，拒绝继续');
  process.exit(1);
}
text = text.replace(originalImport, bridgedImport);

const originalCall = 'void saveBrowserProject(snapshot.project).then(';
const bridgedCall = 'void queueBrowserSave(snapshot.project).then(';
if (!text.includes(originalCall)) {
  console.error('上游原版里找不到 saveBrowserProject(...) 调用，拒绝继续');
  process.exit(1);
}
text = text.replace(originalCall, bridgedCall);

if (usesCrlf) text = text.replace(/\n/g, '\r\n');
fs.writeFileSync(target, text);

// ── 自检：确认没有引入我们自己的实现残留 ────────────────────────────────
const written = fs.readFileSync(target, 'utf8');
const mustExist = ['queueBrowserSave(snapshot.project)', "from '../../desktop/browserSaveBridge'"];
const mustNotExist = [
  'BROWSER_SAVE_DEBOUNCE_MS',
  'BROWSER_SAVE_MAX_WAIT_MS',
  'closeFlushHandler',
  'flushBrowserSaveAndWait',
  'flushActiveProjectSave',
  'queuedProject',
];
let bad = 0;
for (const pattern of mustExist) {
  const ok = written.includes(pattern);
  console.log(`   ${ok ? '✓' : '✗'} 必须存在：${pattern}`);
  if (!ok) bad += 1;
}
for (const pattern of mustNotExist) {
  const ok = !written.includes(pattern);
  console.log(`   ${ok ? '✓' : '✗'} 不得存在：${pattern}`);
  if (!ok) bad += 1;
}
if (bad > 0) {
  console.error(`自检失败 ${bad} 项`);
  process.exit(1);
}
console.log('\n已收敛为「上游原版 + 一处钩子」');
