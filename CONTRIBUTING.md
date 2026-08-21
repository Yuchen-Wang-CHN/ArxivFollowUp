# 参与贡献

感谢你愿意改进 ArxivFollowUp（AFU）。提交改动前，请先搜索现有 Issue，避免重复工作；较大的功能建议先开 Issue 讨论范围和交互。

## 本地开发

需要 Node.js 24 或更高版本。

```powershell
npm ci
npm run dev
```

提交前运行完整检查：

```powershell
npm run check
```

## 提交 Pull Request

1. 从 `main` 创建短期功能分支，例如 `feature/export-opml` 或 `fix/sync-timeout`。
2. 每个 Pull Request 聚焦一个问题，并说明原因、行为变化和验证方式。
3. UI 改动请附截图；数据模型改动请说明迁移和回滚影响。
4. 不要提交 `data/`、数据库、备份、API Key、个人阅读记录或便携 Node 运行时。
5. 确保 CI 通过后再请求合并。

提交贡献即表示你有权提供相关内容，并同意按项目的 [MIT License](./LICENSE) 发布该贡献。
