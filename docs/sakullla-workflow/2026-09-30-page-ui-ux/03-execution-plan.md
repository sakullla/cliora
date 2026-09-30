---
# 计划字段仅在此 YAML 中填写。
format: execution_plan
tasks:
  - id: home-band
    goal: 宽于 680 时，快速开始同时显示工具状态和至少一个项目启动，且切换已保存配置与普通启动不新增确认。
    depends_on: []
    covers: [R1, R2, R3]
    scope:
      - src/App.tsx
      - src/style.css
      - src/features/home
      - tests/ui/shell.spec.ts
    outcomes:
      - 1360×1000 与 900×1000 的浅色和深色下，不滚动即可看到一个已管理工具的状态和至少一个项目的「启动」。
      - 640×760 下「启动」仍在「项目选项」之前，五个导航名称可辨认。
      - 全局配置 select 和「启动」不打开确认框；主题选项仍只有跟随系统、浅色、深色。
      - 主操作可被键盘聚焦，焦点轮廓可见。
    test: extend
  - id: tool-actions
    goal: 工具与连接三个视图的现有完成动作位于长表单之前，删除不成为强调动作，冲突与恢复仍留在同一视图。
    depends_on: []
    covers: [R1, R2]
    scope:
      - src/features/tools
      - tests/ui/resources.spec.ts
    outcomes:
      - 命名配置的「保存并使用」和当前配置的「保存」出现在对应表单字段之前；「删除」可见但不是 primary。
      - MCP 的「保存到当前 CLI」和 Skills 的「安装到当前 CLI」出现在各自表单之前。
      - 「发送最小请求（可能计费）」仍在「更多诊断」内；普通保存不新增确认。
      - 应用冲突、恢复失败与对应处理动作仍在同一视图。
    test: extend
  - id: library-actions
    goal: 资料库编辑把复制和保存放在正文之前，分发仍只在已保存且非脏时出现，离开页面后草稿还在。
    depends_on: []
    covers: [R1, R2]
    scope:
      - src/features/library
      - tests/ui/library.spec.ts
    outcomes:
      - 卡片上的「复制全文」和「编辑」无需先展开。
      - 编辑态的「保存」和「复制全文」位于正文之前。
      - 「应用到 CLI 原生规则」仅在已保存且没有未保存修改时出现。
      - 离开资料库再返回，未保存正文仍在；删除仍只有一个取消优先的确认。
    test: new
  - id: records-order
    goal: 使用记录的搜索、工具和收藏按文档顺序直接呈现，导出留在披露内，续聊动作仍在详情旁。
    depends_on: []
    covers: [R1, R2]
    scope:
      - src/features/records/RecordsPage.tsx
      - src/features/records/RecordsPage.module.css
      - tests/ui/records.spec.ts
    outcomes:
      - 可见顺序为搜索、工具筛选、只看收藏，且该顺序不依赖与文档顺序相反的样式 order。
      - 「导出与项目关联」仍在 details 内；「在外部终端继续」在详情旁且为 primary。
      - 离开页面再返回，搜索词仍在；续聊仍不因复制命令而启动。
    test: extend
  - id: migration-exclusive
    goal: 迁移与同步的总览保持可见，导出、导入和 WebDAV 连接编辑一次只展开一项。
    depends_on: []
    covers: [R1, R2]
    scope:
      - src/features/settings/MigrationSettings.tsx
      - src/features/settings/MigrationSettings.module.css
      - src/features/settings/WebdavSettings.tsx
      - tests/ui/migration.spec.ts
    outcomes:
      - 展开导出时，导入表单和 WebDAV 连接编辑不可见；展开 WebDAV 编辑时，导出和导入表单不可见。
      - 总览仍在；未连接时由总览进入连接编辑，而不是一开始展示空表单。
      - 「确认恢复」不再打开第二个确认框；接受远端删除仍只有一个对话框，且初始焦点在取消。
    test: extend
delivery_verification:
  ui:
    command: npm test
---
# Execution Plan

架构决策只以 `02-technical-solution.md` 为准。R4 是排除项，没有对应任务。

`home-band` 是壳层宽度、主题色值和 `src/App.tsx` 结构的唯一写入者。其余任务不改这些文件，主按钮继续使用 `src/style.css` 里已有的 `button primary`。五个任务没有依赖，写入范围不重叠，也不新增共享组件。

`records-order` 只把已经可见的筛选顺序落实到文档顺序，不改变续聊、收藏或扫描行为。资料库目前没有 UI 测试，所以 `library-actions` 新增 `tests/ui/library.spec.ts`。

任一任务若必须新增确认、新入口，或卸载资料库、工具页、迁移页才能完成，应停止并修订 02，不在任务内另做交互。正式验证只有 `delivery_verification.ui`。
