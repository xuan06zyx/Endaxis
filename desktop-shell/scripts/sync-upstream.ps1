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
  # 上游在 2026-10-13 之后把活跃分支从 refactor/v3 换到了 main。
  # 跟踪错分支的后果是"看起来一切正常，但永远同步不到新代码"，而且不会报错。
  # 改这个值前先确认上游实际在哪条分支上提交（git ls-remote --heads <上游>）。
  [string]$UpstreamBranch = 'main'
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
# 一次性抓全部分支到 remote-tracking refs。不要依赖 FETCH_HEAD：
# 它会被后续任何一次 fetch 覆盖，用它做比较会得到前后不一致的结果（踩过）。
git fetch upstream '+refs/heads/*:refs/remotes/upstream/*' 2>&1 | ForEach-Object { "  $($_)" }
$fetchExit = $LASTEXITCODE
$trackedRef = "upstream/$UpstreamBranch"

# 关键：必须确认 ref 真的存在。
# `git rev-parse <不存在的 ref>` 会**原样回显参数**而不报错，于是下面所有比较都会
# 变成"没有新提交" —— 网络故障就被伪装成"已是最新"。这正是本次要消灭的静默故障。
$upstreamHead = (git rev-parse --verify --quiet $trackedRef 2>$null)
if ($fetchExit -ne 0 -or [string]::IsNullOrWhiteSpace($upstreamHead)) {
  Write-Host "::error::无法获取上游 $UpstreamBranch（fetch 退出码 $fetchExit，ref $trackedRef 不存在）"
  Write-Host '  可能原因：网络不可达、仓库地址错误，或上游已删除该分支。'
  Write-Host '  明确失败，而不是当作"已是最新"继续。'
  if ($env:GITHUB_OUTPUT) { Add-Content -Path $env:GITHUB_OUTPUT -Value 'synced=false' }
  exit 1
}
Write-Host "  上游 $UpstreamBranch = $($upstreamHead.Substring(0,8))"

Write-Host '=== 1b. 检查上游是不是换了活跃分支 ==='
# 跟踪的分支若已停更、而上游另一条分支还在前进，这里必须报警。
# 上一次就是这么漏掉的：refactor/v3 停在 10-13，之后所有提交都在 main 上，
# 而脚本一直报"已是最新" —— 它没说错，只是盯错了分支。
$newerBranches = @()
foreach ($ref in @(git for-each-ref --format='%(refname:short)' 'refs/remotes/upstream/')) {
  if ($ref -eq $trackedRef -or $ref -eq 'upstream/HEAD') { continue }
  git merge-base --is-ancestor $trackedRef $ref 2>$null
  if ($LASTEXITCODE -eq 0) {
    $ahead = (git rev-list --count "$trackedRef..$ref" 2>$null)
    if ([int]$ahead -gt 0) { $newerBranches += "$($ref -replace '^upstream/','')（领先 $ahead 个提交）" }
  }
}
if ($newerBranches.Count -gt 0) {
  Write-Host "  ⚠ 上游 $UpstreamBranch 之外还有更靠前的分支："
  $newerBranches | ForEach-Object { Write-Host "      $_" }
  Write-Host "    → 上游可能已切换活跃分支。若如此，请把 -UpstreamBranch 改成新分支，"
  Write-Host "      否则本脚本会一直报'已是最新'却在同步一个停更的分支。"
  if ($env:GITHUB_OUTPUT) { Add-Content -Path $env:GITHUB_OUTPUT -Value 'stale_tracker=true' }
} else {
  Write-Host '  跟踪分支是上游最靠前的（无误）'
  if ($env:GITHUB_OUTPUT) { Add-Content -Path $env:GITHUB_OUTPUT -Value 'stale_tracker=false' }
}

Write-Host '=== 2. 判断是否有新提交 ==='
git merge-base --is-ancestor $trackedRef HEAD
$alreadyMerged = $LASTEXITCODE -eq 0
if ($alreadyMerged) {
  Write-Host '  已是最新，无需同步'
  Write-OutputPair 'synced' 'false'
  exit 0
}
$incoming = @(git log --oneline "HEAD..$trackedRef")
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
  merge --no-ff --no-edit $trackedRef 2>&1 | ForEach-Object { "  $_" }
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
  # 上游文件里的**唯一**钩子：导入桥接 + 一行调用。
  # 这两处还在，说明自动保存仍然接在桥接上；它们丢了说明上游重构了那段代码。
  @{ file = 'src/ui/timeline/projectFileSession.ts'; pattern = "from '../../desktop/browserSaveBridge'"; why = '桥接导入' },
  @{ file = 'src/ui/timeline/projectFileSession.ts'; pattern = 'queueBrowserSave(snapshot.project)'; why = '自动保存钩子' },
  # 桥接模块自身（新文件，上游不碰）：关窗落盘与 preload 接线都在这里。
  @{ file = 'src/desktop/browserSaveBridge.ts'; pattern = 'flushBrowserSaveAndWait'; why = '关窗等待出口' },
  @{ file = 'src/desktop/browserSaveBridge.ts'; pattern = 'onFlushSaves'; why = 'preload 接线' },
  @{ file = 'src/desktop/browserSaveBridge.ts'; pattern = 'installBridge'; why = '模块级自注册' }
)
$missing = @()
foreach ($check in $checks) {
  if (-not (Test-Path $check.file)) { $missing += "$($check.file) 不存在"; continue }
  # 必须用 -SimpleMatch：`queueBrowserSave(snapshot.project)` 里的括号在正则里
  # 是分组，用它做 -Pattern 会永远匹配不上（实测：文本明明存在却报缺失）。
  $hit = Select-String -Path $check.file -Pattern $check.pattern -SimpleMatch -Quiet
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
