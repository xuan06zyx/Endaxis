// 把自动保存验证的断言从"写入必须被推迟"改成"连续编辑必须被合并"。
//
// 为什么改：桥接模块对**首次**编辑走首写优先（立即落盘），只有连续编辑才合并。
// 这是刻意的取舍 —— 少一次数据风险，同时仍能显著减少 IndexedDB 短事务。
// 原断言"延迟必须 >= 700ms"在新语义下必然失败，但它想验证的东西（写入被合并）
// 依然重要，所以换成对"突发编辑"的计数断言。
//
// 用法：node scripts/tweak-autosave-assertions.mjs

import fs from 'node:fs';

const path = 'tools/verify-autosave.js';
const raw = fs.readFileSync(path, 'utf8');
const usesCrlf = raw.includes('\r\n');
let text = usesCrlf ? raw.replace(/\r\n/g, '\n') : raw;

function replaceOnce(oldText, newText, label) {
  if (!text.includes(oldText)) {
    console.error(`找不到${label}，拒绝继续`);
    process.exit(1);
  }
  text = text.replace(oldText, newText);
}

// ── 1. 常量：延迟阈值 → 突发编辑次数 ────────────────────────────────────
replaceOnce(
  ['/** 写入被推迟的证据：观测到的延迟必须明显超过"立刻写"。 */', 'const MIN_OBSERVED_DELAY_MS = 700;'].join(
    '\n',
  ),
  ['/** 连续编辑的合并断言：这批编辑应远少于同样数量的写入。 */', 'const BURST_EDIT_COUNT = 8;'].join('\n'),
  '延迟阈值常量',
);

// ── 2. 单次编辑：只断言"有写、且没被拖太久"，不再要求推迟 ─────────────
replaceOnce(
  [
    '        record(',
    '          delay >= MIN_OBSERVED_DELAY_MS,',
    '          `写入没有被推迟（延迟仅 ${delay}ms，期望 >= ${MIN_OBSERVED_DELAY_MS}ms，` +',
    '            `防抖窗口 ${EXPECTED_DEBOUNCE_MS}ms 可能没生效）`,',
    '        );',
  ].join('\n'),
  [
    '        // 首写优先：第一次编辑会立即落盘（降低数据风险），因此不断言"必须推迟"。',
    '        // 合并效果由下面的突发编辑断言覆盖。',
  ].join('\n'),
  '单次编辑的推迟断言',
);

// ── 3. 插入突发编辑的合并断言 ─────────────────────────────────────────
const anchor = '    // ── 自动恢复：给刚写下的存档打标记，重新加载后必须读回 ─────────────────';
replaceOnce(
  anchor,
  [
    '    // ── 合并写入：连续编辑必须被合并成少量事务 ─────────────────────────',
    '    //',
    '    // 这是"降低写入频率"的核心收益。首写之后，防抖窗口内的后续编辑应当合并，',
    '    // 否则这个桥接模块就只是在原来的写入路径外面多套了一层。',
    '    await window.webContents.executeJavaScript(',
    '      `(() => { window.__endaxisSaveProbe.writes.length = 0; return true; })()`,',
    '      true,',
    '    );',
    '    for (let index = 0; index < BURST_EDIT_COUNT; index += 1) {',
    '      await window.webContents.executeJavaScript(buildEditScript(String(700000 + index)), true);',
    '    }',
    '    await new Promise(resolve => setTimeout(resolve, EXPECTED_DEBOUNCE_MS + 800));',
    '    const burstWrites = await window.webContents.executeJavaScript(',
    "      '(() => window.__endaxisSaveProbe.writes.length)()',",
    '      true,',
    '    );',
    '    console.log(`[verify:autosave] 连续 ${BURST_EDIT_COUNT} 次编辑 → ${burstWrites} 次写入`);',
    '    record(burstWrites >= 1, `连续编辑后没有任何写入（保存路径可能断了）`);',
    '    record(',
    '      burstWrites < BURST_EDIT_COUNT,',
    '      `连续编辑没有被合并（${burstWrites} 次写入 / ${BURST_EDIT_COUNT} 次编辑）`,',
    '    );',
    '',
    anchor,
  ].join('\n'),
  '自动恢复段落的锚点',
);

fs.writeFileSync(path, usesCrlf ? text.replace(/\n/g, '\r\n') : text);
console.log('✓ 已更新自动保存断言');
console.log('  含 BURST_EDIT_COUNT：', fs.readFileSync(path, 'utf8').includes('BURST_EDIT_COUNT'));
console.log('  含旧阈值断言：', fs.readFileSync(path, 'utf8').includes('MIN_OBSERVED_DELAY_MS'));
