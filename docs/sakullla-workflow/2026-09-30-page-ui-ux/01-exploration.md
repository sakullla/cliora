---
# Runtime 只读取这一处文件头机器区；不要在正文重复机器字段。
format: exploration
# AI 在此填写非空摘要；正文由 owner 按阶段契约组织。
summary: "五页、鼠尾草主题和统一确认已经存在；主操作多在表单或列表之后，样式断点是 900 与 680，测试未锁定 1360。"
---

# 探索证据

需求 `docs/requirements/2026-09-30-page-ui-ux.md` 要求在现有五页内重排分组和主操作，使主任务与关键状态位于当前视图前部，且不增加常用步数、不新增能力、不更换主题。下面只记录现状。

## 壳层

直接证据：`src/App.tsx:24-30` 的五个导航是快速开始、工具与连接、资料库、使用记录、设置。当前页同时使用 `active` 和 `aria-current=page`（`src/App.tsx:187`）。`src/style.css:1-2` 用 `:root` 与 `:root[data-theme=dark]` 区分浅色和深色变量；没有名为 sage 的选择器，也没有 `data-theme=light` 规则。主题控件只有跟随系统、浅色、深色（`src/App.tsx:211`）。`system` 用 `prefers-color-scheme` 写成 `dark` 或 `light`（`src/App.tsx:133-140`）。

`button` 是纸色底边框，`button primary` 是强调填充（`src/style.css:5`）。空状态是 `empty-state`（`src/App.tsx:42-44`，`src/style.css:7`）。浏览器预览横幅和错误横幅在页头之前（`src/App.tsx:194-196`）。错误含 `message` 和 `action`。

布局断点是 `max-width: 900px` 和 `max-width: 680px`（`src/style.css:9-10`）。680 时侧栏变为顶栏，导航横向滚动。没有 1360 或 640 的样式规则。`tests/ui/shell.spec.ts:134-146` 把视口设为 640×760 并断言没有横向溢出；同文件断言深色和浅色持久化。没有 1360 或 900 的测试视口。

`src/components/ConfirmationHost.tsx:27-31` 把初始焦点放在取消，Escape 和取消都以拒绝应答。`src/lib/confirm.ts:29-37` 的 `confirmAction` 写入同一 `confirmationSnapshot`。`src/App.tsx:71` 的 `canLeave` 恒为 true，壳层切页不打开确认（`src/App.tsx:149-155`），切页时主区域滚回顶部并聚焦 h1。

挂载：资料库和记录始终挂载，只用 `hidden` 切换（`src/App.tsx:206-207`）。工具页在首次进入后保持挂载（`src/App.tsx:203`）。设置的迁移页同样用 `hidden` 保持挂载（`src/App.tsx:215`）。因此资料库草稿能否留在内存，可由组件未卸载解释；这是由挂载证据推出的结论，不是单独的草稿测试。

## 快速开始

直接证据：页面顺序是「管理中的工具」，然后才是 `ProjectLauncher`（`src/App.tsx:198-201`）。无管理工具时，前部空状态的主动作是「前往设置」（`src/App.tsx:200`）。浏览器预览不渲染 `ProjectLauncher`，只显示桌面应用说明（`src/App.tsx:201`）。

`src/features/home/ManagedTools.tsx:54-83` 每行是工具与安装状态、全局配置选择或状态、操作列「启动」和「编辑配置 →」。配置可写时，中列 select 调用 `switchProfile` 再 `applyRegisteredNativeProfile`。无工具时前部文案指向设置。

`src/features/home/ProjectLauncher.tsx:156-182` 的项目卡直接可见：工具 select、「启动」、次级「YOLO」。二者并列，YOLO 在没有原生参数时禁用。「项目选项」details 默认关闭，目录不可用或修复目标时强制展开；其中有改名、移除、打开目录和重新关联。另有一个默认关闭的「恢复已有会话 · YOLO 启动」details，作用对象不是已有项目。

推断：已配置时，切换全局配置是中列 select 的一次选择；启动已有项目是项目卡上的一次「启动」。二者都在 1–3 次交互内，且壳层不插入确认。没有测量 1360 或 900 宽度下项目卡是否需滚动才出现。

## 工具与连接

直接证据：`src/features/tools/ToolWorkspace.tsx:641-647` 在内容前提供「原生配置」「MCP」「Skills」，三个面板用 `hidden` 共存。命名配置与当前配置是两套控件：工具栏「当前配置」「通用配置」，侧栏「命名配置」（`src/features/tools/ToolWorkspace.tsx:657-665`）。

命名配置且已有草稿时，动作行末尾是「保存」和 primary「保存并使用」；「删除」在同一行前部且直接可见，不在 details 内。当前配置和通用配置只有「保存」。「有未保存的修改」在同一动作行。路径摘要「检测路径与升级」在编辑器之前直接可见，路径输入在其 details 内（`src/features/tools/ToolWorkspace.tsx:655`）。「高级连接选项」和其中的「更多诊断 / 发送最小请求（可能计费）」在表单 details 内（`src/features/tools/ToolWorkspace.tsx:682-688`）。应用冲突块在原生配置视图顶部（`src/features/tools/ToolWorkspace.tsx:652`）。恢复失败和「重试恢复」在路径摘要与工具栏之间（`src/features/tools/ToolWorkspace.tsx:656`）。

MCP 的 primary 是表单之后的「保存到当前 CLI」，另有「只保存到资料库」（`src/features/tools/ResourceWorkspace.tsx`）。Skills 的 primary 是已选包状态之后的「安装到当前 CLI」或「更新到当前 CLI」；导入按钮在列表顶部。冲突和恢复说明与对应动作在同一面板，但保存按钮本身在表单字段之后。

`tests/ui/resources.spec.ts` 按名称点击 MCP、Skills、保存到当前 CLI、安装到当前 CLI 等控件。它不断言这三个标签或原生配置动作行的视觉顺序。

未知：`src/components/FileConflict.tsx` 的按钮文案未纳入工具探查范围，只知道 `ToolWorkspace.tsx:701` 会渲染它。动作行在某媒体查询内改为折行，具体断点文本未摘出，也没有实测折叠后主按钮是否仍在视图前部。

## 资料库与使用记录

直接证据：`src/features/library/LibraryPage.tsx:103-134` 先是「提示词」「长期规则」和「＋ 新建」，规则视图在筛选前有「编辑当前 CLI 规则」details。列表卡片上直接有「复制全文」和「编辑」。进入草稿后列表不渲染，保存是编辑区动作；规则分发「应用到 CLI 原生规则」在已保存且非脏的已有规则之后。`active` 为 false 时不清空 draft。结合 `src/App.tsx:206` 的持续挂载，离开页面再回来时草稿仍在该组件状态中。

`src/features/records/RecordsPage.tsx:194-224` 先是会话/用量和「刷新本机记录」。筛选的 DOM 顺序会被 `RecordsPage.module.css:53` 改成可见顺序：搜索、工具、只看收藏。导出和项目关联在 details「导出与项目关联」内。收藏、复制命令和 primary「在外部终端继续」在详情头部，不在该 details 内。扫描中的同一状态行含进度和「停止扫描」。空列表文案是「没有符合条件的会话」。覆盖不完整写在「本机覆盖」details 的摘要上。

`tests/ui/records.spec.ts:44-75` 锁定续聊命令、离开到快速开始再返回后搜索词仍在，以及用量页的数字。它不断言筛选顺序、空状态或停止扫描。

## 设置

直接证据：常规页顺序在 `src/App.tsx:209-213`：管理的 CLI 复选框、`ToolIconSettings`、外观主题、仅桌面可用的 `TerminalSettings`、然后「迁移与同步 →」。图标入口是 details「自定义工具图标」（`src/features/settings/ToolIconSettings.tsx:14`）。主题三值见壳层。

`src/features/settings/MigrationSettings.tsx:116-147` 总览始终显示；导出和导入用 `hidden` 互斥。WebDAV 不参与这个互斥，始终接在后面。未连接且未编辑时，第一组是说明和「配置 WebDAV」（`src/features/settings/WebdavSettings.tsx:85-93`）。导入执行按钮是「确认恢复 N 项」，直接调用恢复，不经过 `confirmAction`。WebDAV 接受远端删除或替换时调用 `confirmAction`（`src/features/settings/WebdavSettings.tsx:67-107`），因此会打开壳层那个取消优先的对话框。

`tests/ui/migration.spec.ts` 锁定迁移标签、配置包预览、冲突比较、WebDAV 表单和冲突选择的按钮名。它不断言导出/导入互斥，也不断言「尚未连接」。

## 对下游有影响的边界

- 重排若改掉测试所点的可访问名称，现有 `tests/ui` 会失败。这些测试锁定名称和部分流程，不锁定主操作是否在视图前部。
- 需求中的 1360、900、640 与样式断点 900、680 不一致。640 只有横向溢出断言，1360 没有样式或测试证据。
- 主按钮样式已经存在，但工具页和资料库编辑的完成动作位于表单或详情之后，不在视图前部。
- 快速开始的配置切换和项目启动已经是直接控件；项目卡是否需要滚动才能看到，没有实测。
