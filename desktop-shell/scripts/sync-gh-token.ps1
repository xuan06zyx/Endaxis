# 把新的 GitHub PAT 写入 User 级环境变量 GH_TOKEN，并先验证它真的能用。
#
# 为什么需要它：仓库 Secret 是只写的，任何人（包括 GitHub 网页）都读不回原文，
# 所以本机环境变量没法「自动同步」，只能由你输入一次。
#
# 用法（在本文件所在目录）：
#   pwsh -File sync-gh-token.ps1
#
# 令牌通过 Read-Host -AsSecureString 输入，不回显、不进命令行历史。
# 脚本会先打一次 API 验证，通过后才写入环境变量，避免又存进去一个失效令牌。

$ErrorActionPreference = 'Stop'

Write-Host '粘贴新的 GH_TOKEN（输入不回显，右键粘贴即可）' -ForegroundColor Cyan
$secure = Read-Host -AsSecureString

# SecureString → 明文（只在本进程内存里，不落盘）
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}

$token = $token.Trim()

# 踩过的坑：把 classic 前缀和 fine-grained 拼在一起（ghp_github_pat_…），
# 结果 git 能用、REST API 一律 401。这里直接纠正，省得再排查一遍。
if ($token -like 'ghp_github_pat_*') {
  Write-Host '检测到多余的 ghp_ 前缀，已自动去掉' -ForegroundColor Yellow
  $token = $token.Substring(4)
}

if ($token -notmatch '^(github_pat_|ghp_|gho_|ghu_|ghs_|ghr_)') {
  throw '这看起来不是 GitHub 令牌（应以 github_pat_ / ghp_ 等开头）'
}

$headers = @{
  Authorization = "Bearer $token"
  'User-Agent'  = 'dsh-sync-gh-token'
  Accept        = 'application/vnd.github+json'
}

Write-Host '验证令牌…'
try {
  $me = Invoke-RestMethod -Uri 'https://api.github.com/user' -Headers $headers -Method Get -TimeoutSec 30
} catch {
  throw "令牌无效：$($_.Exception.Message)"
}

try {
  Invoke-RestMethod -Uri 'https://api.github.com/repos/xuan06zyx/Endaxis' -Headers $headers -Method Get -TimeoutSec 30 | Out-Null
  $repoAccess = '可访问 xuan06zyx/Endaxis'
} catch {
  $repoAccess = '但访问 xuan06zyx/Endaxis 失败（可能缺少该仓库授权）'
}

# 写入 User 级（新开的终端都会带上），并同步当前进程，方便立刻继续用。
[Environment]::SetEnvironmentVariable('GH_TOKEN', $token, 'User')
$env:GH_TOKEN = $token

Write-Host ''
Write-Host '完成：' -ForegroundColor Green
Write-Host ("  登录身份 : {0}" -f $me.login)
Write-Host ("  仓库权限 : {0}" -f $repoAccess)
Write-Host ("  已写入   : User 级环境变量 GH_TOKEN（长度 {0}，前缀 {1}…）" -f $token.Length, $token.Substring(0, 12))
Write-Host '  提示     : 已打开的其它终端需要重启才会读到新值。'
