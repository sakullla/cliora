---
# Runtime 只读取这一处文件头机器区；不要在正文重复机器字段。
format: exploration
# AI 在此填写非空摘要；正文由 owner 按阶段契约组织。
summary: "绿地桌面项目；五 CLI 原生差异及可靠性证据保留，补充 R18 视觉/操作路径与 R22 托盘研究，核实原生菜单可行及 Linux 图标事件限制。"
---
# 栖点 Cliora 探索证据

调研日期：2026-09-29。需求：[完整需求](../../requirements/2026-09-29-cli-tool-manager.md)，R1–R24 是范围依据。以下外部页面均在本次调研打开；文档声明不代表本项目实际验证。

## 仓库与现场

- `rg --files --hidden -g '!.git/**'` 在初始化前只发现上述需求文件；没有应用、测试、构建或 CI 配置，没有发现适用的 AGENTS.md。需求从第 1 行开始，R1–R21 各标题给出验收与排除边界。
- `git rev-parse --show-toplevel` 返回 `C:/Users/12976/project/cliora`；`git ls-files` 为空；`git log -1` 报 main 尚无提交；需求原本是未跟踪资料，不能误当本次生成的实现。
- 当前只有 Windows 本机执行现场。检测到 Node 26.4.0、npm 11.17.0、rustc 1.97.1、cargo 1.97.1；不等于 Windows SDK、链接器、WebView2 和打包依赖均已就绪。没有已核实可用的 macOS/Linux 桌面测试环境、签名凭据或远端 CI。
- 本次未读取用户 CLI 密钥、登录缓存和会话正文，未安装或修改任何 CLI。

## 五种 CLI 的直接文档证据

| 工具 | 已核实事实及来源 | 对需求的约束与 unknown |
|---|---|---|
| Codex | [Config basics](https://learn.chatgpt.com/docs/config-file/config-basic)：用户 `~/.codex/config.toml`，项目 `.codex/config.toml`，项目层受信任状态约束；[认证](https://learn.chatgpt.com/docs/auth)：文件和系统凭据存储均可能存在；[MCP](https://learn.chatgpt.com/docs/extend/mcp)：STDIO、Streamable HTTP 与项目作用域。 | R4–R8 必须展示来源和信任限制；不能直接打包 auth.json，其可包含网页登录令牌。Windows 原生支持有[官方说明](https://learn.chatgpt.com/docs/windows/windows-sandbox)，仍需测试实际 CLI 版本、安装与启动。 |
| Claude Code | [安装](https://code.claude.com/docs/en/setup)：有原生 Windows/macOS/Linux 安装途径，原生安装与包管理器更新方式不同；[设置](https://code.claude.com/docs/en/settings)：用户、共享项目、项目本地和管理层，设置文件是严格 JSON；`~/.claude.json` 另含登录、MCP、项目状态。 | R3 不能统一执行 npm 升级；R4–R6 应局部改字段且保留原登录；不能把所有内容塞进 settings.json，不能往严格 JSON 插入注释。 |
| Grok Build | [入门](https://docs.x.ai/build/overview)：官方命令为 `grok`，提供 Windows 与 Unix 安装入口，首次网页登录，也支持 API key；自定义模型在用户 TOML；[设置](https://docs.x.ai/build/settings)：GROK_HOME、用户与项目作用域；[会话](https://docs.x.ai/build/features/sessions)：`--resume <id>` 恢复，`--session-id` 是新建。 | 不能混用第三方同名 Grok CLI；项目文档列举 MCP、插件、权限，不能由此推断所有用户模型字段可在项目覆盖。历史存储版本和用量字段尚未实测。 |
| Pi | [当前 README](https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/README.md) 已指向 earendil-works/pi，npm 包为 `@earendil-works/pi-coding-agent`，Node ≥22.19；[Windows](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/windows.md) 说明原生 Git Bash 与可选 PowerShell；[配置](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/configuration.md) 列出用户 `~/.pi/agent`、项目 `.pi`，独立 settings/models/auth、skills 和 mcp 文件；[模型](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/models.md) 区分原生登录与兼容端点。 | 原包名或旧版能力不能直接用于所有版本。配置页声称有 MCP，但其 `docs/mcp.md` 返回 404，传输类型、字段与最低版本仍未知；不能断言不支持，也不能开放未经验证的写入。项目 models.json 未在配置表中列出，项目服务商写入需另证。 |
| OpenCode | [入门](https://opencode.ai/docs/) 给出平台安装入口；[配置](https://opencode.ai/docs/config/) 支持 JSON/JSONC、用户与项目文件以及多个更高优先级来源，按键合并，模型为供应商/模型标识。 | R4–R6 要保留 JSONC 注释与未知字段；不能把方案切换实现成文件整体替换；Windows 的配置目录应按实际环境解析。历史数据库或文件格式、恢复命令与版本仍须验证。 |

文档覆盖了设计所需的原生差异，不是完整兼容性认证。Skills 搜索路径、MCP 细字段、模型角色、历史/用量结构、安装来源检测需要在各适配器实现时按固定版本的官方 schema、源码或 CLI 帮助补齐，并保留样本版本和出处。没有凭据或付费请求时不得把“格式正确”写成“模型请求成功”。

## 桌面、存储与可靠性证据

- [Tauri 前置依赖](https://v2.tauri.app/start/prerequisites/)列出 Rust、Windows 构建组件和 WebView、macOS 工具链、Linux WebKitGTK 依赖；能用于三平台桌面工程，但不能据此承诺任意 Linux 发行版。其 [WebDriver 文档](https://v2.tauri.app/develop/tests/webdriver/)说明 macOS 桌面缺少相应 WKWebView 驱动，不能将浏览器 UI 测试冒充三平台原生桌面端到端测试。
- [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)同样依赖系统保护能力；Linux 的 basic_text 回退不能当安全密钥库。桌面框架本身不解决 R17。
- [toml_edit](https://docs.rs/toml_edit/latest/toml_edit/)提供保留注释和排版的编辑，明确存在点分键顺序、末尾换行等限制；[jsonc-parser](https://docs.rs/jsonc-parser/latest/jsonc_parser/)提供 CST 修改与严格 JSON 解析。由此可实现字段级更新，但需要保真样本验证，不能声明逐字节保留所有格式。
- [keyring](https://docs.rs/keyring/latest/keyring/)当前文档建议需要明确控制后端的应用采用 keyring-core 与具体系统存储；依赖版本与平台后端要锁定验证，不能沿用记忆中的旧 API。
- [RFC 4918](https://www.rfc-editor.org/info/rfc4918/)提供 WebDAV 方法、锁和条件请求语义，不提供业务级双向合并。R16 的修改/删除冲突、离线旧副本、完整发布必须由应用处理；目标服务端能力需实际探测。
- [RFC 9106](https://www.rfc-editor.org/info/rfc9106/)可作为密码派生依据；[RustCrypto chacha20poly1305](https://docs.rs/chacha20poly1305/latest/chacha20poly1305/)提供认证加密。算法存在不等于密钥分发、恢复和轮换已经解决。

## 参考产品的使用边界

[CC Switch](https://github.com/farion1231/cc-switch) 与 [magpie](https://github.com/yetone/magpie) 已核对项目入口，作为需求来源与交互参照；未把其实现、许可证或兼容范围作为 Cliora 的事实。当前仓库没有可直接复用模块。不复制完整外部实现，不引入网关，遵循 R19–R21。

## 对后续方案的判断

以下是由上述证据与 R 条款推导的约束，不是既有代码：

1. 一个通用“全局服务商”开关无法忠实覆盖五种原生配置，必须区分工具、字段、作用域、版本、有效来源与信任状态。
2. CLI 原生文件是实际配置来源；客户端资料库、设备路径/活动选择、原生配置和本地历史不能混为一种可同步数据。
3. R6 要求并发外部编辑、跨文件失败、进程中断后可恢复；单纯写临时文件再 rename 不能保证整个多文件操作完成，也不能替代外部冲突检测。
4. R17 不指定端到端安全模型；使用 WebDAV 登录秘密派生保护与独立同步密钥会产生不同恢复体验。方案须明确选择、威胁边界与凭据轮换，而非隐藏在实现细节里。
5. 五工具 × 三平台的安装、配置、启动实测是发布硬条件。当前 Windows 环境不能证明其余组合。可以继续形成方案和实现计划，但不得降低 R2 验收或把未知项标成已支持。

## 待实现期补齐的证据与退出条件

| 缺口 | 影响与应取得的证据 |
|---|---|
| 五种工具具体版本、能力与原生配置样本 | 每个适配器先固定受测版本，核对官方入口/帮助，保存脱敏 fixture；基础安装、配置、启动无法成立时回到方案修订，不能用禁用全部能力完成交付。 |
| Pi MCP 文档缺页、项目模型支持；Grok 项目模型字段 | 首次适配前通过该版本官方源码、schema 或实际命令验证；扩展能力在证据不足时显示未知和原因。 |
| 历史格式、续聊标识、token 口径 | 获取各版本合法脱敏样本与恢复命令；不读取用户私人记录来构造测试，也不凭空补零。 |
| Windows 完整构建依赖、macOS/Linux 桌面现场 | 实现阶段检查构建并建立三个系统的真实验证记录；未取得时发布验收不能通过。 |
| WebDAV 兼容性与轮换 | 用本地可控 DAV fixture 验证并发、离线删除、截断上传，再用至少一个真实兼容服务验证；无可用远端时如实保留外部验收缺口。 |
| 系统凭据库及加密跨设备恢复 | 三平台后端真实读写；在全新数据目录/另一设备解锁，错误凭据和轮换失败均不损坏原数据。 |

已达到形成 02 架构方案的证据粒度；上述验证缺口进入实现与发布完成条件，不在此宣布完成。

## 补充研究：视觉、日常路径与托盘

用户要求重新研究视觉与排版，明确反馈原方案麻烦、不好用，并新增托盘快速切换。需求 R18 已更新，R22 定义托盘行为；原技术能力证据继续有效。

### 对原方案的可核验问题

原 02 ADR-09 把工具、项目、资料库、会话、用量、设置作为并列导航，以卡片作为首页主体，但没有具体控件尺寸、配置选择器内容、托盘、路径/范围区别或交互样例。点击数声明缺少可操作原型。这是对文档的设计评估，并非已做用户测试。

五工具均有相同的高频观察字段，卡片重复标题和留白会分散扫描；把“配置方案”与切换操作放到不同管理页面增加概念和导航负担。这是基于任务结构的推断，需通过可点击设计和用户反馈验证，不能引用为实测易用性结论。

### 外部依据

- [magpie 当前 README](https://raw.githubusercontent.com/yetone/magpie/main/README.md)描述单屏工具/模型列表、直接点击值选择模型、菜单栏入口和普通窗口；这支持研究“值本身就是切换入口”的模式。其网关与跨订阅机制不符合本项目 R20，不能复用其统一模型兼容假设。
- [Microsoft 导航基础](https://learn.microsoft.com/en-us/windows/apps/design/basics/navigation-basics)说明按内容关系选择平面/层级导航，并区分导航目的地和动作；支持把主导航与当前条目的操作分开。它不证明本项目应精确使用几个页面。
- [Microsoft 菜单说明](https://learn.microsoft.com/en-us/windows/apps/develop/ui/controls/menus-and-context-menus)覆盖上下文动作菜单及子菜单，作为少层级、就近操作的参考；核心动作仍须有可见入口，不只靠右键或快捷键。
- [Tauri 2 System Tray](https://v2.tauri.app/learn/system-tray/)支持 Rust/JS 创建托盘和菜单、菜单动作；Linux 不发出相同的托盘图标事件，但仍可显示右键菜单。因此不能把三平台快速切换建立在统一的图标左击自定义浮窗事件上。
- Apple 菜单栏指南本次访问失败，Menus 页面只返回动态页面壳，未拿到可引用正文；不以其作为具体尺寸、层级和点击行为的依据。

### 设计所需约束与仍待验证事项

1. 高频切换应在当前工具旁完成，配置名必须同时可识别供应商/模型，不能只显示一个“方案 A”。复杂角色仍由工具详情表达。
2. 托盘菜单必须直接显示当前工具与已选配置，切换与主窗口调用同一服务并在成功后更新勾选。不能隐藏失败，也不能承诺改变已有 CLI 会话。
3. 选择启动目录与修改配置范围是两个概念，界面即使简化也必须可辨认，不能借“项目快捷入口”静默改全局。
4. 关闭主窗口、托盘后台运行和完全退出需要明确行为；此前方案中“退出停止同步”只适用于真正退出进程。托盘宿主失效不能让应用无法找回。
5. 原生托盘菜单外观随系统主题，设计预览只能表达菜单结构；Ubuntu 的 AppIndicator/托盘宿主、macOS 菜单栏图标与 Windows 托盘隐藏区域均需真实桌面验证。
6. 静态尺寸与颜色需检查可读性，实际易用性需用户试用；本次能交付可点击视觉设计，不将其当已实现的 CLI 管理能力。

## 补充研究：完整页面、原生配置及迁移体验

用户最终选择恢复轻量侧栏和五工具首页，明确主要导航中的工具、资料库不应变成弹窗；要求直观查看 TOML/JSON、多份配置及通用继承。便携性已明确为“配置迁移方便，换设备容易恢复”，没有提出免安装分发要求。

2026-09-29 联网重新核验的实践及边界：

| 来源 | 已读取的实践 | 对当前问题的推论 |
|---|---|---|
| [Microsoft Navigation basics](https://learn.microsoft.com/en-us/windows/apps/design/basics/navigation-basics) | 顶层目的地可以用平面结构组织，复杂内容可在目的地下分层；导航与临时 UI 区分。 | 侧栏工具、资料库、记录、设置应是可返回的完整页面，不能把目的地伪装成动作弹层。 |
| [NN/g Modal & Nonmodal Dialogs](https://www.nngroup.com/articles/modal-nonmodal-dialog/) | 模态会中断任务、遮住背景；复杂多步骤任务通常更适合完整页面；字段错误尽量在字段旁处理。 | 多配置编辑、原生文件、通用继承及差异查看应占主内容区；弹窗仅用于短输入、必要确认和临时选择。 |
| [Microsoft Typography](https://learn.microsoft.com/en-us/windows/apps/design/signature-experiences/typography) | 用明确文字层级帮助扫描，在屏幕上保持可读性。 | 配置名、状态、操作的层级要稳定；原生编辑器不应挤在窄抽屉内；较弱说明不能和错误状态用同一种低对比文字。 |
| [Microsoft Responsive layouts](https://learn.microsoft.com/en-us/windows/apps/develop/ui/layouts-with-xaml) | 布局按可用窗口空间适配，内容与导航随尺寸调整。 | 工具详情的配置列表/编辑区域可在窄窗上下排列；保留操作与文件选择，不只整体缩小字号。 |
| [Microsoft Keyboard interactions](https://learn.microsoft.com/en-us/windows/apps/develop/input/keyboard-interactions) | 键盘焦点顺序、可见性与控件间移动属于必要交互设计。 | 页面切换要维护焦点；短选择器支持 Esc 与回到触发控件；原生草稿不得因导航悄悄丢失。 |
| [Microsoft Dialog controls](https://learn.microsoft.com/en-us/windows/apps/develop/ui/controls/dialogs-and-flyouts/dialogs) | 对话框是需要聚焦的一段交互，不是普通页面导航的替代。 | 本项目不采用多层模态叠加来编辑服务商、通用配置和原生文件。 |

以上指导不决定本项目必须采用某种配色，也不代表已验证用户满意度。具体颜色、间距、页面结构由 Owner 根据用户当前偏好设计并用截图与可点击原型检查。

迁移的既有需求 R14–R17 已足以覆盖用户回答：一处进入导入/导出/WebDAV，先看到资料与路径映射，错误可恢复，官方登录在新设备重新完成。这里只改善可见性与步骤，不扩大为复制 CLI 安装、OAuth 或同步会话。

原生配置的语法与文件分工沿用前述五工具官方证据。用户截图给出了 Codex config.toml 和通用配置的明确需求依据，但不把截图中的私有地址、机器路径或特定实验键当默认值。R23 的同工具通用继承是客户端资料计算，不可与 CLI 原生全局/项目加载混淆。


## 补充：管理范围与供应商模型列表（R4、R24）

直接证据：需求 R24 明确由设置选择管理 CLI，并要求首页、工具页与托盘一致，不删除既有资料。当前仓库仍是设计原型，没有生产侧扫描或菜单注册实现，因此没有既有后台行为需要兼容。

[Claude Models API](https://platform.claude.com/docs/en/api/models/list) 提供 `GET /v1/models`，返回模型 ID、显示名与分页信息；请求示例使用 API key 与版本头。[xAI Models API](https://docs.x.ai/developers/rest-api-reference/inference/models) 提供模型目录相关接口。两者是供应商能力的证据，不能证明任意第三方兼容端点都支持相同查询，或 CLI 订阅登录令牌可用于这些接口。

推断：模型目录需要按供应商协议、连接地址与认证身份隔离；查询失败不应使原有模型不可编辑。获取到模型 ID 也不能单独证明目标 CLI 的推理请求、工具调用或模型参数兼容。

未知与验证边界：用户实际自定义端点的目录路径、鉴权、分页和返回格式尚未验证；未请求任何用户私有地址或凭据。正式实现需验证成功、空列表、分页、鉴权失败、不支持、超时、缓存与手填行为，且不能凭目录结果自动替换当前模型。


接口格式补证（R4）：[Pi models.json 文档](https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/docs/models.md) 用 `api` 声明兼容端点协议，并要求其请求字段与实际服务一致；[OpenCode providers 文档](https://opencode.ai/docs/providers/) 明确区分 Chat Completions 使用 `@ai-sdk/openai-compatible`、Responses 使用 `@ai-sdk/openai`。这证明多个原生协议不能仅靠相同 URL 自动判断，且不同 CLI 的写回字段不同。推断：应由版本适配器输出可选格式及原生字段映射；未知协议保留原文，不能自动降级成另一格式。其他 CLI/版本支持的完整枚举仍需实现阶段固定版本核验。
