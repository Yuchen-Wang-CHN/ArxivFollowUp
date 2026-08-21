# ArxivFollowUp (AFU)

ArxivFollowUp（简称 AFU）是一个本地优先的 arXiv Category 订阅与论文持续追踪阅读器。它用 RSS 发现论文和版本更新，把阅读状态、收藏夹、AI 分析与备份都保存在本机。

> 当前版本：`0.1.0`。项目仍处于早期阶段，升级前建议先在 Settings 中导出 JSON 备份。

## 功能

- 订阅、暂停、恢复和取消订阅 arXiv Category
- 首次与增量 RSS 同步，按无版本号 arXiv ID 全局去重
- 追踪初版时间、最新版本时间和观察到的版本历史
- Inbox、Read / Unread、Archive、收藏夹与批量操作
- 本地全文搜索、多 Category 层级筛选和时间/状态筛选
- 1–7 天自动同步、手动同步及失败反馈
- 完整 JSON 备份与安全恢复
- 通过 OpenAI-compatible API 生成中文摘要翻译和一句话解释
- Windows 系统托盘后台常驻；浏览器关闭后服务仍可继续运行

完整产品语义与状态规则见 [DESIGN.md](./DESIGN.md)。

## 快速开始

需要 Node.js 24 或更高版本。项目使用 Node 自带的 `node:sqlite`，无需另装 SQLite。

```powershell
git clone git@github.com:你的用户名/ArxivFollowUp.git
Set-Location ArxivFollowUp
npm ci
npm start
```

打开 <http://127.0.0.1:43110>。

如果你直接下载了源码压缩包，可跳过 `git clone`，在解压目录中执行 `npm ci` 和 `npm start`。

### Windows 托盘启动

双击 `start-afu.cmd`。启动器会隐藏运行 Backend、打开默认浏览器，并在系统托盘保留 ArxivFollowUp 图标。双击托盘图标可重新打开网页；选择 **Exit ArxivFollowUp** 才会退出服务。重复运行启动器不会创建第二个 Backend。

启动器优先使用系统 Node.js；如果工作区存在开发用便携运行时，也会自动使用它。Settings 中可以关闭“Windows 启动时自动打开浏览器”。`npm start` 始终是前台开发启动方式，不创建托盘图标。

## 配置

所有配置均为可选。PowerShell 示例：

```powershell
$env:AFU_DATA_DIR = 'D:\ArxivFollowUpData'
$env:PORT = '43110'
$env:AFU_AI_BASE_URL = 'http://127.0.0.1:8000/v1'
$env:AFU_AI_MODEL = 'Qwen/Qwen3.8-27B-FP8'
$env:AFU_AI_API_KEY = 'your-api-key'
npm start
```

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `AFU_DATA_DIR` | `./data` | 数据库与备份目录 |
| `AFU_DATABASE_PATH` | `./data/afu.db` | 覆盖数据库文件路径 |
| `PORT` | `43110` | 本地 HTTP 端口 |
| `AFU_AI_BASE_URL` | `http://127.0.0.1:8000/v1` | OpenAI-compatible API 地址 |
| `AFU_AI_MODEL` | `Qwen/Qwen3.8-27B-FP8` | AI 模型名称 |
| `AFU_AI_API_KEY` | 空 | 可选 Bearer Token |

AI 默认关闭。可在 Settings 中修改服务地址、模型、处理模式、并发数和摘要默认显示方式。自动模式会补齐 Inbox 中尚未分析的当前版本，并处理后续新论文和新版本。

环境变量只影响新数据库的 AI 默认值；已有数据库继续使用 Settings 中保存的配置。

## 数据与安全

新安装的默认数据库位于 `data/afu.db`，备份位于 `data/backups/`。从旧名称升级时，如果目录中只有 `data/localrss.db`，AFU 会自动继续使用它，无需迁移。这些路径已被 Git 忽略，不应上传到 GitHub。备份可能包含论文阅读历史、收藏夹和 AI 设置，请按私人数据管理。

Backend 只监听 `127.0.0.1`，不会直接暴露给局域网。项目没有远程访问身份认证，请勿通过端口转发或反向代理直接暴露到公网。API Key 只应通过环境变量提供，不要写入代码或提交记录。

## 测试

```powershell
npm run check
```

单独运行测试：

```powershell
npm test
```

每次推送到 `main` 或创建 Pull Request 时，GitHub Actions 会在 Node.js 24 上自动执行相同检查。

## 项目结构

```text
public/       浏览器界面
scripts/      Windows 托盘启动器与开发脚本
src/          HTTP 服务、数据库、同步与 AI 逻辑
test/         Node.js 测试
data/         本地数据库和备份（不进入 Git）
```

## 参与和维护

提交改动前请阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)，安全问题请按 [SECURITY.md](./SECURITY.md) 私下报告。Windows 上的首次上传、认证、分支和日常同步流程见 [Windows GitHub 管理指南](./docs/WINDOWS_GITHUB.md)。

## 许可证

本项目采用 [MIT License](./LICENSE)。你可以使用、复制、修改、分发和商用，但必须保留原版权与许可证声明。软件按“原样”提供，不附带任何担保。
