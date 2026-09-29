---
format: execution_plan
tasks:
  - id: T1
    goal: 建立可运行的 Tauri 桌面应用、五页导航和持久化领域边界
    depends_on: []
    covers: [R1, R17, R18, R24]
    scope: [package.json, package-lock.json, index.html, tsconfig.json, tsconfig.node.json, vite.config.ts, vitest.config.ts, playwright.config.ts, src, src-tauri, tests, scripts, .gitignore, README.md, .github]
    outcomes:
      - React TypeScript 与 Rust Tauri 工程能构建，五个完整页面采用已确认设计令牌、键盘导航和浅深主题，无演示数据冒充本机状态。
      - SQLite 持久化、类型化 IPC 与系统凭据服务已建立；管理工具集合重启保持，关闭全部工具后设置仍可访问。
      - 为后续独立模块建立清晰公共类型与命令注册边界，浏览器开发模式明确说明原生能力不可用。
    test: new
  - id: T2
    goal: 五工具原生多配置、继承、保真应用与供应商连接可实际使用
    depends_on: [T1]
    covers: [R2, R3, R4, R5, R6, R17, R23]
    scope: [src-tauri, src/features/tools, src/features/home, src/lib, src/types, tests/native, tests/fixtures, package.json, package-lock.json, README.md]
    outcomes:
      - 五 CLI 按版本检测身份、配置路径、安装来源及能力；官方安装升级指引与自定义可执行路径可用，未知能力不伪装成功。
      - 每工具零到多份命名原生配置与通用配置持久保存，表单和 TOML/JSON/JSONC 使用同一草稿，多文件角色与全局项目作用域保持隔离。
      - 文件事务保留未知字段及可保留注释，检查外部冲突，自动备份、故障恢复与原生凭据保护；切换仅在成功写入后更新绑定。
      - 接口格式按原生能力配置并往返保存；供应商模型目录真实请求支持搜索、刷新、缓存、手填、分页及错误状态，不调用推理来冒充目录获取。
      - 临时目录与版本化 fixture 覆盖继承覆盖清除、多配置切换、无关字段保真、非法文本、写入中断、冲突和模型请求竞态。
    test: extend
  - id: T3
    goal: 项目外部启动与原生托盘使用同一份成功应用状态
    depends_on: [T2]
    covers: [R7, R18, R22, R24]
    scope: [src-tauri, src/features/home, src/features/settings, src/lib, src/types, tests/launch, tests/ui, README.md]
    outcomes:
      - 项目身份和本机目录映射持久化，用户选择的终端以正确工作目录启动或登录 CLI，含中文空格特殊字符路径安全传递；首页启动与恢复提供普通或 YOLO 显式选项，按原生版本能力生成参数，默认普通，不改全局权限。
      - 原生托盘列出管理工具与命名配置、作用范围及最近项目，切换与窗口一致，失败保留旧状态并打开修复入口。
      - 关闭窗口留托盘、显式退出、单实例唤醒与托盘不可用保持窗口可访问均可观察；外部 CLI 不随应用退出终止。
    test: extend
  - id: T4
    goal: 资料库与原生 MCP Skills 规则形成可复用的真实管理流程
    depends_on: [T3]
    covers: [R8, R9, R10, R11]
    scope: [src-tauri, src/features/library, src/features/tools, src/lib, src/types, tests/resources, tests/ui, README.md]
    outcomes:
      - 模板和规则支持持久化 CRUD、分类项目筛选、全文搜索和完整复制；编辑页保留草稿，规则覆盖展示真实差异并集中确认。
      - MCP 按各工具原生格式读取编辑启停并多目标分发，逐目标结果可重试，不支持能力明确显示。
      - Skills 从本地目录或明确来源导入完整资源，按原生发现路径安装更新移除；校验路径与依赖，冲突和更新失败保留可用原副本。
    test: extend
  - id: T5
    goal: 本地会话浏览续聊与用量统计可追溯到原始记录
    depends_on: [T4]
    covers: [R12, R13]
    scope: [src-tauri, src/features/records, src/lib, src/types, tests/history, tests/fixtures, tests/ui, README.md]
    outcomes:
      - 已支持版本的本地会话可索引搜索、查看、收藏、导出和外部续聊，提供按终端正确引用并包含所选普通或 YOLO 模式的原生恢复命令一键复制，复制不执行且无密钥；损坏记录隔离，刷新更新删除不重复计数。
      - 工具模型项目日期筛选与 token 输入输出缓存口径可靠，费用标明价格来源和估算属性，未知与统计覆盖如实显示。
      - 原始会话只读，收藏统计保持本地；未知格式不伪造内容或用新会话冒充恢复。
    test: extend
  - id: T6
    goal: 加密配置包与 WebDAV 让新设备恢复资料且不覆盖本机身份
    depends_on: [T5]
    covers: [R14, R15, R16, R17, R24]
    scope: [src-tauri, src/features/settings, src/lib, src/types, tests/migration, tests/sync, tests/ui, README.md]
    outcomes:
      - 统一迁移白名单包含命名配置通用继承接口格式 API 密钥资料资源和管理偏好，排除 OAuth 会话历史统计及设备绝对路径和活动绑定。
      - 带版本加密包跨全新数据目录导入，预览新增更新冲突和待关联目录；取消错误口令坏包不变，重复导入幂等，凭据由系统保护。
      - WebDAV 配置一次可后台同步，独立修改合并、同项和删除冲突保留双方，有限重试、版本完整性与凭据轮换失败不丢数据。
      - 接收远端资料不自动切本机活动配置，所有迁移同步失败有真实状态与恢复动作。
    test: extend
  - id: T7
    goal: 集成已确认的全部页面并完成可复验的桌面交付候选
    depends_on: [T6]
    covers: [R1, R2, R3, R4, R5, R6, R7, R8, R9, R10, R11, R12, R13, R14, R15, R16, R17, R18, R22, R23, R24]
    scope: [src, src-tauri, tests, scripts, package.json, package-lock.json, playwright.config.ts, .github, README.md, docs/verification]
    outcomes:
      - 五页真实功能整合，首页与托盘切换不超过三次点击，原生配置直接可见，完整子页和短弹窗边界符合确认设计。
      - 类型检查、领域故障测试、浏览器交互和生产构建通过，Windows 桌面候选可运行并提供构建安装说明。
      - 发布验证记录真实系统架构 CLI 版本与原生行为；三平台十五组合和托盘现场缺失时明确保持未验收，不用浏览器或交叉编译冒充通过。
    test: extend
delivery_verification:
  frontend:
    command: npm run verify
  native:
    command: cargo test --manifest-path src-tauri/Cargo.toml
  desktop:
    command: npm run tauri build -- --no-bundle
  platform_evidence:
    command: node scripts/verify-platform-evidence.mjs
---
# 执行计划

依据已确认的 02 方案，按可运行应用、原生配置、托盘启动、资料、历史、迁移和集成交付推进。当前仓库只有设计资料，没有可复用产品测试，因此先建立测试基础，随后扩展对应行为验证。所有任务串行依赖以保护公共 IPC、原生事务与页面集成边界；Worker 可由工作流调度，但不得跨任务改动未授权文件。

数据与安全契约以 02 ADR-03/04/07/08/11/12 为唯一方案来源，界面以 ADR-09 和 docs/design/cliora-preview.html 为视觉依据。正式产品不得复制原型的演示反馈充当成功。新增依赖固定到锁文件。R19–R21 为排除边界，不创建运行工作台或代理。

Windows 是当前可用现场。macOS 14 arm64 与 Ubuntu 24.04 x64 的原生验收证据须来自真实现场；缺失时继续完成本机可验证工作并保留发布阻断，不编造通过记录。
