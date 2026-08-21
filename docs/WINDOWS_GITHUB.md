# Windows 上用 SSH 管理 ArxivFollowUp 与 GitHub

本文使用 PowerShell、Git 和 SSH。SSH 私钥只保存在你的电脑上，GitHub 保存公钥；之后执行 `pull` 和 `push` 时无需输入 GitHub 密码或 Personal Access Token。

## 1. 一次性准备

项目要求 Node.js 24+，版本管理需要 Git。当前 Windows 通常已提供 OpenSSH Client；可以用以下命令检查：

```powershell
git --version
ssh -V
node --version
```

缺少 Git 时可以安装：

```powershell
winget install --id Git.Git -e
```

安装后重新打开 PowerShell，设置提交身份：

```powershell
git config --global user.name "你的 GitHub 显示名"
git config --global user.email "你的 GitHub noreply 邮箱"
git config --global init.defaultBranch main
git config --global core.autocrlf true
```

`noreply` 邮箱可在 GitHub 的 **Settings → Emails** 中查看，它能避免把私人邮箱写入公开提交历史。

## 2. 配置 GitHub SSH

先检查是否已有密钥：

```powershell
Get-ChildItem "$env:USERPROFILE\.ssh" -ErrorAction SilentlyContinue
```

如果没有准备用于 GitHub 的密钥，创建一把 ED25519 密钥。建议设置口令：

```powershell
ssh-keygen -t ed25519 -C "你的 GitHub noreply 邮箱"
```

直接回车可使用默认路径 `%USERPROFILE%\.ssh\id_ed25519`。绝对不要上传或分享没有 `.pub` 后缀的私钥。

在“以管理员身份运行”的 PowerShell 中启动 Windows SSH Agent：

```powershell
Get-Service -Name ssh-agent | Set-Service -StartupType Automatic
Start-Service ssh-agent
```

回到普通 PowerShell，将私钥加入 Agent，并让 Git for Windows 使用同一个 Windows OpenSSH 客户端：

```powershell
ssh-add "$env:USERPROFILE\.ssh\id_ed25519"
git config --global core.sshCommand "C:/Windows/System32/OpenSSH/ssh.exe"
```

复制公钥：

```powershell
Get-Content "$env:USERPROFILE\.ssh\id_ed25519.pub" | Set-Clipboard
```

进入 GitHub **Settings → SSH and GPG keys → New SSH key**，选择 Authentication Key 并粘贴。然后测试：

```powershell
ssh -T git@github.com
```

首次连接时，先核对终端显示的 GitHub 主机指纹，再输入 `yes`。成功信息应包含你的 GitHub 用户名；该测试命令最终返回状态码 1 是 GitHub 的正常行为。

## 3. 首次上传 ArxivFollowUp

在 GitHub 网站创建一个名为 `ArxivFollowUp` 的空仓库。不要勾选自动创建 README、`.gitignore` 或许可证，因为本地已经有这些文件。

先检查即将提交的内容：

```powershell
Set-Location "C:\path\to\ArxivFollowUp"
git status
git add .
git status
git diff --cached --stat
git diff --cached
```

确认没有 `data/`、`.runtime/`、`node_modules/`、数据库、备份或密钥后提交：

```powershell
git commit -m "Initial release"
git remote add origin git@github.com:你的用户名/ArxivFollowUp.git
git remote -v
git push -u origin main
```

如果误加了 HTTPS 远程地址，可以切换成 SSH：

```powershell
git remote set-url origin git@github.com:你的用户名/ArxivFollowUp.git
```

## 4. 日常开发流程

每项改动使用独立分支，完成后通过 Pull Request 合并到 `main`：

```powershell
git switch main
git pull --ff-only
git switch -c feature/简短功能名

# 修改并测试
npm run check
git status
git add 文件名
git diff --cached
git commit -m "feat: 简要说明改动"
git push -u origin feature/简短功能名
```

到 GitHub 网页创建 Pull Request，等待 CI 通过后合并。合并完成后清理本地分支：

```powershell
git switch main
git pull --ff-only
git branch -d feature/简短功能名
```

常见提交前缀：`feat`（功能）、`fix`（修复）、`docs`（文档）、`test`（测试）、`chore`（维护）。

## 5. 常用检查与恢复

```powershell
git status                  # 当前修改和分支
git diff                    # 尚未暂存的改动
git diff --cached           # 准备提交的改动
git log --oneline --graph --decorate -20
git remote -v               # 应显示 git@github.com:... SSH 地址
git restore --staged 文件名 # 取消暂存，不删除本地修改
git restore 文件名          # 丢弃未提交修改；执行前务必确认
```

已经推送的历史不要随意使用 `reset --hard` 或强制推送改写。需要撤销公开提交时，优先使用：

```powershell
git revert 提交哈希
git push
```

## 6. Synology Drive 特别提醒

当前工作区位于 Synology Drive 同步目录。不要让多台电脑同时同步并修改同一个 `.git` 目录，这可能造成 Git 元数据冲突。更稳妥的方式是每台电脑从 GitHub 分别 `git clone` 到各自本地开发目录，通过 `pull` 和 `push` 同步代码。AFU 的 `data/` 可以单独备份，但不要提交到 GitHub。

## 7. 发布前清单

- `npm run check` 全部通过。
- `npm audit --omit=dev` 没有未处理的高风险漏洞。
- `git status --ignored` 确认本地数据、运行时与 SSH 私钥没有进入仓库。
- 全仓搜索 API Key、Token、密码、内网地址和个人信息。
- README 的安装、启动和配置说明与代码一致。
- `git remote -v` 使用 `git@github.com:...` SSH 地址。
- GitHub Actions 首次运行成功。
- 仓库设置中启用 2FA、Dependabot alerts 和 Private vulnerability reporting。
