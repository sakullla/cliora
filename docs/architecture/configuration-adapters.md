# 注册式配置编辑

后端能力入口为 `src-tauri/src/adapters/configuration.rs::ConfigurationAdapter`。
CLI 在 `CliAdapter::configuration` 返回端口即可接入，未声明该能力的 CLI 继续使用既有配置和原文功能。
前端在 `ToolUiAdapter.configuration.Editor` 注册专属组件；共享工作区通过 descriptor 和 capability 挂载，不能添加 CLI ID 分支。

## 草稿和编辑动作

`src-tauri/src/native/configuration.rs` 与 `src/types/configuration.ts` 定义相同 IPC。
`open_configuration_draft`、`edit_configuration_draft`、`replace_configuration_text` 是无文件写入、无凭据写入的编辑入口。
凭据原文必须先使用现有 prepare import 的安全抽取流程；普通草稿不是凭据导入替代品。

草稿只以 `profile.files` 为配置值来源。`view` 是适配器投影；`profile.connection` 是只读兼容投影，不能用它修改已升级文档。
草稿携带 common 只读快照，投影与校验使用同一份生效合并值；表单动作仅改变本层 files。
数组适配器可覆盖 `edit_inherited` 读取有效基线并生成本层变化。
表单动作使用 version=1、逻辑 target、operation、可选 field/value；目标必须为稳定实体身份，不能持久化数组下标或文件路径。
同一逻辑字段的 set/reset 会压缩过时值，跨实体生命周期动作保持顺序；编辑意图限制为 2000 条及 512 KB，超限或明文密钥动作返回错误并保留可恢复草稿。
适配器声明字段名、控件类型、必填、最小值、选项、默认来源和不可用原因。
`edit` 修改原文对应的解析文档；共享服务渲染原文、追加编辑意图，再重新投影和校验。
非法原文保留输入和最后可识别视图，返回 issues 并阻止保存；非法语义值保留在草稿中并返回字段问题。
`ConfigurationField` 要求 `onValidityChange`，数字/JSON 的中间输入及待完成写入必须同时阻止上层提交。
`ConfigurationEditorProps.onValidityChange(field, valid)` 将专属编辑器的字段状态接入共享提交保护；组件成功重试会恢复有效性，旧响应不能改变新状态。
可选枚举的缺省选项调用 onReset，未提供 reset 时只能显示不可选择的未设置状态；待提交数字文本在 IPC 完成前保留，较旧投影不能覆盖新输入。

`src/lib/configurationDraft.ts::createConfigurationSession` 的 `edit` 串行执行表单动作，避免丢失先前编辑；`update` 用于原文或整个文档替换，与 `edit` 使用同一个顺序队列；后续动作消费上一操作的结果。
会话失效后旧请求不能提交，相同或倒退 revision 的响应被拒绝。
关闭、失效、不同 sessionId 或较旧 revision 的结果不能替换当前草稿。
会话的 `setFieldValidity` 和后端 issues 一起决定 canSubmit。

## 适配器实现责任

- `describe/read/edit/validate/connection` 提供专属字段、逻辑动作、后端约束及只读连接。
- 必须实现 `reconcile_text(previous, next, effective, state)`：next 是本层原文，effective 是只读合并值；有效原文恢复实体或明确覆盖字段时撤销旧 delete/rename/reset 意图，仍缺席的显式删除继续保留。语法错误保留原文和旧意图，等待修正。
- `suppression_changes(action)` 返回具体 role/path 的增加或清除；reset 必须清除该逻辑字段对应的旧 suppressed，保留其他排除记录。路径映射属于 CLI 适配器。
- `reconcile_suppressions(previous, next, suppressed)` 在有效原文重新引入实体时撤销对应的旧排除；共享服务负责调用，CLI 负责映射身份。suppressed 和来源指针使用 JSON Pointer 的 `~0/~1` 转义，模型名中的斜杠和波浪号不能改变路径层级。
- `portable_field_kind(path)` 声明 Parameter、Credential、CredentialReference、Local 或 Unknown；文档与动作负载执行一致语义分类，maxTokens 这类模型上限不得作为认证 Token 删除。CredentialReference 仅在 `portable_reference_valid(path, value)` 按原生语法验证后保留；验证不得读取环境变量、凭据或执行命令。共享迁移继续拒绝明确凭据字段和本机绝对路径。
- `resolve_file(role, base, own, suppressed)` 可按稳定模型 ID 合并数组并返回字段来源；缺省实现沿用共享合并。Pi 用它保留稀疏模型覆盖，取消一个字段覆盖后其他字段仍跟随 common 的后续变化。
- `managed_documents` 限定命名配置拥有的供应商和配置级字段。
- `managed_fields` 基于当前磁盘、目标文档及持久编辑意图生成指针变更；值 None 是显式删除，released 是取消本层覆盖。
- 数组按原生稳定身份合并；对象和其他供应商的未知字段必须保留。删除不能通过旧 preserve 方法补回。
- 删除/改名实体须维护默认、轻量模型及其他原生引用；操作的解码和字段校验属于适配器。
- reset 对已管理字段恢复合并后的继承值，或删除覆盖以使用原生默认；未被管理的原生值保留。旧 managed 值与磁盘不一致时依旧返回冲突。
- `unmanaged_paths` 只解除切换前供应商路径的管理关系，保留其原生值与凭据；它与 reset 分开处理，不能覆盖共享凭据写入或清理计划。新选定目标仍执行文件 CAS。
- `empty_deleted_entities` 只声明显式删除或改名实体的候选路径。共享 apply 在字段 CAS 后确认子树递归仅含空对象且未涉及已解除管理或凭据路径，才清理空壳；其他供应商和用户声明的 `{}` 保留。

共享 apply 服务继续拥有 CAS、账户上下文检查、凭据策略、加密备份、事务和恢复。适配器不直接写文件、启动进程或访问 keyring。
敏感字段变更在语义映射后再次经过共享凭据策略；取消覆盖不能撤销共享的凭据清理或写入。
密钥引用只在 provider/interfaceFormat/baseUrl 相同的连接身份之间保留；改变目标需要重新选定凭据。
兼容归一化只折入文档，保留待核对的旧引用；完整 effective 文档可用后再派生身份，避免 own 文档缺少继承地址时提前清空引用。
实际应用以同一个已核对的工作投影生成文档与凭据计划，原 DB profile 快照独立用于 CAS；common 改变目标且旧引用仍绑定旧身份时拒绝应用，原文件保持原状。

## 存储和兼容

`RegisteredProfile.editing` 保存 version、selectedProvider、intents，files 仍为唯一文档。
旧 connection/modelRecords 通过 `normalize_legacy` 在编辑/迁移边界折入原文一次。升级后的 projection 不再覆盖 files，ID、revision、账号和未知原生值保持。
旧不完整记录允许读取；完整保存和应用按注册能力执行兼容归一化及适配器验证，省略 editing 不能关闭校验。当前文件与 common 保存同样执行已注册端口的语义校验。
旧 modelRecords 在本层原文缺少选定模型基线时，显式应用可从已声明原生角色的当前文件取得基线，再执行一次兼容折入与校验；查看和保存不触发原生文件写入，原 DB 快照独立用于 CAS。

SQLite schema 19 声明对新编辑语义的支持，升级不批量改写 CLI 文件。
Portable snapshot v2 和 WebDAV manifest v2 携带编辑状态；新客户端接受 v1，旧客户端因版本不支持拒绝 v2，避免丢弃新意图后回写。
导出仍经过既有原生字段白名单和路径/凭据净化，编辑意图也执行净化；OAuth 需要在目标设备重新绑定。
导入复用相同归一化入口、凭据重绑定和绑定待应用逻辑，保持显式应用边界。

开发证据：`tests/adapter/sixth.rs` 验证额外注册适配器的字段描述、三模型创建、改名、删除、默认引用、取消覆盖、非法草稿、旧数据归一化、DB/Portable 往返及事务冲突。
`tests/native/configuration-draft.test.mjs` 验证会话过期响应、连续表单编辑和非法输入提交保护。
`src-tauri/src/adapters/pi/configuration_tests.rs` 使用隔离目录和内存凭据覆盖三个 CLI 的模型生命周期、真实文件应用、稀疏继承、原文与排除对账、v2 凭据往返及 OpenCode 当前磁盘引用保护；`tests/ui/config-models.spec.ts` 覆盖三种专属编辑器。
这些开发测试不替代五个 CLI 的真实原生加载和正式交付验证。
