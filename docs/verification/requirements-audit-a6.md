# R1–R25 实现与验证对账

来源：[已确认需求](../requirements/2026-09-29-cli-tool-manager.md)。本表区分实现、开发回归与真实平台验收。Windows 的隔离测试壳使用不同 application identifier 和独立数据目录；它不能替代普通候选或完整 CLI 平台验收。

| 需求 | 当前实现与本轮修复 | 验证及剩余边界 |
| --- | --- | --- |
| R1 独立产品 | 栖点品牌、五页桌面、稳定内容摘要命名的 Windows EXE | unsigned/no-bundle；安装包、安装与发布未验收 |
| R2 三平台五 CLI | 五个独立 CLI adapter，Windows 真实版本检测 | [平台矩阵](platform-evidence.json)仍 0/15；macOS/Linux 无现场证据 |
| R3 安装升级 | 官方说明、按真实安装来源生成的可复制命令、依赖/路径检查与重新检测 | 未执行供应商安装升级；版本检测不冒充安装验收 |
| R4 连接密钥模型 | 主表单 API/密钥/模型；获取模型先使用新输入密钥；目录下拉、列表内搜索、缓存时间、手动模型；原生登录由 CLI adapter 声明 | generic HTTP/parser/cache 回归；真实 CPA GET 200/107 及保存后复取已有隔离壳证据。供应商适配器已按用户要求取消，智谱专用目录未自动接入；目录模型不保证套餐可用 |
| R5 全局项目 | 项目下拉及 native folder picker；真正作用范围；CLI 自有模型映射 | 临时项目原生写入有实机证据；多个真实项目启动后供应商 CLI 生效与跨平台未全验收 |
| R6 写入恢复 | CAS、加密备份、最近修改比较/恢复；原文和命名应用均可比较双方内容后明确选择；普通 MCP/Skills 自动 preview/apply | Rust 事务/回滚/外改保护回归保留。实机已证原文外改保留及备份恢复；Claude 项目比较漏 local 文件的实机失败已修复，空/有密钥 local 文件与再次外改边界已回归 |
| R7 项目终端 | 添加先选目录、自动命名；正常/YOLO，原会话 cwd 恢复；编码 PowerShell 命令避免 WT 分号解析；交互 console handles | 真实目录 picker、特殊字符 cwd、normal/YOLO 与恢复 argv 交给无网络 shim；WT/PS 两路径真实 TTY/color 已通过。未实际恢复供应商会话 |
| R8 MCP | 当前原生内容随 CLI/context 切换；主保存写当前 CLI；纯库保存/多目标分发次级；真实开关，重选恢复 target enabled | UI 24 项回归包含同名不同 CLI、异步旧响应及 target 状态；Pi 不支持 MCP 如实显示。完整供应商运行验收未完成 |
| R9 Skills | 本地目录/ZIP 与 HTTPS ZIP、单包自动定位、多包选择、完整资源、同名 CAS；普通安装一步；CLI 原生策略或扫描目录外完整停用存档 | 真实 Windows ZIP picker 单包/多包和资源 bytes 已验证；Rust 两 Skill 交错开关、原策略、失效路径、资源恢复回归保留。OpenCode 使用全局 permission.skill 策略，不声称覆盖更宽的特定 agent 策略 |
| R10 提示词 | CRUD、分类/搜索/项目过滤/复制、Markdown 编辑；导航保留草稿 | 现有 UI/存储回归；不执行内容 |
| R11 长期规则 | 规则模板分发；现有 native AGENTS/CLAUDE 选择/读取/编辑/保存；停用和加密原文恢复 | Rust 同文件外改拒绝及 bytes 恢复；停用后保存正文同步真实 enabled。全 CLI 运行后的规则读取未全验收 |
| R12 历史会话 | 五 CLI 索引、缓存首屏、增量后台扫描、取消/进度、过滤旧响应保护、收藏/导出/恢复；取消检查贯穿发现、指纹分块、JSONL 行与数据库记录，未完成解析保留旧索引，清理事务取消回滚 | 已验证真实保存对话框 JSON/Markdown 与取消；本机索引只读计时另列。旧候选扫描取消未及时收尾的实际失败保留，发现阶段缺检查是源码依据，不能从事后 progress 回推失败时的具体工具/阶段。9 项 history 回归覆盖受控发现与解析取消；最终实机复验另列。真实 CLI 恢复、所有 native 版本与跨平台未全验收 |
| R13 统计费用 | 按实际 UsageEvent 的工具/模型分组，单会话模型变化分开，未知保留；显式模型筛选/价格工具模型；日期项目筛选 | 混模型/未知事件数据库回归保留。价格为用户提供的估算，不宣称实际账单或未知 token 为零 |
| R14 迁移范围 | 白名单实体、API key 加密迁移、OAuth/历史/用量/本机绑定排除、路径重联 | Rust snapshot 往返/冲突回归；不同设备/OS 现场未完成 |
| R15 导入导出 | 加密包、集中预览/冲突选择、关联目录与显式应用；系统对话框 ACL 已修 | 核心 roundtrip/UI 回归及真实文件 dialog；新设备完整流程未验收 |
| R16 WebDAV | 首连能力检查、自动/手动同步、退避、合并/冲突/删除、密码轮换恢复 | 六类多设备/恢复重要语义全部保留并通过 Rust；本地协议 fixture 不代表第三方 DAV 或真实两设备验收 |
| R17 低负担密钥 | 配置保存与获取模型自动关联输入 key；明确点击才显示自己管理 API key；keyring 与加密迁移 | 真实 Windows keyring 保存后复取已有证据；无 OAuth 暴露、无 key 普通 bootstrap/log/plain portable |
| R18 界面 | sage 明暗、铺满窗口、单内容滚动、核心表单限宽、当前/命名分离、文件名主标题、项目目录简洁、共享语法编辑/中文菜单、草稿跨页保留 | 原生 WebView2 nonce/动态样式/layers/光标几何已查；真实 pointer 选区/双击/撤销菜单已查。浏览器 640px 图与真实 150% DPI 窗口分别标注，旧图不替代最终候选 |
| R19 外部运行 | 使用外部终端启动/恢复，查看会话不会执行内容 | 未增加内置工作台；shim 检验无网络/付费调用 |
| R20 无网关 | 原生文件与直接供应商 GET/明确诊断请求 | 无代理、协议转换或请求转发层 |
| R21 首版范围 | 本机统计、迁移、自有 WebDAV | 无余额、市场、远端机器管理；WSL 不作 Linux 桌面验收 |
| R22 托盘 | CLI 配置与最近项目 submenu，显示窗口/完全退出均为顶层；旧失败定向页面保留 | 菜单状态/修复路由 3 项 Rust 回归；真实托盘完整点击隐藏恢复、跨平台托盘仍未验收 |
| R23 多配置继承 | 命名配置新建/复制/删除/重命名；通用继承/合并高级；保存与使用分开；Pi primary role；Claude 六角色、display 名/[1m] | 实际 SQLite 新建保存重开已有证据；模型保存应用读取回归含取消默认角色 1M、不丢其它角色/未知字段 |
| R24 管理范围 | 首页/工具/托盘同 managed IDs，全取消空态，偏好迁移，未知 ID 保留 | 既有 UI/native/portable 回归；不删非管理工具历史或原生文件 |
| R25 扩展 | Rust/前端 CLI registry、primary role、login、model codec/fileRole、原生资源开关都由独立 adapter 声明；共用 UI 按 contract 渲染 | 现有第六 adapter 回归保留；无公共 CLI 名/供应商 host 特例；Kimi 未实现 |

统一暖单元命令与实测数据见 [unit performance](unit-performance-a6/README.md)。正式 Delivery 的顶层前端、Cargo、desktop 与发布判断由后续候选绑定验证完成；本表不把开发回归当正式验证。

最终源码输入 `cf9d402…` 的普通 `9d3922…` EXE 仅构建，隔离 `185849…` EXE 完成 [10 项产品检查](windows-native-a6/final/native-final-product-after.json)、[32 项缓存/取消/模型统计/布局检查](windows-native-a6/final/native-final-records-layout-after.json) 和 [两项真实交互终端检查](windows-native-a6/final/native-final-color-after.json)。这些直接补证 R5–R9、R11–R13、R18、R23 的上述本机交互边界，仍不是完整三平台五 CLI 验收。缓存首屏 198.1ms 与后台扫描 23.0s 分开，取消 49.8ms 并保留缓存；不把快首屏冒充快全量扫描。弹层实际 Escape/取消保留 DB、确认仅移除项目关联，CSP/pageerror 为零，用户现有两个窗口和草稿均未操作。

Windows dialog 插件将 `window.confirm` 替换为 Promise，旧同步判断曾使取消保护失效。进一步实机证实注入 shim 调用了当前 Rust 插件未注册的 `confirm` 命令，单补废弃权限 alias 无法修复。最后依用户明确要求改为应用内 `ConfirmationHost`，desktop 与 browser 均不调用系统/浏览器确认。原生权限仅保留真实文件/目录选择所需的 open/save。所有调用者等待明确 `true` 并检查草稿/上下文；删除、放弃修改、可能计费请求有具体按钮，默认焦点取消，Escape 关闭并返回原焦点。原有 24 项 UI 流程通过实际弹层按钮覆盖取消/接受、确认期间异步改稿、项目移除与付费 IPC 负向断言，fixture 对系统确认调用直接抛错。明暗 640/1160 浏览器边界和焦点观察见 [应用内确认](windows-native-a6/application-confirmation-browser/browser-check.json)，它们不能代替新生产 WebView 的实测。旧失败见 [pre-confirm](windows-native-a6/pre-confirm/native-final-product-confirm-ACL-failure.json) 与 [pre-sdk-confirm](windows-native-a6/pre-sdk-confirm/native-final-product-confirm-command-failure.json)。SDK 候选的七项功能通过后，系统确认自动化未完成规则操作，作为驱动边界保留在 [pre-application-confirmation](windows-native-a6/pre-application-confirmation/native-final-product-system-dialog-driver-failure.json)，不将它写成已确证的 SDK 产品缺陷。
