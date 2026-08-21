# ArxivFollowUp (AFU) — V1 Design Document

## 1. 产品定义

### 1.1 长期方向

产品长期目标是成为一个个人研究情报系统：

> 自动追踪研究领域的新论文，并逐步加入筛选、排序、摘要和推荐能力。

### 1.2 V1 定位

V1 是一个本地运行、面向 arXiv 的论文订阅与追踪阅读器。

核心闭环：

> 订阅分类 → RSS 获取论文 → Inbox → 阅读/筛选 → 收藏或归档 → 持续追踪版本更新

V1 不是：

- 通用 RSS 阅读器
- arXiv 搜索客户端
- arXiv 本地镜像
- PDF 管理工具
- AI 推荐系统
- 云端多用户服务

---

## 2. 核心设计原则

### 2.1 Tracking First

系统只回答：

> 从我开始订阅以后，这些研究方向发生了什么变化？

V1 使用 arXiv RSS 作为论文发现来源，不补抓 RSS 覆盖范围之外的历史论文。对于 RSS 已发现的论文，可以使用 arXiv Metadata API 补充初版时间和最新版本时间；该接口不得用于发现或补抓论文。

系统只保证记录本地实际观察到的论文和版本，不声称拥有 arXiv 的完整历史或全局最新状态。

### 2.2 Local First

V1 为单用户、本地运行，数据保存在本地 SQLite 中。

不需要登录、用户账户、云数据库或云同步。数据结构保留稳定 ID、时间戳和 schema version，避免阻碍未来同步能力。

### 2.3 User-controlled State

系统不得擅自替用户处理论文。

> 已读不等于已处理。只有用户明确归档，论文才离开 Inbox。

### 2.4 Idempotent Sync

同一份 RSS 内容无论同步多少次，结果都必须相同：

- 不重复创建 Paper
- 不重复创建同一版本
- 不重复进入 Inbox
- 不重复刷新 Inbox 活动时间
- 不重复计入同步结果

---

## 3. 系统结构

采用：

> Local Web App + Local Backend + SQLite

Local Backend 负责：

- RSS 获取与解析
- 数据标准化和去重
- 版本判断
- 定时同步
- 本地搜索
- 备份与恢复

Backend 默认只监听本机回环地址，不对局域网或公网开放。

未来封装桌面应用时，应尽可能复用 Backend 和数据库核心。

---

## 4. Subscription — 订阅

### 4.1 订阅单位

V1 只允许订阅具体 arXiv Category，例如：

- `cs.LG`
- `cs.AI`
- `cs.CL`
- `stat.ML`

不支持关键词、作者、搜索表达式、AI Topic 或整个大类订阅。

### 4.2 分类目录

订阅界面提供：

- 大类分组展示
- Category Code
- Category 名称
- 搜索
- 多选添加

大类仅用于组织 UI，不属于可订阅对象。

分类目录首次需要时获取并缓存；网络失败时继续使用旧缓存。应用可内置一份基础目录，远程刷新失败不得阻止用户使用已有目录。

---

## 5. RSS 同步模型

### 5.1 数据能力边界

RSS 是最新公告追踪源，不是完整历史数据库。

V1 保存：

- arXiv ID（去掉版本号后的稳定 ID）
- RSS 中出现的所有 Categories
- 本地观察到的版本
- 每个观察到的版本对应的 RSS 元数据
- 该论文通过哪些 Subscription 被发现
- 公告时间和本地首次发现时间
- Metadata API 提供的初版时间和最新版本时间（补充字段）

V1 不保存或推断 Primary Category。RSS `pubDate` 保存为公告时间；它不是版本提交时间。论文卡片优先显示 Metadata API 的 `updated`，尚未补充时明确显示为 Announcement time。

如果首次发现一篇论文时 RSS 已经显示 v3，系统只保存观察到的 v3，不虚构或补齐 v1、v2。

界面中的“最新版本”均指“本地观察到的最新版本”。

### 5.2 首次订阅

添加 Category 后：

1. 获取该 Category 当前 RSS。
2. 解析当前可见项目。
3. 按无版本号 arXiv ID 全局去重。
4. 写入本地数据库。
5. 只有本地不存在的 Paper 才作为新增论文进入 Inbox。

如果 Paper 已通过其他 Subscription 存在：

- 只新增 Matched Subscription 关系；
- 相同或更旧版本不改变阅读和归档状态；
- 更高版本按版本更新规则处理。

### 5.3 新增、更新和重复的判断

以无版本号 arXiv ID 判断是否为同一 Paper，以版本号判断是否出现新版本。

| 本地状态 | RSS 项目 | 处理结果 |
|---|---|---|
| 不存在该 Paper | 任意版本 | 新增 Paper，保存当前版本，进入 Inbox，标记 Unread |
| 已存在，RSS 版本更高 | 新版本 | 保存新版本，按更新规则处理 |
| 已存在，RSS 版本相同 | 重复内容 | 只补充 Categories 和 Matched Subscription，不重新入箱 |
| 已存在，RSS 版本更低 | 乱序或旧内容 | 不覆盖本地最新版本，只补充可安全合并的来源信息 |

arXiv RSS 的 announce type 可作为原始元数据保存和展示，但不参与新增/更新的核心判断。

### 5.4 同步频率

自动同步间隔只支持按天设置：

- 最短 1 天
- 最长 7 天
- 默认 1 天
- 用户选择 1–7 的整数

所有 Active Subscription 使用同一个全局间隔。

多个 RSS 请求按顺序执行，相邻请求至少间隔 3 秒。支持时使用 `ETag` 和 `Last-Modified`，避免重复下载未变化内容。

### 5.5 应用重新打开

应用显示距离上次成功同步的时间。如果已达到自动同步间隔，提示用户：

- Sync now
- Not now

如果应用关闭时间超过同步间隔，需要提示：

> RSS 当前内容可能无法覆盖应用关闭期间的全部论文。

系统不尝试使用其他数据源补齐。

### 5.6 手动刷新

用户可随时手动 Refresh。手动刷新仍需遵守请求限速，并与自动同步使用完全相同的去重和事务逻辑。

---

## 6. Subscription 状态

用户界面显示三种状态：

- Active：订阅启用，最近一次同步没有失败
- Paused：用户主动暂停
- Error：订阅仍然启用，但最近一次同步失败

内部将“是否启用”和“最近同步结果”分开保存：

```text
enabled: true | false
last_sync_result: never | success | error
```

这样一次网络错误不会把订阅本身变成暂停状态；下一次同步成功后 Error 自动恢复为 Active。

每个 Subscription 记录：

- Last successful sync
- Last sync attempt
- Last sync result
- Last error
- Created at
- Paused at
- Unsubscribed at

一个 Subscription 同步失败不得阻止其他 Subscription 同步。

### Pause

暂停后保留订阅、历史论文及全部用户状态，并停止自动抓取。恢复后从当前 RSS 继续追踪。

### Unsubscribe

取消订阅后：

- 停止未来同步；
- 从当前订阅列表隐藏；
- 不删除论文、阅读状态、收藏、归档状态和历史命中来源。

数据库内部使用软删除，即记录 `unsubscribed_at`，而不是直接删除 Subscription 行。

---

## 7. Paper 与 Version

### 7.1 全局唯一 Paper

同一篇论文无论从多少 Category 被发现，系统中只有一个 Paper。

使用去掉版本号后的 arXiv ID 作为稳定身份：

```text
2508.12345v3 → 2508.12345
hep-th/9901001v2 → hep-th/9901001
```

解析器必须同时支持新式和旧式 arXiv ID。

### 7.2 Paper 保存内容

- Stable arXiv ID
- Latest observed version
- Latest observed metadata
- All observed Categories
- Matched Subscription(s)
- First seen at
- Last version seen at

不保存 Primary Category。

### 7.3 Paper Version

Paper Version 保存本地实际观察到的轻量快照：

- Version number
- Title
- Authors 原始文本
- Abstract
- Categories
- Announced at
- First seen at
- arXiv page URL
- PDF URL
- RSS announce type（若有）

唯一约束为：

```text
(paper_id, version)
```

发现更旧版本时不得覆盖更高版本。V1 不保存 PDF 文件。

---

## 8. 阅读与更新状态

阅读状态只表达用户是否点开过当前内容，类似邮件的高亮与非高亮：

- Unread：高亮
- Read：不高亮

Updated 是独立标记，不是第三种基础阅读状态。

### 8.1 状态变化

| 事件 | 结果 |
|---|---|
| 新 Paper 进入系统 | Unread，高亮，无 Updated 标记 |
| 用户展开论文卡片 | Read，取消高亮 |
| 用户点击 arXiv 或 PDF 链接 | Read，取消高亮 |
| 用户 Mark as Read | Read，取消高亮 |
| 用户 Mark as Unread | Unread，高亮，按普通 Unread 处理 |
| Read Paper 发现更高版本 | 变为 Unread，高亮，并显示 Updated 标记 |
| Unread Paper 发现更高版本 | 继续保持 Unread；更新版本信息，但不额外改变阅读状态 |

用户阅读更新后的内容后，Unread 高亮和 Updated 待读标记同时清除；卡片仍正常显示当前版本号和更新时间。

仅仅在列表中看到标题不算 Read。

### 8.2 建议字段

```text
is_read: boolean
unread_reason: new | manual | updated | null
read_at: timestamp | null
```

`unread_reason = updated` 只用于决定是否显示 Updated 待读标记。用户主动 Mark as Unread 后，`unread_reason = manual`。

---

## 9. Inbox 与 Archive

Inbox 是所有待用户处理论文的统一工作区，而不是 Category 页面。

包括：

- Newly discovered papers
- Archived Paper 的新版本
- 尚未归档的 Paper 更新

Category 只是筛选维度。

### 9.1 离开 Inbox

论文不会因为 Read 自动离开 Inbox。只有用户明确 Archive 才离开。

阅读状态与 Inbox 状态相互独立。

### 9.2 Archive 去重规则

归档时记录用户处理到的版本：

```text
archived_version
archived_at
```

- Archive v2 后再次同步到 v2：不重新进入 Inbox。
- 首次同步到 v3：重新进入 Inbox 一次，并刷新 Inbox activity time。
- 再次同步到 v3：不重复入箱，也不刷新 activity time。
- 用户可以手动将 Archived Paper 移回 Inbox。

新建 Subscription 时，如果其 RSS 中出现一篇本地已经归档且版本相同的 Paper，只新增命中来源，不重新入箱。

---

## 10. Paper Card

Inbox 默认使用紧凑卡片，展示：

- Title
- Authors
- Categories
- Matched Categories
- Announcement / Updated time
- Latest observed version
- Read / Unread 高亮
- Updated 待读标记

摘要默认折叠。点击卡片后展开 Abstract 和操作区域，并将当前内容标记为 Read。

外部输入文本必须转义或安全清洗，防止标题、作者或摘要中的内容被当作可执行 HTML。

---

## 11. Collections

系统支持多个扁平收藏夹。Paper 与 Collection 为多对多关系。

同一 Paper 可以同时存在于多个 Collection。系统可预置 Favorites。

收藏状态与 Inbox、Archive、Read 状态完全独立。

V1 不支持子文件夹或嵌套 Collection。

---

## 12. 批量操作

Inbox 支持多选及以下操作：

- Archive
- Mark as Read
- Mark as Unread
- Add to Collection

所有批量操作必须在一个数据库事务中完成。部分失败时不得留下难以判断的半完成状态。

---

## 13. Search 与 Filters

### 13.1 Search

只搜索本地数据库，不调用 arXiv 搜索。

可搜索：

- Title
- Author 原始文本
- Abstract
- arXiv ID
- Category

建议使用 SQLite FTS5 建立全文索引。搜索索引可以重建，不作为备份中的唯一数据来源。

### 13.2 Filters

Inbox、Archive、Collection 共享：

- Category 大类 / 小类层级复选：选项只从当前 Inbox 实际存在的 Category 生成；可同时勾选多个 `cs` 等大类和多个 `cs.AI` 等小类，结果按所选集合的并集匹配
- Reading：Unread / Read
- Updated：有无待阅读更新
- Time：Today / Last 7 days / Last 30 days / Custom
- Collection

时间筛选语义：

- Inbox 使用最近进入或重新进入 Inbox 的时间；
- Archive 使用归档时间；
- Collection 默认使用加入收藏夹的时间。

筛选只是临时 View，不产生新的 Subscription。

---

## 14. 排序

Inbox 默认按 arXiv Metadata API 的 `updated_at` 倒序；尚未补充该时间时回退到 RSS `announced_at`，再以 Inbox activity time 打破并列。

旧论文出现新版本并重新入箱时会来到顶部。重复同步同一版本不得改变排序。

同时保留按 Recent Inbox Activity 排序。由于 RSS-only 无法始终获得论文最初发表时间，不提供含义模糊的 Publication Time 排序。

---

## 15. 数据保留

进入系统的论文元数据默认永久保存。系统不得自动清理旧论文。

V1 不提供永久删除 Paper 的正常工作流。

---

## 16. Backup / Restore

备份包含：

- Subscriptions
- Papers
- Observed Paper Versions
- Read / Unread 状态
- Inbox / Archive 状态
- Collections 与成员关系
- Settings
- Sync metadata
- 数据库 schema version

V1 Restore 使用整体替换语义，不做两份数据库合并。

恢复流程必须：

1. 校验备份格式和 schema version。
2. 恢复前自动生成当前数据库的安全副本。
3. 在临时位置完成恢复和迁移验证。
4. 验证成功后再替换当前数据库。
5. 任一步骤失败都继续使用原数据库。

SQLite 使用 WAL 时，导出必须通过 SQLite backup API 或一致性快照完成，不能直接复制正在写入的单个数据库文件。

---

## 17. 页面结构

### Sidebar

- Inbox
- Archive
- Collections
- Subscriptions
- Settings

Sidebar 展示 Inbox 总数。该数字表示尚未归档数量，不是 Unread 数量。

### Inbox

- Search
- Filters
- Sort
- Paper cards
- Batch actions

### Collections

浏览收藏夹及其中论文。

### Subscriptions

展示：

- Active / Paused / Error
- Last successful sync
- Last error

支持 Add、Pause、Resume、Unsubscribe、Refresh。

### Settings

- Auto refresh interval：1–7 天
- Display density
- Category cache refresh
- Backup
- Restore

---

## 18. 同步完成反馈

V1 只提供应用内反馈：

```text
12 new papers
3 updated papers
1 subscription failed
```

计数规则：

- New：同步开始前本地不存在该 Paper。
- Updated：同步开始前存在该 Paper，且首次观察到更高版本。
- Duplicate：不显示在主要成功数字中，可在详情中查看。

同一 Paper 在一次同步中通过多个 Subscription 出现，只计数一次。

---

## 19. 异常处理

### RSS 请求失败

- 保留已有数据；
- 记录 Error；
- 不更新最后成功同步时间；
- 不清空 Feed 或本地论文。

### 空 Feed

周末、假期或无新公告时可能为空。结构合法的空 Feed 是成功同步，不是错误，也不代表需要删除本地内容。

### 部分 Subscription 失败

其他 Subscription 继续按顺序同步。每个 Feed 单独使用数据库事务。

### 解析失败

- XML 解析禁用外部实体；
- Feed 整体无法解析时，本次同步失败；
- 单条项目异常时记录诊断并跳过该条，不覆盖已有数据；
- 只有完成预定处理后才更新 Last successful sync。

### 长期离线

明确提示 RSS 可能无法覆盖期间全部论文，系统不得声称已经补齐历史。

---

## 20. V1 核心数据关系

### Subscription

订阅哪个 Category，是否启用，以及最近同步情况。

### Paper

以无版本号 arXiv ID 全局唯一，指向本地观察到的最高版本。

### Paper Version

保存本地观察到的版本快照，唯一键为 `(paper_id, version)`。

### Paper ↔ Category

论文在 RSS 中出现过的 Categories。

### Paper ↔ Subscription

论文通过哪些订阅被发现，并保存首次发现时间。关系唯一键为 `(paper_id, subscription_id)`。

### User Paper State

- `is_read`
- `unread_reason`
- `in_inbox`
- `inbox_activity_at`
- `archived_version`
- `archived_at`

### Collection

用户创建的扁平收藏夹。

### Paper ↔ Collection

多对多收藏关系，并保存加入时间。

### Sync State

每个 Subscription 的同步尝试、成功时间、结果和错误信息。

---

## 21. V1 明确不做

- AI 推荐或相关性评分
- Embedding / Semantic Search
- 关键词、作者或 Topic Subscription
- arXiv 全站搜索
- 历史论文 API 补抓
- 使用额外 API 补 Primary Category
- 通用 RSS Feed
- 云同步与用户账户
- 系统通知
- 桌面原生封装
- Subscription 文件夹
- Collection 嵌套
- 永久删除 Paper
- 复杂规则引擎

---

## 22. V1 验收标准

### Subscription

用户可以从 Category 列表添加、暂停、恢复和取消订阅。

### Initial Sync

新 Subscription 导入当前 RSS；已经存在的相同 Paper 不重复创建或重置状态。

### Incremental Sync

后续刷新只产生真正新增或首次观察到的更高版本。

### Idempotency

同一 Feed 连续同步多次，第二次起不会重复创建、入箱、更新 activity time 或计数。

### Deduplication

同一 Paper 通过多个 Category 出现时只保存一次，同一版本只保存一次。

### Out-of-order Safety

先处理 v3、再处理 v2 时，Paper 仍指向 v3，v2 不覆盖当前元数据。

### Reading

点击卡片或论文链接后正确取消 Unread 高亮；Mark as Unread 后恢复普通 Unread 高亮。

### Version Update

本地已存在 Paper 且发现更高版本时算 Updated。本地不存在时，无论 RSS 显示什么版本，都算 New。

Read Paper 更新后变为 Unread，并显示 Updated 待读标记；原本 Unread 的 Paper 更新后继续保持 Unread。

### Re-entry

Archived Paper 出现更高版本后只重新进入 Inbox 一次；重复同步相同版本不重新入箱。

### Archive

只有用户主动 Archive 才离开 Inbox。

### Collections

Paper 可以同时加入多个 Collection，且不改变阅读或归档状态。

### Search & Filter

能够搜索本地论文并组合筛选；Category 可复选当前 Inbox 中存在的多个大类与小类，勾选大类代表其全部小类，所有勾选项按并集匹配；Inbox 的时间筛选使用 Inbox activity time。

### Persistence

关闭并重新打开应用后，全部数据和状态保持。

### Sync Failure

网络失败、单个 Feed 失败、空 Feed 或单条异常数据不会损坏已有数据。

### ID Compatibility

正确识别新式和旧式 arXiv ID，并正确剥离版本号。

### Backup

完整备份可以恢复；无效备份或恢复中断不会损坏当前数据库。

---

## 23. 后续演进方向

```text
V1    arXiv RSS Tracking
 ↓
V1.1  Keyword filtering / rule-based filtering
 ↓
V1.2  Author / topic tracking
 ↓
V2    AI relevance scoring
 ↓
V2.x  Daily digest / summarization / recommendation
```

长期目标是从“这里有 80 篇新论文”演化为“今天新增 80 篇，其中这 6 篇最值得关注，以及为什么”。

---

## 24. AI 摘要翻译与解释

系统支持为本地已发现论文生成中文摘要翻译和一句话中文解释。结果绑定 `(paper_id, version)`，新版本不得复用旧版本结果。

处理模式包括：

- `off`：暂停领取 AI 任务，但继续显示已有结果；
- `auto`：Inbox 中尚未处理的当前版本自动补入队列，新论文和新版本继续自动入队；
- `manual`：只有用户勾选并提交的论文入队。

AI 调用独立于 RSS 同步。每个请求只包含一篇论文，Worker 使用 1–10 个并发槽位滚动执行；任一请求完成后立即补入下一篇，不等待同组请求全部结束。任务状态持久化到 SQLite，应用重启后继续处理。

应用升级后 AI 默认为关闭；用户切换到自动模式时才回填 Inbox，Archive 不参与自动回填。模型服务失败不得影响 RSS 同步、阅读状态或归档操作。
