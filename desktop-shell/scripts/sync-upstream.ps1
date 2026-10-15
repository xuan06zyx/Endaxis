# 同步上游代码：能自动合并就合并，冲突就喊人。
#
# 为什么冲突必须交给人：桌面壳对上游源码有 3 处补丁（防抖合并、关窗落盘桥接、
# 路由启用持久化）。上游一旦改动这些文件，Git 可能给出"自动合并成功"但结果
# **在语义上是错的**（比如把桥接调用挪到了不存在的作用域），也可能直接冲突。
# 所以本脚本在合并后还会断言补丁仍然存在 —— 只信 Git 的退出码是不够的。
#
# 用法（CI 与本地同一套逻辑）：
#   pwsh -File scripts/sync-upstream.ps1                        # 只检查，不改动
#   pwsh -File scripts/sync-upstream.ps1 -Apply -Bump patch     # 合并并升版本
#
# 输出（供工作流读取）：
#   next=<版本号>        合并后的新版本号（仅 -Apply 时）
#   synced=true|false   是否有上游更新被合并
#   写进 $env:GITHUB_OUTPUT（若存在）

param(
  [switch]$Apply,
  [ValidateSet('patch', 'minor', 'major')][string]$Bump = 'patch',
  [string]$UpstreamUrl = 'https://github.com/Lieyuan621/Endaxis.git',
  [string]$UpstreamBranch = 'refactor/v3'
)

$ErrorActionPreference = 'Stop'

function Write-OutputPair {
  param([string]$Key, [string]$Value)
  Write-Host "  $Key=$Value"
  if ($env:GITHUB_OUTPUT) { Add-Content -Path $env:GITHUB_OUTPUT -Value "$Key=$Value" }
}

function Fail {
  param([string]$Message)
  Write-Host "::error::$Message"
  if ($env:GITHUB_OUTPUT) { Add-Content -Path $env:GITHUB_OUTPUT -Value 'synced=false' }
  exit 1
}

Write-Host '=== 1. 抓取上游 ==='
git remote remove upstream 2>$null | Out-Null
git remote add upstream $UpstreamUrl
git fetch --quiet upstream $UpstreamBranch
$upstreamRef = 'FETCH_HEAD'
$upstreamHead = (git rev-parse $upstreamRef).Trim()
Write-Host "  上游 $UpstreamBranch = $($upstreamHead.Substring(0,8))"

Write-Host '=== 2. 判断是否有新提交 ==='
git merge-base --is-ancestor $upstreamRef HEAD
$alreadyMerged = $LASTEXITCODE -eq 0
if ($alreadyMerged) {
  Write-Host '  已是最新，无需同步'
  Write-OutputPair 'synced' 'false'
  exit 0
}
$incoming = @(git log --oneline "HEAD..$upstreamRef")
Write-Host "  发现 $($incoming.Count) 个新提交："
$incoming | Select-Object -First 15 | ForEach-Object { Write-Host "    $_" }
if ($incoming.Count -gt 15) { Write-Host "    …（共 $($incoming.Count) 个）" }

if (-not $Apply) {
  Write-Host ''
  Write-Host '  （未加 -Apply，仅检查，不做改动）'
  Write-OutputPair 'synced' 'false'
  exit 0
}

Write-Host '=== 3. 合并上游 ==='
# --no-edit 用默认合并信息；--no-ff 保证留下合并提交，便于日后回溯同步点。
git -c user.name='endaxis-sync' -c user.email='endaxis-sync@users.noreply.github.com' `
  merge --no-ff --no-edit $upstreamRef 2>&1 | ForEach-Object { "  $_" }
if ($LASTEXITCODE -ne 0) {
  $conflicts = @(git diff --name-only --diff-filter=U)
  Write-Host ''
  Write-Host '  冲突文件：'
  $conflicts | ForEach-Object { Write-Host "    $_" }
  # 中止合并，保持工作区干净：半个合并状态留在仓库里更危险。
  git merge --abort 2>$null | Out-Null
  Fail "上游改动与桌面壳补丁冲突，需要人工解决。冲突文件：$($conflicts -join ', ')"
}

Write-Host '=== 4. 断言桌面壳补丁仍然存在 ==='
# Git 说"合并成功"不等于语义正确：上游可能删掉/挪动了补丁依赖的代码，
# 而合并结果里补丁调用仍在，却指向了不存在的东西。这里逐条验证关键符号。
$checks = @(
  @{ file = 'src/ui/timeline/projectFileSession.ts'; pattern = 'BROWSER_SAVE_DEBOUNCE_MS'; why = '防抖窗口常量' },
  @{ file = 'src/ui/timeline/projectFileSession.ts'; pattern = 'flushBrowserSaveAndWait'; why = '等待写入完成的出口' },
  @{ file = 'src/ui/timeline/projectFileSession.ts'; pattern = 'closeFlushHandler'; why = '关窗落盘登记处' },
  @{ file = 'src/ui/timeline/TimelineEditor.vue'; pattern = 'EndaxisDesktop'; why = '关窗落盘桥接' },
  @{ file = 'src/ui/timeline/TimelineEditor.vue'; pattern = 'flushBrowserSaveAndWait'; why = '桥接调用的函数' }
)
$missing = @()
foreach ($check in $checks) {
  if (-not (Test-Path $check.file)) { $missing += "$($check.file) 不存在"; continue }
  $hit = Select-String -Path $check.file -Pattern $check.pattern -Quiet
  if ($hit) { Write-Host "  ✓ $($check.why)" } else { Write-Host "  ✗ $($check.why)（$($check.pattern) 不见了）"; $missing += $check.why }
}

# 上游若改了存档格式，用户的旧项目可能读不出来 —— 必须提醒而不是默默发布。
$schemaChanged = @(git diff --name-only "HEAD^1..HEAD" -- src/core/project)
if ($schemaChanged.Count -gt 0) {
  Write-Host "  ⚠ 上游改动了项目数据格式相关文件："
  $schemaChanged | ForEach-Object { Write-Host "      $_" }
  Write-Host '    → 发布前请确认旧存档仍可读取'
}

if ($missing.Count -gt 0) {
  Fail "合并结果缺少桌面壳补丁：$($missing -join '、')。请人工检查后再发布。"
}

Write-Host '=== 5. 提升版本号 ==='
# 语义化版本：patch 递增（如 1.0.8 → 1.0.9）。不用时间戳构造版本号，
# 免得出现 1.0.20261015 这种读不懂的东西。
Push-Location desktop-shell
try {
  $current = (Get-Content package.json -Raw | ConvertFrom-Json).version
  $parts = $current.Split('.')
  $next = switch ($Bump) {
    'major' { "$([int]$parts[0] + 1).0.0" }
    'minor' { "$($parts[0]).$([int]$parts[1] + 1).0" }
    default { "$($parts[0]).$($parts[1]).$([int]$parts[2] + 1)" }
  }
  Write-Host "  $current → $next（$Bump）"
  npm version $next --no-git-tag-version --allow-same-version --silent | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail 'npm version 失败' }
} finally {
  Pop-Location
}

git add desktop-shell/package.json desktop-shell/package-lock.json
git -c user.name='endaxis-sync' -c user.email='endaxis-sync@users.noreply.github.com' `
  commit --no-verify -m "Sync: 提升桌面版版本号至 $next" | Out-Null

Write-OutputPair 'synced' 'true'
Write-OutputPair 'next' $next
Write-Host ''
Write-Host "完成：已合并上游并升版本至 $next"
