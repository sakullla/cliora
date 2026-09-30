# 单元测试实测

统一命令：`npm run test:unit:all`。`scripts/test-unit.mjs` 顺序执行 `cargo test --manifest-path src-tauri/Cargo.toml --lib -- --test-threads=8` 与全部 `tests/native/*.test.mjs`。E2E 单独使用 `npm run test:e2e`。

源码/测试冻结后、没有并发构建或现场探测的两次连续暖运行，Windows 11 Pro 10.0.26200 AMD64：

| 实际运行 | 完整 npm 命令墙钟 | Rust case 执行 | Cargo 热准备 | Node case 执行 | 结果 |
| --- | ---: | ---: | ---: | ---: | --- |
| [最后 Rust/Node 冻结 warm-1](sdk-warm-1.json) | 10.4598603s | 8.70s | 0.59s | 0.5049s | Rust 141 passed / 1 ignored，Node 15 passed，exit 0 |
| [最后 Rust/Node 冻结 warm-2](sdk-warm-2.json) | 10.4480554s | 8.73s | 0.58s | 0.5045s | Rust 141 passed / 1 ignored，Node 15 passed，exit 0 |

两轮包含发现/解析取消保护回归，且没有并发构建/现场探测。当时 `allow-message` 变更触发的 [首次运行](sdk-compiled-first.json) 包含 8.80s 增量编译，墙钟 18.949149s、全部 case 通过，它不算暖运行。随后按用户要求改成应用内确认，仅修改前端、UI 回归和移除系统确认权限；Rust/Node 单元实现未变化，复用这两轮执行事实，不把新能力声明引发的增量编译算作已测的暖耗时。此前 [确认/取消 warm-1](confirm-scan-warm-1.json) 13.3022042s / [warm-2](confirm-scan-warm-2.json) 12.8177694s，以及 [warm-1](warm-1.json) 11.9638369s / [warm-2](warm-2.json) 12.8852149s 作为历史结果保留，不冒充最新源码的执行数据。

完整实际 stdout/stderr 与开始/结束时间保留在同目录。外层墙钟包含 npm、Node runner、Cargo 准备和进程启动，判定使用该数值。Cargo 热准备不是冷编译；本轮增量编译单列曾为 16.75s、18.79s、22.14s、31.59s，取消修复后定向 history 编译为 28.89s，未删除 target 执行冷编译，因此不声称冷编译也小于 15 秒。

早期的 [15.2915s](before-merge-over-budget.json)，以及合并重复操作后的 [14.7557s](before-lock-isolation-1.json) / [16.3146s](before-lock-isolation-2.json) 不满足连续两轮目标，均保留。原正式记录中 Cargo case 执行曾为 241.14s，其中六个同步协议场景反复派生密码、解锁和等待同一个测试进程锁；不能把这些早期数据写成最终达标结果。

优化保留关键故障覆盖：

- Argon2id 仍使用真实 64 MiB、3 passes、4 lanes；仅 test profile 优化 argon2/blake2 与测试 executable。`cfg(test)` thread-local memo 只复用完全相同 password/salt 的成功纯 KDF 结果，第一次、新密码、新 salt 和错误密码仍真实派生；长度校验在 memo 前，认证解密始终执行。生产没有这份 memo。
- WebDAV 与原生事务仅在 `cfg(test)` 按独立 SQLite 数据库路径分组锁。同一数据库仍串行；生产仍保留原进程全局锁。独立 Temp 文件/数据库的 fixture 不再互相排队。
- Windows `whoami`、`icacls`、系统 keyring roundtrip、受限 ACL、敏感备份和恢复检查仍真实执行，没有为了计时跳过权限保护。五 CLI 的 matching/compared apply 合并重复事务，原字段、ACL、加密、未知字段与 CAS 断言保留。
- MCP fixture 使用受控已知版本适配器，避免单测反复调用本机真实 CLI。明确忽略的 live Windows probe 可以单独运行，真实五 CLI 探测证据另列；它不计入普通单元通过数。
- 加密迁移、错误密码/篡改、密码轮换中断/失败、离线多版本、同项冲突、外部编辑、事务回滚、同版本导入、异步草稿保护全部仍在完整命令中执行。

这是本机开发计时，不保证其他机器耗时或替代正式 Delivery 验证。计时包装器仅使用固定 npm 参数；其 stderr 中 Node 的 shell 参数 deprecation 是包装器输出，产品 runner 使用无 shell 的受控 argv。
