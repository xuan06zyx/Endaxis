// 把 sync-upstream.yml 里「开 issue」这一步换成 actions/github-script。
//
// 为什么换：原来用 gh CLI，第一次真实运行时这一步也失败了（--label 'sync' 不存在），
// 结果是同步失败却没有任何通知——告警机制本身失效比故障更糟。
// github-script 不依赖 runner 上的 gh、不依赖 label、也不受 shell 差异影响。
//
// 用法：node tools/replace-issue-step.mjs

import fs from 'node:fs';

const path = '.github/workflows/sync-upstream.yml';
const raw = fs.readFileSync(path, 'utf8');
const usesCrlf = raw.includes('\r\n');
const lines = raw.replace(/\r\n/g, '\n').split('\n');

const startIndex = lines.findIndex(line =>
  line.includes('- name: Open issue when sync needs a human'),
);
if (startIndex < 0) {
  console.error('找不到「Open issue when sync needs a human」步骤');
  process.exit(1);
}

const marker = '上游同步需要人工处理';

const replacement = [
  '      - name: Open issue when sync needs a human',
  "        if: failure() && steps.sync.outcome != 'skipped'",
  '        uses: actions/github-script@v7',
  '        with:',
  '          script: |',
  '            // 用 github-script 而不是 gh CLI：',
  '            //   - 不依赖 runner 上有没有 gh，也不受 shell 差异影响；',
  "            //   - 不需要一个可能不存在的 label（原实现用 --label 'sync' 直接失败）；",
  '            //   - 第一次真实运行时这一步就失败了，导致「同步失败」只留下一个红叉、',
  '            //     没有任何说明。告警机制本身失效比故障更糟，所以这里要最简单可靠。',
  `            const marker = '${marker}';`,
  '            const runUrl = `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`;',
  '            const body = [',
  '              \'自动同步上游失败，**未发布任何版本**。\',',
  "              '',",
  '              `失败日志：${runUrl}`,',
  "              '',",
  "              '### 常见原因与处理',",
  "              '',",
  "              '- **上游改动了桌面壳补丁所在文件**（`src/ui/timeline/projectFileSession.ts` /",
  "              '  `src/ui/timeline/TimelineEditor.vue`）产生冲突。脚本已中止合并并保持工作区干净，',",
  "              '  不会发布半成品。',",
  "              '- **补丁符号消失**：Git 自动合并成功，但上游挪走了补丁依赖的代码。',",
  "              '- **验证未通过**：补丁单元测试或类型检查失败。',",
  "              '',",
  "              '### 处理方式',",
  "              '',",
  "              '本地复现同一套逻辑：',",
  "              '',",
  '              \'```powershell\',',
  '              \'pwsh -File desktop-shell/scripts/sync-upstream.ps1 -Apply\',',
  '              \'```\',',
  "              '',",
  "              '若冲突属于「上游把某个函数搬到新模块」这类形状，可用解析脚本只做减法：',",
  "              '',",
  '              \'```\',',
  '              \'node desktop-shell/scripts/resolve-sync-conflict.mjs src/ui/timeline/projectFileSession.ts\',',
  '              \'```\',',
  "              '',",
  "              '它只删除已被搬走的定义并改导入，找不到边界会拒绝执行，不会瞎删补丁。',",
  '            ].join(\'\\n\');',
  '',
  '            // 只维护一个跟踪 issue：已存在就追加评论，而不是每天开一个新的。',
  '            const { data: openIssues } = await github.rest.issues.listForRepo({',
  '              owner: context.repo.owner,',
  '              repo: context.repo.repo,',
  "              state: 'open',",
  '              per_page: 100,',
  '            });',
  '            const existing = openIssues.find(issue => issue.title === marker);',
  '            if (existing) {',
  '              await github.rest.issues.createComment({',
  '                owner: context.repo.owner,',
  '                repo: context.repo.repo,',
  '                issue_number: existing.number,',
  '                body,',
  '              });',
  '              core.info(`已在现有 issue #${existing.number} 追加评论`);',
  '            } else {',
  '              const created = await github.rest.issues.create({',
  '                owner: context.repo.owner,',
  '                repo: context.repo.repo,',
  '                title: marker,',
  '                body,',
  '              });',
  '              core.info(`已创建 issue #${created.data.number}`);',
  '            }',
];

const updated = [...lines.slice(0, startIndex), ...replacement].join('\n');
fs.writeFileSync(path, usesCrlf ? updated.replace(/\n/g, '\r\n') : updated);
console.log(`已替换 issue 步骤：${lines.length} 行 → ${updated.split('\n').length} 行`);
console.log(`gh CLI 残留：${(updated.match(/gh issue create/g) ?? []).length} 处（应为 0）`);
