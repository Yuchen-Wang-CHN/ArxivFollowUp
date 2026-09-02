# ArxivFollowUp (AFU)

完整保存 arXiv 新论文和版本更新，再把与你兴趣最相关的内容送进一个本地 Focus Inbox。

ArxivFollowUp 是一款本地运行的 arXiv 论文追踪工具。订阅 `cs.AI`、`cs.LG` 等 Category 后，完整抓取结果会保留在 All Papers，Embedding 会把高相关论文送进 Focus Inbox；已经处理过的论文如果出现更高版本，也会重新进入 Focus，避免重要更新悄悄溜走。

连接任意 OpenAI-compatible API 后，AFU 还能为论文生成一句话中文解读和摘要翻译。订阅、论文元数据、阅读状态、收藏夹和 AI 结果均保存在本地 SQLite 中，不需要账户或云端数据库。

![ArxivFollowUp Inbox 界面](./docs/images/arxiv-follow-up-inbox.png)

## 核心功能

### 持续追踪论文及版本

- 按 arXiv Category 订阅研究方向
- 增量发现新论文和更高版本，并按 arXiv ID 自动去重
- 保存本地实际观察到的版本历史
- 已归档论文出现新版本时重新进入 Focus Inbox

### 用 AI 快速判断是否值得读

- 在论文列表中直接显示一句话中文解读
- 支持原文、中文翻译和左右双栏摘要
- 可自动处理新论文，也可只分析手动选中的论文
- 支持自定义 OpenAI-compatible API、模型和并发数

### 用 Embedding 构建 Focus Inbox

- LLM 分析与 Embedding 可分别配置 API、模型和密钥
- 根据 Collection 中的论文学习你的兴趣分类
- 通过可调相关度门槛，把高相关论文送进 Focus Inbox
- 在论文卡片中显示预测类别，帮助你理解入选原因
- 可为 Collection 和 Archive 设置颜色；预测标签不会改变论文所在位置

AI 完全可选。关闭后，订阅、同步和阅读管理仍可正常使用。

### 把论文当作待处理队列

- 使用 Read / Unread 标记阅读状态
- 通过 Archive 表示不感兴趣，同时保留论文与 AI 内容供以后查看
- 可从 Archive 中删除不再需要的本地内容
- 使用多个 Collection 保存值得继续关注的论文
- 为每篇论文编写 Markdown 笔记，实时预览并自动保存
- 支持搜索论文元数据和笔记、Category 与状态筛选、批量处理，以及每页 100 篇的分页

### 数据留在本地

- 使用本地 SQLite 保存数据，无需登录
- 服务默认只监听 `127.0.0.1`
- 支持完整 JSON 备份与恢复
- 支持 Windows 托盘后台运行和 macOS 一键启动

## 使用方式

1. 在 **Subscriptions** 中添加想追踪的 arXiv Category。
2. AFU 同步当前 RSS，将完整结果保留在 **All Papers**，并把高相关论文送入 **Focus Inbox**。
3. 优先浏览 Focus 中的标题和 AI 一句话解读，必要时到 All Papers 搜索完整结果。
4. 将论文标为已读、加入 Collection，或在处理完成后 Archive。
5. 后续同步发现更高版本时，论文会再次出现在 Focus Inbox 并标记为 Updated。

## 快速开始

需要 Node.js 24 或更高版本；SQLite 已由 Node.js 内置。

```bash
git clone https://github.com/Yuchen-Wang-CHN/ArxivFollowUp.git
cd ArxivFollowUp
npm ci
npm start
```

打开 <http://127.0.0.1:43110>。

### Windows

完成一次 `npm ci` 后，可以双击 `start-afu.cmd`。AFU 会在后台启动、打开默认浏览器，并常驻系统托盘。双击托盘图标可再次打开页面，通过托盘菜单中的 **Exit ArxivFollowUp** 可停止服务。

### macOS

完成一次 `npm ci` 后，可以在 Finder 中双击 `start-afu.command`。再次双击只会打开已经运行的 AFU，不会重复启动服务。双击 `stop-afu.command` 可停止后台服务。

也可以在终端中运行：

```bash
./start-afu.command
./stop-afu.command
```

启动器支持 Homebrew、Volta、asdf、nvm 和 fnm 的常见 Node.js 安装位置，也可以通过 `AFU_NODE_PATH` 指定 Node.js 可执行文件。运行日志保存在 `data/afu-macos.log`。

## AI 配置

在 **Settings → LLM analysis** 中填写服务地址、模型和独立 API key，然后选择处理模式：

例如，可以使用 Qwen3.8 27B 等支持 OpenAI-compatible API 的模型。

- **关闭**：不创建新任务，但继续显示已有结果
- **自动**：Embedding 分类完成后，只自动分析进入 Focus 的新论文和新版本
- **手动**：只分析在 Focus 或 All Papers 中勾选并提交的论文

也可以在启动前通过环境变量提供默认配置：

```powershell
$env:AFU_AI_BASE_URL = 'http://127.0.0.1:8000/v1'
$env:AFU_AI_MODEL = 'Qwen/Qwen3.8-27B-FP8'
$env:AFU_AI_API_KEY = 'your-api-key'
npm start
```

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `AFU_AI_BASE_URL` | `http://127.0.0.1:8000/v1` | OpenAI-compatible API 地址 |
| `AFU_AI_MODEL` | `Qwen/Qwen3.8-27B-FP8` | AI 模型名称 |
| `AFU_AI_API_KEY` | 空 | 可选 Bearer Token |

Settings 中保存的配置优先用于后续启动。

LLM API key 可以保存在 Settings 中，也可以通过 `AFU_AI_API_KEY` 提供。保存在 Settings 中的密钥不会写入 JSON 备份。

## Embedding 与默认分类

在 **Settings → Embedding & classification** 中配置独立的 Embedding 服务。默认配置面向 vLLM 的 OpenAI-compatible `/v1/embeddings` 接口：

```text
Base URL  http://127.0.0.1:8001/v1
Model     Qwen/Qwen3-Embedding-0.6B
```

启用后，AFU 会为本地论文生成 Embedding，并根据各个 Collection 中的论文建立兴趣分类。预测结果足够明确时，论文卡片会显示对应的彩色标签。你可以在 Settings 中分别调整分类门槛、领先幅度（Winning margin）和 Focus 最低相关度；Collection 内容变化后，分类会自动更新。

Focus Inbox 默认最低相关度为 `0.60`，分类门槛默认为 `0.55`；Focus 门槛不能低于分类门槛。版本更新和你主动标记为未读的论文不受门槛限制；未进入 Focus 的论文不会丢失，仍可在 All Papers 中搜索和处理。

Archive 中的论文不会参与分类。预测标签仅用于辅助浏览，不会自动移动或归档论文。

## 混合自然语言搜索

论文列表顶部的搜索框使用 SQLite FTS5 BM25 与 Dense Embedding 进行混合检索。BM25 覆盖标题、作者、摘要、分类、arXiv ID 和本地笔记；Dense 检索只发送查询文本，并与现有的标题加摘要向量比较，本地笔记不会发送给 Embedding 服务。

在 **Settings → Hybrid search** 中可以调整 Dense 权重，BM25 权重会自动取剩余比例。两路结果使用加权 Reciprocal Rank Fusion 合并。Embedding 关闭、Dense 权重设为零或服务临时不可用时，搜索会自动使用 100% BM25，并在结果上方显示当前实际搜索模式。

搜索由 Enter 或 **Search** 按钮提交，以避免输入过程中反复调用 Embedding API；清空搜索框会恢复普通论文列表。

Embedding 服务也可以通过环境变量提供默认值：

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `AFU_EMBEDDING_BASE_URL` | `http://127.0.0.1:8001/v1` | Embedding API 地址 |
| `AFU_EMBEDDING_MODEL` | `Qwen/Qwen3-Embedding-0.6B` | Embedding 模型名称 |
| `AFU_EMBEDDING_API_KEY` | 空 | 可选 Bearer Token |

## 同步与数据

AFU 通过 arXiv RSS 持续发现新论文和版本更新，从你添加订阅时开始追踪。自动同步间隔可设置为 1–7 天，也可以随时点击 **Sync now**。

Archive 会将论文移出 Focus 和 All Papers，但保留论文信息、版本历史和 AI 结果。若确定不再需要，可以在 Archive 中选择“删除本地内容”。以后出现更高版本时，这篇论文仍会作为 **Updated** 重新进入 Focus。

AFU 不下载 PDF；论文信息、阅读状态、AI 结果和 Embedding 都保存在本地 SQLite 中。

数据库和备份默认保存在：

```text
data/afu.db
data/backups/
```

可以通过以下环境变量调整本地运行位置：

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `AFU_DATA_DIR` | `./data` | 数据库与备份目录 |
| `AFU_DATABASE_PATH` | `./data/afu.db` | 自定义数据库文件路径 |
| `PORT` | `43110` | 本地 HTTP 端口 |

旧版 `data/localrss.db` 会被自动识别。你可以在 Settings 中导出或恢复 JSON 备份；恢复前，AFU 会自动备份当前数据库。

## 开发

运行完整检查：

```bash
npm run check
```

项目使用 GitHub Actions 在 Node.js 24 上运行相同检查。

```text
public/       浏览器界面
scripts/      Windows 托盘、macOS 启动与开发脚本
src/          HTTP 服务、数据库、同步与 AI 逻辑
test/         Node.js 测试
```

相关资料：

- [参与贡献](./CONTRIBUTING.md)
- [安全策略](./SECURITY.md)
- [Windows GitHub 与 SSH 指南](./docs/WINDOWS_GITHUB.md)

## License

[MIT](./LICENSE) © 2026 ArxivFollowUp contributors
