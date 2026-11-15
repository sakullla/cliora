# 原生历史适配与远程快照

历史路径、环境变量、文件格式、数据库字段、查询与用量语义归 CLI 适配器；共享 history 服务负责读取边界、取消、缓存、限额与本地索引写入。不按 CLI ID 分派。

## 本地读取

适配器通过 history_sources_controlled / parse_history_controlled 提供源与解析结果。来源指纹应包含对应解析器版本，原生 SQLite 缓存同时检查 DB 和 WAL 的大小、修改时间、change-time。只读 RevisionCache 可复用索引元数据；大目录共享 Arc，避免每个会话复制整份目录。

JSONL 适配器可用 read_jsonl_fields 声明实际消费的顶层字段。共享 reader 仍负责字节上限、行索引、取消和 JSON 语法检查；不需要的子树由 serde IgnoredAny 校验而不构建 Value 树。字段集合放在适配器中，新增原生字段支持时同步更新集合。

## RemoteHistoryLayout

- relative 是登录用户 HOME 下的主来源根；fallbacks 是同布局的旧根，只有主索引缺失时使用。输出镜像到主根，保留 native ID 对应的稳定会话 ID。
- 文件来源声明 pinned / sessions 文件名模式、companion 子记录目录与排序。
- SQLite 来源声明 index 文件，以及 RemoteHistoryTable：表名、选择 SQL、必需列、原生 ID 列、关联列。索引 SQL 使用共享 :limit；关联表的 query 是可选行过滤条件。
- 查询可只返回解析器需要的列。导出表结构按查询结果构建，不执行源库中的建表 SQL，也不复制未声明表。
- files 使用受限 {id} 模板声明相关日志或数据库；file_tables 限定会话数据库的可读表。catalogs 用于文件型来源附带的 SQLite 标题索引。

新增来源只需声明自身布局并实现本地解析器；共享 exporter 不维护供应商 ID 清单。remote_native 测试使用 .extension/history、runs / wires 表验证非内置名称的扩展。

## 传输、缓存与失败

共享 remote_export.py 是随请求执行的 Python 标准库脚本，不安装远端组件。先批量检查根目录，避免为缺失来源逐个发起读取。源 SQLite 使用 mode=ro、query_only 和读取事务，能读取尚在 WAL 中的提交；快照写入私有临时目录。读取拒绝越界路径、符号链接和过量数据。信号取消时退出并清理临时目录。

优先选择近期会话：索引查询使用 60 条上限，单文件 12 MiB、整个解压归档 48 MiB。超长 JSONL 保留初始身份与近期完整行并标记 partial，且不从缺失中间段的日志推算模型用量。agy 的独立完整用量数据库不受正文截断影响。

协议 U 返回未变化的指纹；V 返回指纹、partial 路径与 gzip 压缩的 F/Z 文件帧。解压端同样限制大小并检查路径。指纹涵盖选中文件元数据、SQLite WAL 与布局。未变化时复用 Arc 中的已解析正文；有变化时重新导出该来源。当前不是逐会话增量传输，也不是完整远端历史分页。

缓存继续由 remote::read_cache 管理主机身份隔离、容量、TTL、请求合并和最后订阅者取消。列表只复制摘要，详情只复制选中会话。坏记录产生可见来源警告，并尽量保留上次可读记录为 stale；确认删除后的干净刷新才移除旧记录。

HistorySnapshot.availableSources 声明已注册的快照来源，与暂时读取失败分开；前端不再把未支持的远端格式当成没有会话。它区别于 RemoteCapabilities.history 的通用远端 CLI 命令端口。

## 本轮验证来源

Codex / Claude Code：已有 JSONL 与标题/子记录支持；CodeBuddy / Pi：新增远端 JSONL 布局；OpenCode：按近期 session / session_v2 选择相应 message / part / session_message，保留迁移期间的去重语义；agy：实测 1.5.9 的 antigravity-cli 目录、conversation_id / workspace_uris / 空父 ID，兼容旧索引与旧根，支持 packed stepIndices，并从原生步骤时间补充调用时间。

远端读取不会采用、复制或更新登录凭据。测试及采集只保留脱敏结构与计数，不提交用户原始会话或认证文件。
