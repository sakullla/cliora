# OMP 优化验证（0.4.143）

## 变更与行为边界

- 配置编辑器缓存模型/字段派生数据，首次展开才挂载模型表单；访问过的表单继续保留，折叠不会丢失无效输入或解除保存阻止。
- 历史树索引借用 ID，正文转移至输出，减少字符串副本；物化和用量遍历检查取消。活动分支与全分支用量语义保持不变。
- 账号 SQLite 行使用固定数组、转移字段所有权，并按需只解析一次 JSON fallback；继续只读、脱敏，保持列优先级、BLOB 拒绝及 tombstone 规则。
- 插件清单的每个作用域按需读取一次依赖集合，并复用已有包身份；保留缺失清单和运行时链接诊断。
- 历史复用配置 Profile 解析，空 OMP_PROFILE 仍优先于 PI_PROFILE；空白路径变量忽略。配置和 MCP 共用跨平台相对路径校验，拒绝 Windows 盘符、反斜线根路径和穿越。
- 修复原 Actions run 43871622681 中 Windows/macOS Clippy 的 unit binding，以及 Linux 对 Windows 风格配置路径的错误接受。

## 可复现浏览器测量

`tests/ui/omp-configuration.spec.ts` 使用相同合成配置、200 模型、同一 Chromium 和 3 次刷新。基线仅将 Editor 替换为提交 `6cf02fe4` 的文件；其他 harness 相同。通过 CDP 强制 GC 后读取 JS heap，并记录导航至就绪耗时及 DOM 数量。

| 指标 | 基线 | 优化后 |
| --- | ---: | ---: |
| JS heap 中位数（bytes） | 16,357,196 | 4,349,564 |
| 就绪耗时中位数（ms） | 579.74 | 272.25 |
| DOM 元素 | 15,508 | 2,508 |
| 初始模型表单控件 | 1,800 | 0 |

该场景 heap 约下降 73.4%，就绪耗时约下降 53.0%。耗时受机器负载影响；数据仅代表合成初始配置界面，不是整个应用、原生 RSS 或长期泄漏测量。逐一展开模型后，相应表单会保留以保护草稿。

PowerShell 重现（基线需本地存在该提交）：

```powershell
$env:CLIORA_OMP_BENCH = '1'
$env:CLIORA_OMP_BASELINE = '1'
npm test -- tests/ui/omp-configuration.spec.ts --grep 'OMP large-list performance benchmark' --workers=1
Remove-Item Env:CLIORA_OMP_BASELINE
npm test -- tests/ui/omp-configuration.spec.ts --grep 'OMP large-list performance benchmark' --workers=1
```

普通 CI 默认跳过这项显式基准，不依赖基线 git history。行为回归独立覆盖首次展开、折叠/重开保留无效输入、多个已访问模型，以及保存阻止与恢复。

## 实际检查

- 前端生产构建通过；Node 全套 211 项通过。
- OMP 配置、账号读取、插件 Playwright：52 项通过，1 项显式性能基准默认跳过；基线与优化基准另行各通过。
- Linux OMP 库测试：109 项通过（空白路径审查修正前）；最终版本的完整跨平台测试及 Clippy 以该提交的 main CI 为准。
- 本地 Windows Clippy 通过；本地完整 Rust 重跑被其他构建占用的共享 target 文件阻止（OS error 32），未计为通过；最终由隔离的 CI 验证。
- 独立代码审查发现空白路径变量回归，已修复并补 default/work × 空串/空格/制表换行回归，复核无剩余阻断项。
- 合成 IPC 截图生成无失败，OMP 快速/高级模式深浅主题 1360px 已人工检查：[快速浅色](ui-omp-optimization/omp-quick-light-1360.png)、[快速深色](ui-omp-optimization/omp-quick-dark-1360.png)、[高级浅色](ui-omp-optimization/omp-advanced-light-1360.png)、[高级深色](ui-omp-optimization/omp-advanced-dark-1360.png)。

截图只证明浏览器布局；真实桌面 WebView2、原生 OMP 网络登录/CLI 写入和完整桌面内存曲线未在本次测量中验收。发布必须等待同一提交的 main CI 成功，并由 Release workflow 校验安装包、签名及 updater manifest 后公开。
