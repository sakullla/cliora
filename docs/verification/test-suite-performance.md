# 测试与截图库耗时（R15 / D14）

本记录对应工作流任务 T8。所有数字都来自同一台机器：Windows，Intel i7-9700F（8 核 8 线程），Playwright 1.63.0，chromium-headless-shell。测量时机器上还有其他常驻进程：运行中的 Cliora 桌面窗口（msedgewebview2）、Telegram，另有一个 agent 进程，它们空闲时合计占用约 1–2.4 个核。Playwright 全量运行期间 CPU 一直是满载（LoadPercentage 每 20 s 采样一次，几乎全部为 100），所以总耗时主要取决于 CPU 竞争，各次之间有 ±10% 的噪声。另一个会话编译 Rust（rustc 占用 3–5 核）时测到的结果单独标注，不计入对比。

改动前：HEAD `ad225d90`，`npm run build` 一次，之后各命令跑一次。改动后分两轮：第一轮（提交 026c5330）是项目拆分、截图并发和变体删减；第二轮（T8-A2，本次）加入共享页面夹具，见「改动」第 6 项。

## 结果

| 命令 | 改动前 | 第一轮（026c5330） | 第二轮（共享页面） | 第二轮比例 |
| --- | --- | --- | --- | --- |
| `npm run test`（Playwright 全量） | 768 s（1246 个用例；1 个失败：「40 个终端」） | 435 s（0.57） | 365 s / 428 s / 359 s（1236 个用例） | 0.47 / 0.56 / 0.47 |
| `npm run test:unit` | 6.5 s | 7.8 s | 未改动，未复测 | — |
| `verify-ui-captures --skip-build --only workbench` | 28 s（12 张） | 8 s / 8 s（11 张） | 未改动，未复测 | 0.29 |
| `verify-ui-captures --skip-build`（全量画廊） | 88 s | 68 s | 未改动，未复测 | 0.77 |

第二轮三次全量的机器负载（`node scripts/test-ui.mjs`，8 个 worker；「后台」是运行期间非测试进程平均占用的核数，按进程 CPU 时间差统计，不含运行中途结束的进程，所以偏低；「开始前」是开始前 10 s 整机忙碌的核数）：

| 次序 | 墙钟 | 结果 | 开始前 | 后台 | 主要后台进程 |
| --- | --- | --- | --- | --- | --- |
| full-shared-1 | 365 s | 1234 通过，1 失败（`remote-write-recovery`，见下文，已修复） | 3.2 核 | 1.4 核 | Cliora 桌面窗口（msedgewebview2）1.2 |
| full-shared-2 | 428 s | 全部通过 | 3.1 核 | 2.1 核 | msedgewebview2 1.2、另一项目的 Rust/Android 构建（rustc、cargo、java） |
| full-shared-3 | 359 s | 全部通过 | 3.3 核 | 1.6 核 | msedgewebview2 1.2、rustc 0.2 |

**目标达到。** 后台负载与改动前那次测量（约 1–2.4 核）相当的两次（full-shared-1、3）为 359–365 s，不超过改动前 768 s 的一半（≤ 384 s）。full-shared-2 运行时另一个项目在做 Rust/Android 构建，后台超过 2 核，结果是 428 s（0.56）；这个数字如实列出，但不能作为同等条件下的对比。

同期还在同一台机器上用改动前的代码（`git archive ad225d90` 解出到临时目录、单独构建）复测了两次，与第二轮交替进行：

- base-1：1023 s。开始前整机已有 7.7 核在忙（另一项目的 Android 构建正处于高峰），不能用于对比。
- base-2：824 s，后台 1.45 核。紧接着的 full-shared-3 为 359 s（后台 1.6 核），同期比例 0.44。

两次都只有「40 个终端」失败（改动前就存在，见下文）。之后机器负载过高，按 Owner 指示停止了所有全量耗时测量。

## 改动前的慢点

### Playwright：最慢的 20 个文件（各用例耗时之和）

| 文件 | 用例数 | 合计 s | 最长 s |
| --- | --- | --- | --- |
| workbench-terminal.spec.ts | 145 | 426.8 | 28.3 |
| resources.spec.ts | 85 | 209.3 | 4.9 |
| config-dialog.spec.ts | 92 | 193.9 | 5.8 |
| memory.spec.ts | 41 | 111.4 | 6.4 |
| workbench-host.spec.ts | 33 | 107.9 | 9.0 |
| remote-hosts.spec.ts | 31 | 96.7 | 5.9 |
| plugins.spec.ts | 40 | 93.1 | 4.1 |
| workbench-acp-composer.spec.ts | 33 | 92.2 | 7.9 |
| workbench-twiglane.spec.ts | 32 | 78.3 | 3.7 |
| workspace-projects.spec.ts | 38 | 77.6 | 4.8 |
| records.spec.ts | 30 | 75.8 | 5.5 |
| workbench-acp.spec.ts | 21 | 65.9 | 4.3 |
| prompt-secrets.spec.ts | 19 | 63.9 | 5.9 |
| shell.spec.ts | 24 | 62.2 | 6.8 |
| workbench-acp-timeline.spec.ts | 20 | 60.8 | 4.3 |
| session-paste-upload.spec.ts | 26 | 59.2 | 3.6 |
| home-tools.spec.ts | 37 | 58.6 | 5.4 |
| oauth-accounts.spec.ts | 26 | 52.3 | 8.3 |
| library-distribute-result.spec.ts | 25 | 51.5 | 2.6 |
| library-remote-rules.spec.ts | 15 | 46.2 | 5.4 |

所有用例耗时之和为 3017 s，8 个 worker 的墙钟时间为 766 s。

### Playwright：最慢的 20 个用例

| 用例 | s |
| --- | --- |
| workbench-terminal:2467 forty live terminals keep background output within the workbench memory budget（失败） | 28.3 |
| workbench-terminal:895 live output and idle waiting keep distinct activity icons in every workbench slot | 10.1 |
| workbench-host:836 host switching restores each host last session without relaunching or replaying its terminal | 9.0 |
| oauth-accounts:435 picker login supports retry, cancellation and late identity suppression | 8.3 |
| workbench-acp-composer:1327 prompts still queued when the conversation ends stay readable and copyable | 7.9 |
| workbench-webgl:65 real WebGL cleanup releases closed terminals and both blink timers | 7.8 |
| skills-manifest:356 a saved remote skill preserves a stale draft conflict | 7.2 |
| shell:882 workbench separates two sessions, marks a self-exit | 6.8 |
| ui-polish:164 long labels, search icon, switcher, and the five pages stay quiet | 6.8 |
| workbench-terminal:3131 double-clicks and Mod+Shift+B toggle the rail and focus mode | 6.5 |
| workbench-terminal:2495 late output from many unmounted sessions has a bounded retained heap | 6.4 |
| memory:1069 a long memory keeps the body in view | 6.4 |
| workbench-terminal:1599 font zoom, terminal colours, and a page that never scrolls sideways | 6.3 |
| workbench-terminal:4003 a covered session rail repeats the waiting count | 6.3 |
| memory:732 1000 memories use bounded batches | 6.2 |
| workbench-terminal:978 English activity states preserve status and title geometry at 1280px | 6.2 |
| shell:1126 workbench modal dialog scales to 40+ CLIs | 6.2 |
| workbench-host:684 a selected session awaiting listing never displays input in the previous terminal | 6.2 |
| workbench-terminal:4187 a temporary look keeps the selected terminal scroll, selection and input suspended | 6.0 |
| settings-scroll:4 settings modal keeps wheel inside the active category | 5.9 |

### 墙钟时间花在哪里

8 个 worker 槽位中，有 6 个在约 336 s 时已经完成。剩下的时间全部花在 `workbench-terminal.spec.ts` 上：这个文件用 `test.describe.configure({ mode: 'default' })` 固定在一个 worker 上串行执行，而且它的 SwiftShader `launchOptions` 改变了 worker hash，所以在调度队列里排在所有默认 hash 的文件之后，约 332 s 才开始。145 个用例在单个 worker 上又跑了约 430 s，其中包括「40 个终端」失败后重启 worker 的时间。这条串行尾巴约占总时间的 55%。

### 截图：改动前最慢的 20 个场景

`--only workbench` 改动前串行执行 12 个场景（同一预览服务，单页面依次截取）：

| 场景 | s |
| --- | --- |
| workbench-task-states-light | 5.0 |
| workbench-restore-mixed-dark | 3.3 |
| workbench-composer-dark | 3.3 |
| workbench-task-dialog-dark | 3.0 |
| workbench-worktrees-many-dark | 2.9 |
| workbench-ended-light | 2.6 |
| workbench-dialog-light | 2.1 |
| workbench-active-light | 1.8 |
| workbench-acp-tools-light | 1.6 |
| workbench-acp-conversation-dark | 1.6 |
| workbench-remote-disconnected-light | 1.5 |
| workbench-empty-dark | 1.1 |

全量画廊的其余区域单独运行时的耗时如下（每项都包含约 1 s 的预览服务启动；这些区域的脚本本期没有改动）：features 14.3 s（9 张）、mcp 9.3、memory 8.9、prompts 7.9、skills 7.0、rules 6.9、sync 6.9、pages 6.1、rule-results 6.0、home 5.9、agents 5.7、plugins 5.7、write-recovery 5.2、quota 5.1、sessions 4.9、connections 4.4、records 4.3、remote-hosts 4.2、projects 3.2。场景本身耗时很短，主要是等待。改动前 `--only workbench` 的 28 s 中，各场景耗时之和约 30 s，场景串行执行是主要成本。

## 改动

1. **`playwright.config.ts`：拆分项目，调整调度。** `workbench-terminal.spec.ts` 拆成两个项目并排在最前，调度器会先派发它们：
   - `terminal-gpu`：只运行文件中两个 WebGL 组（`product WebGL input integration`、`session switching with the production renderer`，共 14 个用例），使用 SwiftShader，1 个 worker。
   - `terminal`：运行其余 131 个用例，最多 `PLAYWRIGHT_TERMINAL_WORKERS` 个 worker（默认 3）。
   - `ui`：其余所有文件，不变。

   原来的约束是「真实终端渲染器共享软件 GPU，不能互相抢占」，现在由项目的 worker 上限保证，不再依靠整文件串行。文件中删除了 `mode: 'default'`。
2. **SwiftShader 只用于 WebGL 组。** 在 webdriver 下应用本来就用 DOM 渲染终端（`SessionTerminal.tsx` 中 `navigator.webdriver !== true` 才启用 WebGL）。用 SwiftShader 启动浏览器后，其余 131 个 DOM 用例的 CPU 时间约增加一倍：同样 3 个 worker 并行时，chrome 占用 5.7 核对 1.7 核，用例耗时之和 713 s 对 370 s。WebGL 组新增 `requireSoftwareGpu()`：如果它们因为标题改动没有落在 `terminal-gpu` 项目，就直接失败，不会悄悄退回到不用软件 GPU 的环境里运行。`workbench-webgl.spec.ts` 保持整文件使用 SwiftShader。
3. **工作台截图并发。** `scripts/capture-workbench.mjs` 中的场景本来就各自打开独立的 context，现在最多 4 个页面同时截取（`CLIORA_WORKBENCH_PAGES`，设为 1 恢复串行）。manifest 按请求顺序写入。`--performance` 的测量场景（`workbench-remote-stream-*`、`workbench-acp-large-perf*`）会先等其他场景全部结束，再单独执行，测量条件不变，也仍然不在默认截图库里运行。对比串行和并发截出的 PNG：并发与串行之间的差异，和两次串行之间的差异属于同一类，都是会话栏里几十个像素的相对时间和活动标记。
4. **删减**（见下节）：Playwright 删去 10 个变体，默认截图删去 1 个场景。
5. **固定等待**（见「固定等待」一节）。

6. **共享页面（第二轮）。** 新增 `tests/ui/sharedPage.ts`，详见下一节。

`capture-product-ux` 的区域并发数保持默认 2。试过 4：一次通过，用时 39 s；另一次 `remote-hosts` 截图在负载下失败。所以默认值不变。

## 共享页面（第二轮）

### 为什么不是合并用例

审查建议把共用页面的用例合并成带 `test.step` 的大用例。先用探针测了固定成本到底花在哪里（同一台机器，8 个 worker，各 160 次应用加载，按整机 CPU 计）：

| 方式 | 核秒 / 160 次 |
| --- | --- |
| 每个用例新建 context 和页面后加载 | 209–278 |
| 同一 context，每次新开页面 | 193–228 |
| 同一页面重新导航（中间 `about:blank` 并清空存储） | 107–146 |
| 160 个独立用例共用 worker 级页面，用例之间复位 | 107–112 |

成本主要在「新页面」（新的渲染进程和冷启动），不在 context，所以第一轮记录的「共享 context 只省约 10%」与此一致。合并用例时，段与段之间要隔离 mock 状态就必须重新导航，单次只省约 0.5 核秒，要达到目标约需合并 500–600 个用例，改动面很大，而且不重载的合并大多会有状态污染。经 Owner 确认，改为共享页面夹具：每个用例仍是独立用例，标题、断言、报告都不变，只是底下的页面被复用。

也试过 Playwright 自带的 `reuseContext`。它的复位会逐个导航到访问过的 origin 来恢复存储状态，探针中 160 次为 149–206 核秒，只省一半左右的收益，所以没有采用，改为自己做复位。

### 做法

`tests/ui/sharedPage.ts` 导出 `test`、`expect` 和 `freshPage(reason)`。从这里导入 `test` 的文件，每个 worker 只开一个 context 和页面；context 选项（`_combinedContextOptions`）变化时重新创建。夹具使用了 `@playwright/test` 的私有 fixture `_contextFactory` 和 `_combinedContextOptions`，版本固定为 1.63.0，升级 Playwright 时需要核对。

每个共享用例结束后，夹具会撤销用例添加的东西：

- page 和 context 上的 init script、binding、exposeFunction（包装这些方法，记录返回的 Disposable 后逐个 dispose）；
- page 和 context 的全部 route；
- 用例在 page 上添加的监听器；
- 应用 origin 的 localStorage、sessionStorage（先在文档里清，再用 CDP `Storage.clearDataForOrigin` 清 `all`，覆盖卸载时的写入）、cookie、IndexedDB 和 cache storage；
- viewport 和 media 仿真，鼠标移到视口外；
- 最后停在 `about:blank`。

无法可靠撤销的内容（`page.clock`、`grantPermissions`、第二个页面或 context、按住未松开的键、下载、改过的默认超时、`test.use` 改的 context 选项）不进入共享页面：用例用 `freshPage('原因')` 标注，或者整个文件继续从 `@playwright/test` 导入。

**复位自检。** 每个共享用例开始前检查上一次复位，不满足就让当前用例失败，并提示用 `PLAYWRIGHT_SHARED_PAGE=0` 对比：

- 上一个用例结束时，夹具以「用例自己添加」的方式种下哨兵 init script、哨兵 binding 和哨兵 route。复位后，它们必须都已移除：在 `about:blank` 上检查 init script 和 binding 是否还在全局里；从 `about:blank` 跨源请求哨兵地址，只有残留的 route 会带 CORS 头应答；
- 页面只有一个，并且在 `about:blank`；
- 没有残留的监听器和 cookie；
- viewport、`innerWidth/innerHeight`，以及配色、减少动效、强制颜色、对比度的媒体查询与项目默认值一致；
- 用例加载的第一个文档在执行任何用例脚本之前，localStorage 和 sessionStorage 都为空。用 binding 上报，在用例结束时断言。

反向对照（临时探针，已删除）：故意绕过跟踪添加一个设置哨兵全局变量并写 localStorage 的 init script，下一个用例会以「`__clioraSharedPageSentinel` from the previous test is still installed」失败；在 `about:blank` 上，残留的哨兵 route 应答 `leaked`，去掉后为 `blocked`。

`PLAYWRIGHT_SHARED_PAGE=0` 时，`test` 就是 `@playwright/test` 的 `test`，每个用例都新建 context 和页面。

### 接入范围

- 接入：`ui` 项目中除下面两个文件外的全部 75 个 spec 文件，共 1074 个用例，其中 1056 个使用共享页面。
- 用 `freshPage` 标注、继续使用新页面的有 18 个用例：
  - `page.clock`：accounts-reading「account polling waits …」，home-tools「a transient version failure …」和「missing installations …」，library-tags「library search debounces …」，plugins「plugin views defer …」，resources「MCP removal notice expires …」和「library success notices expire …」，secret-approval「parallel callers …」，session-reader「custom dates apply …」和「the session filter bar …」，usage-query「quota polling joins …」，workbench-titlebar「the running time stops …」，workbench-twiglane「worktrees are read only …」和「an unanswered review …」；
  - `grantPermissions`（剪贴板）：remote-hosts「the picker context menus …」；
  - 第二个 context：ui-polish「shell and shared feedback …」；
  - CDP 堆测量：omp-configuration「OMP large-list performance benchmark」（默认跳过）；
  - `test.use({ locale })`：i18n 的「英文系统环境」组（1 个用例）。
- 不接入的文件：`reading-layout.spec.ts`（用例自己用 `browser.newContext` 建 context）、`workbench-webgl.spec.ts`（SwiftShader 启动参数和 `page.clock`）、`workbench-terminal.spec.ts`（T9 还要修改这个文件，且含 GPU 组、「40 个终端」、`keyboard.down`、`grantPermissions`；本次没有改动）。

改动的 spec 文件中，除导入语句和 18 处 `freshPage` 标注外，只有一处修改，见下一小节。没有删除或放宽断言。

### full-shared-1 的失败

`remote-write-recovery`「a failed fault-triggered journal discovery survives closing and restart then discovers the original receipt」超时：`page.reload()` 后，「远程写入与恢复」对话框已经自己打开，挡住了对「写入恢复」按钮的点击。

- 原因是用例里的竞态：用例在 reload 后看到按钮就把 mock 的 `listFails` 改为 `false`。如果这时重启后的应用还没做第一次回执发现，这次发现就会成功，应用会自动打开对话框。共享页面的渲染进程是热的，reload 更快，竞态更容易出现：单独运行 `--repeat-each=15` 时，共享模式 2/15 失败，新页面模式 0/15。
- 修复：reload 后先用 `expect.poll` 等重启后的应用完成第一次（失败的）发现，再改 `listFails`。这与同一用例前半段的写法相同，只增加一个状态等待，断言不变。修复后共享模式 `--repeat-each=15` 两轮各 210/210 通过，新页面模式 210/210 通过。

### 防污染验证

- 共享模式：full-shared-1、2、3 三次全量（8 个 worker）。除上面已修复的竞态外全部通过。此外，接入后先单独运行过一次共享模式下的 `ui` 项目，1090 个全部通过。
- `PLAYWRIGHT_SHARED_PAGE=0`（每个用例新页面，`PLAYWRIGHT_WORKERS=3`）全量一次：1234 通过，1 失败——`skill-plugin-source`「Skill search also matches the plugin a skill comes from」在 `page.goto('/')` 后 30 s 内一直没有出现导航栏。这就是下文「验证记录」中描述的空白页环境类失败，发生在不使用共享页面的模式下。这个文件随后单独复跑（同一模式），3/3 通过。
- 打乱用例相邻顺序的运行（`--repeat-each=2`，分别用 1 个和 8 个 worker）：因机器负载过高（用户电脑卡死），按 Owner 指示未执行。
- `npm run verify` 两次连续通过：由 Owner 在最终交付时执行，本次没有运行。

## 删减清单与覆盖去向

删减只针对「同一行为在多个主题、语言或尺寸下重复」且该维度不会影响断言结果的变体。没有删除密钥与安全、adapter 注册约束、IPC 契约或已修复 bug 的回归用例。有两条已修复 bug 的回归用例被缩减但保留：`reading-layout`「edit MCP reading」（来自 d677a3e2）和 `workbench-host`「disconnected sessions continue from the banner …」（来自 7d7cc2c3），见下表。例如：`session-paste-upload` 按 15 个 adapter 逐一验证附件载荷，属于 adapter 约束，保留；`config-dialog` 的「配置列表缩短后搜索仍可用」（light/dark）来自修复提交 21e4065a，两个变体都保留。

| 删去的用例 | 覆盖去向 |
| --- | --- |
| reading-layout.spec.ts「edit MCP reading」12 个组合中的 6 个（**缩减但保留的回归用例**：这个用例来自修复提交 d677a3e2，文字对比度与可读性）：light en 1160x780、dark zh 1160x780、light zh 720x560@1、dark en 720x560@1、light en 720x560@1.5、dark zh 720x560@1.5 | 同一用例改为两两覆盖，保留 light zh 1160、dark en 1160、light en 720@1、dark zh 720@1、light zh 720@1.5、dark en 720@1.5。主题×语言、主题×尺寸、语言×尺寸的每一对组合仍然至少运行一次，对比度、截断、重叠和边框的断言都不变。 |
| plugins.spec.ts「plugin workspace stays within the viewport at target widths in dark theme」 | 同一用例的 light 变体仍按 1360/900/640 检查横向溢出和列表/详情切换。配色方案不影响宽度。 |
| workbench-acp-timeline.spec.ts「the conversation fits a 720px window and a split in the dark theme」 | light 变体仍检查 720px 与分屏下没有横向溢出。暗色主题的外观由截图库中的 `workbench-acp-conversation-dark` 等场景覆盖。 |
| workbench-host.spec.ts「disconnected sessions continue from the banner … at 900px in dark」和「… at 640px in light」 | 保留「900px light」和「640px dark」两个变体：每个宽度仍检查一次（这条回归针对的是窄屏遮挡，来自 7d7cc2c3），两种主题也都还在。用例先设置 `data-theme`，再检查按钮位置；主题不影响布局。 |
| 截图默认场景 `workbench-dialog`（空的新建会话对话框） | `workbench-task-dialog` 截取的是同一个对话框填写项目、提示词并选择新建工作树后的状态。空对话框仍在 `--full` 和 `--only 'workbench-dialog-*'` 中。 |

用例数：1246 → 1236。

## 「40 个终端」用例

`forty live terminals keep background output within the workbench memory budget`（`workbench-terminal.spec.ts`）

- **现象**：改动前的全量运行中，它在 20 s 等待内只看到 10/40 个终端回复。单独运行同样不稳定：连续三次分别得到 5/40、8/40，以及一次 24.5 s 通过。
- **定位**：用 CDP Profiler 采样（0.5 ms 间隔）。从注入输出到 40 个终端全部回复，单独运行耗时 28.4 s。按 self time 统计：
  - `WidthCache._measure`：26.1 s（另一次采样为 38.1 s，占绝大部分）；
  - `getBoundingClientRect`：0.86 s；
  - xterm 解析与打印（`print`、`parse`、`createRow` 等）合计不到 0.3 s。

  `_measure` 的调用栈：`SelectionService._refresh`（rAF）→ `Emitter.fire/_deliver` → `CoreBrowserTerminal` 中 `onRequestRedraw` 的监听 → `RenderService.handleSelectionChanged` → `DomRenderer.handleSelectionChanged` → `DomRenderer.renderRows` → `DomRendererRowFactory.createRow` → `WidthCache.get` → `WidthCache._measure`。
- **根因（产品侧）**：隐藏窗格的终端使用 xterm 的 DOM 渲染器。窗格是 `display:none`，测量元素的 `offsetWidth` 为 0，而 `WidthCache.get` 只缓存大于 0 的宽度（`@xterm/xterm/src/browser/renderer/dom/WidthCache.ts` 第 134–165 行），所以每一行的每个字符都会重新测量，每次测量都触发一次同步重排。`RenderService.handleSelectionChanged` 直接调用渲染器（`RenderService.ts` 第 303–307 行），不检查渲染器是否因不可见而暂停，所以隐藏终端每帧都会重绘全部行。40 个窗格、每个 1600 行输出时，主线程上的重排约 26 s。在用例引入时的提交 02707f25 上重现，结果相同（28.4 s），说明这是用例本身的负载，不是后续改动造成的回退。本次没有查明是什么触发了选区重绘请求（候选：`clearSelection` 在 `onResize` 行数变化时被调用，或 `_handleTrim`），留给 T9 确认。
- **处理（过渡）**：T8 不改产品代码。用例加 `test.slow()`，轮询时限从 20 s 放宽到 75 s；输入数据（40 × 1600 行）和堆预算断言（< 48 MB）都不变。`--repeat-each=5`（terminal 项目，3 个 worker 并行）5/5 通过，每次 33.6–36.0 s。在全量运行中，这个用例大约要 64 s。
- **后续**：根因由 T9（R16）在产品代码中修复。修复后去掉 `test.slow()` 和放宽的时限，恢复默认时限。

## 固定等待

`tests/ui` 中原有 46 处 `waitForTimeout`，合计约 13 s。改为状态等待的有两处：

- `workbench-terminal`「a running row stays in its group while its output starts and pauses」：原来两轮各等 1700 ms，现在先等行图标 `data-tone` 变成 `live`，再等它不再是 `live`，然后检查该行仍在原分组。
- `workbench-terminal`「OSC 9;4 progress fills the status slot …」：原来等 1700 ms 后再断言标题，现在直接用自动等待断言标题变为「· 等待输入」。

其余 44 处都是有意保留的「这段时间内不应发生某事」窗口，改成状态等待会削弱断言，所以保留：

- 不应再有 rAF（keyboard-flow）；
- 不应再扫描（records）；
- 不应 resize 或 launch（临时查看）；
- 输入法提交后不应再写入（workbench-terminal）；
- 闪烁计时器保持为 0（workbench-webgl）；
- 「旧的 1.5 s 字节超时已过仍保持 live」；
- 大会话性能测量的稳定间隔（workbench-acp-large，属于 T6 的测量语义）。

由于全量运行受 CPU 限制，等待期间 CPU 会让给其他 worker，所以固定等待对墙钟时间的影响很小。

## 第一轮的差距分析（已由第二轮解决）

以下是第一轮结束时的分析，第二轮的共享页面正是针对其中「每个用例的固定成本」。

Playwright 全量运行受 CPU 限制：

- 单个用例的固定成本约为 0.9 CPU 秒：每个用例都新建 context 并完整加载应用；只加载应用、不做任何操作的 160 个探针用例，平均每个占 chrome 0.68 核秒、node 0.2 核秒。
- 交互操作再增加约 1.4 核秒。
- 调整 worker 数没有帮助：8、10、12 个 worker 时墙钟相同，6 个 worker 更慢。

本期去掉了串行尾巴和 DOM 用例的 SwiftShader 开销后，各槽位的结束时间已经基本对齐（各槽位相差几秒以内）。剩下的总时长基本等于总 CPU 工作量除以可用核数。

试过但没有采用的方案：

- 让 Playwright 请求 identity 编码（省去 vite preview 的 gzip）：每次加载约省 0.06 核秒。但启用后的那次全量运行中出现了一次空白页超时，为稳妥起见撤回。
- 各种 Chromium 参数（`--disable-gpu`、`--num-raster-threads=1`、`--js-flags=--lite-mode/--no-opt`、`--disable-gpu-compositing` 等）：在噪声范围内没有收益。
- 每个 worker 共享一个 context：只省约 10% 的 chrome CPU，而且会破坏 locale、权限和存储的隔离。

要再减 6–15%，需要删去或合并约 100 个用例的页面加载。逐条核对后，剩下的大多是有具体行为或回归依据的用例，所以没有为凑数而删减。（第二轮没有删减用例，而是让页面加载变便宜，见「共享页面」。）

## 验证记录

以下是第一轮的 verify 记录；第二轮的验证见「共享页面 → 防污染验证」。

`npm run verify` 共运行 4 次，每次都包含 369 个 Node 测试，全部通过：

| 次序 | Playwright 结果 | 失败用例 | 当时负载 |
| --- | --- | --- | --- |
| 1 | 2 个失败 | `workbench-acp-composer`「the unified ACP composer card …」，`goto` 后 30 s 内没有出现导航栏；`workbench-acp-large`「opening or folding a segment above the viewport keeps the reading position」，位移 37 px | 另一会话正在编译 Rust（rustc 3–5 核） |
| 2 | 1235 通过 | — | — |
| 3 | 1235 通过 | — | — |
| 4 | 1 个失败 | `workbench-terminal`「English activity states … at 720px」，`goto` 后 30 s 内没有出现导航栏 | — |

第 2、3 次是同一代码上连续两次全部通过。改动后的正式测量 `npm run test` 也全部通过（435 s）。

「`goto` 后应用一直没有渲染出导航栏」这类失败，在 7 次改动后的全量运行中出现了 3 次（其中一次是撤回前的 identity 编码试验），分布在不同文件里，页面快照为空。它与 `playwright.config.ts` 注释中 ADR-7 记录的环境类失败（Windows 加 TUN 代理下 preview 请求被丢弃，`net::ERR_NO_BUFFER_SPACE`）表现一致：如果被丢弃的是子资源而不是 `page.goto` 本身，失败信息里就没有这个特征串，`scripts/test-ui.mjs` 的环境重试不会识别它。不过本次没有抓到请求失败日志，所以这只是推测。改动前的那一次全量运行中没有出现这类失败。

## 不变的部分

- 产品代码没有改动，也没有新增可观测的 data 属性。
- `PLAYWRIGHT_TERMINAL_WORKERS`（终端 DOM 组的 worker 上限，默认 3）保留，`playwright.config.ts` 和 AGENTS.md 中的说明不变。
- 第二轮没有在 `loadApp` 的空白页超时路径上加 `requestfailed`/`console` 记录（审查中的可选项），空白页的原因仍未查明。
- 默认截图库仍只截代表状态，主题在场景间轮换。`--full` 保留完整矩阵。`--performance` 的测量不在默认截图库中运行。
- `workbench-acp-large.spec.ts` 和 `capture-workbench --performance` 的功能与测量能力不变。
- 这些数字来自浏览器预览和合成 IPC，不是原生平台验收。
