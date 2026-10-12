# 用一个干净的 Draft Release 承载全部资产，然后发布。
#
# 为什么不用 electron-builder 的 --publish：它会并发上传资产，偶发地创建出
# **两个同 tag 的 Draft Release**（实测遇到过：一个拿到 exe/latest.yml，
# 另一个拿到 .blockmap）。Draft 客户端看不见，还得人工合并。
# 这里手动走一遍，结果确定、可校验。
#
# 用法：GH_TOKEN 已设置（User 级或进程级），在 desktop-shell 目录下运行：
#   pwsh -File scripts/publish-release.ps1 -Version 1.0.1

param(
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$Owner = 'xuan06zyx',
  [string]$Repo = 'Endaxis',
  [string]$ReleaseDirectory = (Join-Path $PSScriptRoot '..' 'release'),
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

# 进程级优先（CI 里就是注入到进程环境），其次才是本机持久化的 User 级。
$token = $env:GH_TOKEN
if (-not $token) { $token = [Environment]::GetEnvironmentVariable('GH_TOKEN', 'User') }
if (-not $token) { throw '未找到 GH_TOKEN（进程级环境变量或 User 级）' }
if ($token.StartsWith('ghp_github_pat_')) {
  # 实测踩过的坑：把 classic 前缀和 fine-grained token 粘在一起，
  # 结果就是 git 操作能用、REST API 一律 401，很难往"前缀多了 4 个字符"上想。
  throw 'GH_TOKEN 有多余的 ghp_ 前缀（形如 ghp_github_pat_…），请只保留 github_pat_ 起的部分'
}

$headers = @{
  Authorization          = "Bearer $token"
  Accept                 = 'application/vnd.github+json'
  'User-Agent'           = 'endaxis-release-script'
  'X-GitHub-Api-Version' = '2022-11-28'
}
$api = "https://api.github.com/repos/$Owner/$Repo"

# 需要上传的三个资产：缺 latest.yml 客户端就发现不了更新，
# 缺 .blockmap 就没有增量下载（只能整包下），缺 exe 自然什么都不用说。
$assets = @(
  "Endaxis-Setup-$Version-x64.exe",
  "Endaxis-Setup-$Version-x64.exe.blockmap",
  'latest.yml'
)
foreach ($name in $assets) {
  $path = Join-Path $ReleaseDirectory $name
  if (-not (Test-Path $path)) { throw "缺少资产文件：$path" }
  Write-Host ("  {0,-42} {1,8:N2} MB" -f $name, ((Get-Item $path).Length / 1MB))
}

if ($DryRun) { Write-Host '[dry-run] 不再继续'; exit 0 }

Write-Host "`n=== 1. 清理同名 tag 的既有 Release（含 Draft）==="
$existing = Invoke-RestMethod -Uri "$api/releases?per_page=100" -Headers $headers -Method Get
foreach ($release in ($existing | Where-Object { $_.tag_name -eq "v$Version" })) {
  Write-Host "  删除 release id=$($release.id)（draft=$($release.draft)，资产 $($release.assets.Count) 个）"
  Invoke-RestMethod -Uri "$api/releases/$($release.id)" -Headers $headers -Method Delete | Out-Null
}

Write-Host "`n=== 2. 建一个干净的 Draft Release ==="
$body = @{
  tag_name         = "v$Version"
  target_commitish = 'refactor/v3'
  name             = $Version
  body             = @"
桌面版本 $Version。

包含本地版桌面壳（Electron）与该版本的上游前端代码。
已安装旧版本的客户端会在下次启动时收到更新提示。
"@
  draft            = $true
  prerelease       = $false
} | ConvertTo-Json

$release = Invoke-RestMethod -Uri "$api/releases" -Headers $headers -Method Post -Body $body -ContentType 'application/json'
Write-Host "  已创建 id=$($release.id) tag=$($release.tag_name)"

Write-Host "`n=== 3. 上传资产（逐个，串行）==="
# 注意必须带 scheme：上传走的是独立主机 uploads.github.com
$uploadBase = "https://uploads.github.com/repos/$Owner/$Repo/releases/$($release.id)/assets"
Write-Host "  上传端点: $uploadBase"
foreach ($name in $assets) {
  $path = Join-Path $ReleaseDirectory $name
  $encoded = [System.Uri]::EscapeDataString($name)
  $uri = $uploadBase + '?name=' + $encoded
  $sizeMb = [math]::Round((Get-Item $path).Length / 1MB, 2)
  Write-Host "  上传 $name（$sizeMb MB）…"
  Write-Host "    URI: $uri"
  if (-not $uri.StartsWith('https://uploads.github.com/')) {
    throw "上传 URI 构造错误：$uri"
  }
  $result = Invoke-RestMethod -Uri $uri -Headers $headers -Method Post -InFile $path -ContentType 'application/octet-stream' -TimeoutSec 1800
  Write-Host "    ✓ 完成，远端大小 $([math]::Round($result.size / 1MB, 2)) MB"
}

Write-Host "`n=== 4. 发布（Draft → Published）==="
$publishBody = @{ draft = $false } | ConvertTo-Json
$published = Invoke-RestMethod -Uri "$api/releases/$($release.id)" -Headers $headers -Method Patch -Body $publishBody -ContentType 'application/json'
Write-Host "  draft=$($published.draft)  tag=$($published.tag_name)"
Write-Host "  页面: $($published.html_url)"

Write-Host "`n=== 5. 校验 ==="
$check = Invoke-RestMethod -Uri "$api/releases/tags/v$Version" -Headers $headers -Method Get
$names = $check.assets | ForEach-Object { $_.name }
$missing = @()
foreach ($name in $assets) {
  if ($names -contains $name) { Write-Host "  ✓ $name" } else { Write-Host "  ✗ 缺失 $name"; $missing += $name }
}
if ($check.draft) { throw 'Release 仍是 Draft，客户端看不到' }
if ($missing.Count -gt 0) { throw "缺少资产：$($missing -join ', ')" }
Write-Host "`n发布完成：客户端下次启动约 8 秒后即可检查到 $Version。"
