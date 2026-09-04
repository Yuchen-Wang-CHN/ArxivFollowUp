# ArxivFollowUp (AFU)

把 arXiv 新论文和版本更新收进本地，再从中挑出真正值得你关注的内容。

订阅 `cs.AI`、`cs.LG` 等 Category 后，AFU 会把同步到的论文完整保留在 **All Papers**，并根据你的 Collection 将高相关论文送进 **Focus Inbox**。读过或归档的论文如果发布了新版本，也会重新出现，不让重要更新悄悄溜走。

连接任意 OpenAI-compatible API，还可以直接生成一句话中文解读和摘要翻译，先快速判断是否值得细读。AI 完全可选，关闭后不影响订阅、同步、搜索和阅读管理。

![ArxivFollowUp Focus Inbox 界面](./docs/images/arxiv-follow-up-inbox.png)

## 三步开始

需要 Node.js 24 或更高版本。SQLite 已由 Node.js 内置，不需要另外安装数据库。

```bash
git clone https://github.com/Yuchen-Wang-CHN/ArxivFollowUp.git
cd ArxivFollowUp
npm ci
npm start
```

然后打开 <http://127.0.0.1:43110>，进入 **Subscriptions** 添加你想追踪的 arXiv Category。

### Windows

完成一次 `npm ci` 后，可以直接双击 `start-afu.cmd`。AFU 会在后台启动、打开默认浏览器，并常驻系统托盘；通过托盘菜单中的 **Exit ArxivFollowUp** 可以停止服务。

### macOS

完成一次 `npm ci` 后，双击 `start-afu.command` 即可启动，再次双击只会打开正在运行的 AFU。使用 `stop-afu.command` 停止后台服务。

也可以在终端运行：

```bash
./start-afu.command
./stop-afu.command
```

启动器支持 Homebrew、Volta、asdf、nvm 和 fnm 的常见 Node.js 安装位置。也可以通过 `AFU_NODE_PATH` 指定 Node.js 可执行文件；运行日志位于 `data/afu-macos.log`。

## AFU 能帮你做什么

### 用 AI 快速判断是否值得读

AFU 可以在论文列表中显示一句话中文解读，并在原文、中文翻译和左右双栏摘要之间切换，不必先打开每一篇论文。你可以让它自动处理进入 Focus 的新论文和版本更新，也可以只分析手动选中的论文。

### 先完整收下，再决定看什么

- 按 arXiv Category 持续发现新论文和更高版本
- 所有同步结果保留在 **All Papers**，不会因为相关度较低而消失
- 高相关论文、版本更新和你主动标记为未读的论文进入 **Focus Inbox**
- 按 arXiv ID 自动去重，并保存本地实际观察到的版本历史

### 用 Collection 告诉 AFU 你关心什么

把值得继续关注的论文放进不同 Collection。启用 Embedding 后，AFU 会根据这些论文的向量建立兴趣画像，为新论文预测最接近的类别，并用相关度筛选 Focus Inbox。

预测标签只用于辅助浏览，不会自动移动或归档论文。Archive 中的论文也不会参与兴趣分类。

### 把论文当作一条可处理的队列

- 使用 Read / Unread 记录阅读状态
- 用 Archive 收起不感兴趣的论文，同时保留元数据和 AI 内容
- 建立多个 Collection，并为 Collection 和 Archive 设置颜色
- 为每篇论文写 Markdown 笔记，实时预览并自动保存
- 搜索标题、作者、摘要、Category、arXiv ID 和本地笔记
- 使用状态、Category、更新时间等筛选条件和批量操作

一个简单的使用习惯是：先浏览 Focus，值得跟进的放进 Collection，处理完的归档；需要回查时，再到 All Papers 搜索完整结果。

## 可选：启用 AI

在 **Settings → LLM analysis** 中填写服务地址、模型和 API key，然后选择处理方式：

- **关闭**：不创建新任务，但继续显示已有结果
- **自动**：自动分析进入 Focus 的新论文和新版本
- **手动**：只分析你在 Focus 或 All Papers 中选中的论文

自动模式下，也可以在 All Papers 中临时分析某一篇论文。

<details>
<summary>通过环境变量提供 LLM 默认配置</summary>

```powershell
$env:AFU_AI_BASE_URL = 'http://127.0.0.1:8000/v1'
$env:AFU_AI_MODEL = 'Qwen/Qwen3.8-27B-FP8'
$env:AFU_AI_API_KEY = 'your-api-key'
npm start
```

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `AFU_AI_BASE_URL` | `http://127.0.0.1:8000/v1` | OpenAI-compatible API 地址 |
| `AFU_AI_MODEL` | `Qwen/Qwen3.8-27B-FP8` | 模型名称 |
| `AFU_AI_API_KEY` | 空 | 可选 Bearer Token |

Settings 中保存的配置会优先用于后续启动。

</details>

## 可选：启用 Embedding 与混合搜索

在 **Settings → Embedding & classification** 中配置独立的 Embedding 服务。默认配置适用于 vLLM 的 OpenAI-compatible `/v1/embeddings` 接口：

```text
Base URL  http://127.0.0.1:8001/v1
Model     Qwen/Qwen3-Embedding-0.6B
```

AFU 默认将相关度达到 `0.60` 的论文放入 Focus，分类门槛默认为 `0.55`。你可以在 Settings 中调整门槛和领先幅度；Collection 内容变化后，结果会自动更新。版本更新和你主动标记为未读的论文不受 Focus 门槛限制。

搜索会结合 SQLite FTS5 的关键词结果与 Dense Embedding。Embedding 关闭、Dense 权重设为零或服务临时不可用时，会自动回退到纯关键词搜索。

只有查询文本会在 Dense 搜索时发送给 Embedding 服务，本地笔记不会发送。

<details>
<summary>通过环境变量提供 Embedding 默认配置</summary>

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `AFU_EMBEDDING_BASE_URL` | `http://127.0.0.1:8001/v1` | Embedding API 地址 |
| `AFU_EMBEDDING_MODEL` | `Qwen/Qwen3-Embedding-0.6B` | Embedding 模型名称 |
| `AFU_EMBEDDING_API_KEY` | 空 | 可选 Bearer Token |

</details>

## 数据与隐私

订阅、论文元数据、阅读状态、Collection、笔记、AI 结果和 Embedding 都保存在本地 SQLite 中。AFU 不下载 PDF、不要求账户，服务默认只监听 `127.0.0.1`。

如果启用 LLM 或 Embedding，生成结果所需的论文标题和摘要会发送到你配置的 API；Dense 搜索还会发送查询文本。除此之外，本地笔记不会发送给这些服务。

在 Settings 中填写的 API key 会保存在本地 SQLite 的 secrets 表中，不会进入 JSON 备份；它并未存入操作系统钥匙串，请妥善保护数据目录。

数据库和备份默认位于：

```text
data/afu.db
data/backups/
```

可以在 Settings 中导出或恢复完整 JSON 备份。恢复前，AFU 会自动备份当前数据库。

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `AFU_DATA_DIR` | `./data` | 数据库与备份目录 |
| `AFU_DATABASE_PATH` | `./data/afu.db` | 自定义数据库文件路径 |
| `PORT` | `43110` | 本地 HTTP 端口 |

旧版 `data/localrss.db` 会被自动识别。

## 同步说明

AFU 从你添加订阅时开始，通过 arXiv RSS 发现之后出现的新论文和版本更新。自动同步间隔可以设为 1–7 天，也可以随时点击 **Sync now**。

Archive 会把论文移出 Focus 和 All Papers，但保留本地内容。选择“删除本地内容”后，相同版本不会被 RSS 再次加入；将来出现更高版本时，它仍会作为 **Updated** 回到 Focus。

## 开发

运行完整检查：

```bash
npm run check
```

项目使用 GitHub Actions 在 Node.js 24 上运行相同检查。

```text
public/       浏览器界面
scripts/      Windows 托盘、macOS 启动与辅助脚本
src/          HTTP 服务、数据库、同步、搜索与 AI 逻辑
test/         Node.js 测试
```

- [参与贡献](./CONTRIBUTING.md)
- [安全策略](./SECURITY.md)
- [Windows GitHub 与 SSH 指南](./docs/WINDOWS_GITHUB.md)

## License

[MIT](./LICENSE) © 2026 ArxivFollowUp contributors
