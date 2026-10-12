# GitHub Token 速查（发布 Release 用）

## 一句话

**PAT = Personal Access Token**，是给"程序"用的密码。GitHub 有两种：

|          | Classic（经典）                      | **Fine-grained（细粒度）** ← 用这个 |
| -------- | ------------------------------------ | ----------------------------------- |
| 前缀     | `ghp_`                               | `github_pat_`                       |
| 长度     | 正好 40 字符                         | 约 93 字符                          |
| 权限范围 | 粗：勾了 `repo` 就能动你**所有**仓库 | 细：**逐个仓库 + 逐项权限**         |
| 有效期   | 可选                                 | 可选，且**强制**设置                |
| 适用     | 老工具                               | GitHub 现在推荐                     |

本项目的发布脚本两种都能用，但**建议用 fine-grained** —— 万一泄露，
攻击者也只能动你授权的那个仓库、且只能读发布内容，不能碰你其它项目。

## 创建步骤（给 Endaxis 发布用）

1. 打开 <https://github.com/settings/personal-access-tokens/new>
   （或：右上头像 → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token）
2. **Token name**：随便写，例如 `endaxis-release`
3. **Expiration**：按习惯选（到期需重新创建，建议 90 天）
4. **Repository access** → 选 **Only select repositories** → 只勾 `xuan06zyx/Endaxis`
   > 不要选 "All repositories" —— 那样就失去细粒度的意义了
5. **Permissions** → 展开 **Repository permissions** → 找到 **Contents**
   → 改成 **Read and write**
   > 只需要这一项。发布 Release 就是"往仓库写内容"。
6. 点 **Generate token** → **立刻复制**（离开页面就再也看不到明文了）

## 放哪里

**A. 让 GitHub Actions 自动发版**（推荐，一次配置长期有效）

仓库 → Settings → Secrets and variables → **Actions** → New repository secret

- Name：**`GH_TOKEN`**（必须精确是这个，工作流里写死了这个名字）
- Secret：粘贴 token

**B. 本机手动发版**

```powershell
[Environment]::SetEnvironmentVariable('GH_TOKEN','github_pat_粘贴完整token','User')
```

## 验证 token 是否正确（不用等发布失败）

```powershell
$t = [Environment]::GetEnvironmentVariable('GH_TOKEN','User')
"长度: $($t.Length)  前缀: $($t.Substring(0,12))"
```

期望：长度约 93、前缀 `github_pat_`。

```powershell
# 真的调一次 API 确认身份与权限
$env:HTTPS_PROXY='http://127.0.0.1:7897'
$H = @{ Authorization = "Bearer $t"; 'User-Agent'='dsh' }
(Invoke-RestMethod https://api.github.com/user -Headers $H).login
(Invoke-RestMethod https://api.github.com/repos/xuan06zyx/Endaxis -Headers $H).permissions
```

期望：打印出 `xuan06zyx`，以及 `push=True`。

## 已经踩过的坑

**前缀叠了两层**：存进去的值是 `ghp_github_pat_…`（97 字符）。

症状很迷惑人：**git 操作正常、REST API 一律 401 Bad credentials** ——
因为 git 和 API 用的是不同端点，对凭据的容忍度不同。

记住：`ghp_` 和 `github_pat_` **只能有一个**。发布脚本现在会主动检测这种形态并报错，
不会再让你往"权限不够"的方向排查。

## 安全提醒

- Token 等于密码，**别贴进聊天、别提交进仓库**（工作流的 secret 是加密存储的，安全）
- 用完或不再需要时，到同页面点 **Delete** / **Revoke** 撤销
- 只想撤销单个仓库的访问：改该 token 的 Repository access 即可
