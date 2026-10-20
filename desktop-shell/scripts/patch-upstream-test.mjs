// 给上游测试补上"合并写入"所需的显式 flush。
//
// 为什么必须改上游测试：桌面壳的合并写入会把编辑排到防抖窗口之后，而这两个断言
// （错误上报）依赖"提交后已落盘"。改法是**加一行主动 flush**，不改变测试意图。
//
// 用法：node tools/patch-upstream-test.mjs

import fs from 'node:fs';

const path = 'src/ui/timeline/projectFileSession.test.ts';
const raw = fs.readFileSync(path, 'utf8');
const usesCrlf = raw.includes('\r\n');
let text = usesCrlf ? raw.replace(/\r\n/g, '\n') : raw;

const importOld = [
  'import {',
  '  createProjectFileReader,',
  '  selectProjectExportScope,',
  '  useProjectFileSession,',
  "} from './projectFileSession';",
].join('\n');
const importNew = [
  "import { createProjectFileReader, selectProjectExportScope, useProjectFileSession } from './projectFileSession';",
  '// 桌面壳的合并写入：下面有一处断言依赖“提交后已落盘”，而合并写入会把编辑',
  '// 排到防抖窗口之后，所以需要能主动 flush。',
  "import { flushBrowserSave } from '../../desktop/browserSaveBridge';",
].join('\n');

if (!text.includes(importOld)) {
  console.error('找不到 projectFileSession 的导入块，可能上游已改动，拒绝继续');
  process.exit(1);
}
text = text.replace(importOld, importNew);

const bodyOld = [
  "    project.commit('edit', value => ({ ...value, createdWith: 'edited' }));",
  '    await Promise.resolve();',
  "    expect(files.browserSaveError.value).toBe('storage unavailable');",
].join('\n');
const bodyNew = [
  "    project.commit('edit', value => ({ ...value, createdWith: 'edited' }));",
  '    // 合并写入可能把这次保存排到防抖窗口之后：先强制落盘再断言错误。',
  '    await flushBrowserSave();',
  '    await Promise.resolve();',
  "    expect(files.browserSaveError.value).toBe('storage unavailable');",
].join('\n');

if (!text.includes(bodyOld)) {
  console.error('找不到错误上报断言块，可能上游已改动，拒绝继续');
  process.exit(1);
}
text = text.replace(bodyOld, bodyNew);

fs.writeFileSync(path, usesCrlf ? text.replace(/\n/g, '\r\n') : text);

const written = fs.readFileSync(path, 'utf8');
console.log('✓ 已加入 flushBrowserSave 导入：', written.includes("from '../../desktop/browserSaveBridge'"));
console.log('✓ 已加入显式 flush：', written.includes('await flushBrowserSave();'));
