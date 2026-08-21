# ArxivFollowUp (AFU)

ArxivFollowUp 是一个本地优先的 arXiv 订阅与论文追踪阅读器。订阅感兴趣的 Category，AFU 会持续发现新论文和版本更新，并把阅读、归档、收藏和 AI 分析整合到一个轻量的研究工作台中。

## 主要功能

- 订阅、暂停和管理 arXiv Category
- 增量同步新论文与版本更新，按 arXiv ID 自动去重
- 记录初版时间、最新版本时间和观察到的版本历史
- 使用 Inbox、Archive、Read / Unread 和多收藏夹整理阅读进度
- 支持本地全文搜索、Category 层级筛选、状态筛选和批量操作
- 提供 1–7 天自动同步、手动同步和完整 JSON 备份
- 接入 OpenAI-compatible API，生成中文摘要翻译和一句话解释
- 在 Windows 系统托盘后台运行，与浏览器保持独立生命周期

## 快速开始

运行环境为 Node.js 24+；SQLite 已由 Node.js 内置。

```powershell
git clone git@github.com:Yuchen-Wang-CHN/ArxivFollowUp.git
Set-Location ArxivFollowUp
npm ci
npm start
```

访问 <http://127.0.0.1:43110>。

### Windows 托盘模式

双击 `start-afu.cmd` 即可在后台启动 AFU。启动器会打开默认浏览器，并在系统托盘显示常驻图标：

- 双击图标：打开 AFU
- **Open ArxivFollowUp**：打开 AFU
- **Exit ArxivFollowUp**：结束后台服务

`npm start` 适合前台开发运行；`start-afu.cmd` 适合日常使用。

## AI 分析

AFU 可以连接 OpenAI-compatible API，为论文生成：

- 中文摘要翻译
- 一句话中文解释
- 原文、译文或双语摘要视图

AI 功能支持关闭、自动处理和手动选择三种模式，并可在 Settings 中配置服务地址、模型和并发数。

PowerShell 启动示例：

```powershell
$env:AFU_AI_BASE_URL = 'http://127.0.0.1:8000/v1'
$env:AFU_AI_MODEL = 'Qwen/Qwen3.8-27B-FP8'
$env:AFU_AI_API_KEY = 'your-api-key'
npm start
```

## 配置

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `AFU_DATA_DIR` | `./data` | 数据库与备份目录 |
| `AFU_DATABASE_PATH` | `./data/afu.db` | 自定义数据库文件路径 |
| `PORT` | `43110` | 本地 HTTP 端口 |
| `AFU_AI_BASE_URL` | `http://127.0.0.1:8000/v1` | OpenAI-compatible API 地址 |
| `AFU_AI_MODEL` | `Qwen/Qwen3.8-27B-FP8` | AI 模型名称 |
| `AFU_AI_API_KEY` | 空 | 可选 Bearer Token |

Settings 中保存的 AI 配置会沿用到后续启动。旧版 `data/localrss.db` 也会被自动识别。

## 数据

AFU 将数据库和备份保存在本地：

```text
data/afu.db
data/backups/
```

应用服务监听 `127.0.0.1`，数据目录已排除在 Git 版本管理之外。Settings 提供完整 JSON 数据导出与恢复。

## 开发

运行完整检查：

```powershell
npm run check
```

项目使用 GitHub Actions 在 Node.js 24 上自动运行相同检查。

```text
public/       浏览器界面
scripts/      Windows 托盘与开发脚本
src/          HTTP 服务、数据库、同步与 AI 逻辑
test/         Node.js 测试
```

更多资料：

- [产品设计与状态规则](./DESIGN.md)
- [参与贡献](./CONTRIBUTING.md)
- [安全策略](./SECURITY.md)
- [Windows GitHub 与 SSH 指南](./docs/WINDOWS_GITHUB.md)

## License

[MIT](./LICENSE) © 2026 ArxivFollowUp contributors
