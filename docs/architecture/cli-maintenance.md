# CLI 版本查询与后台安装

版本来源与包管理策略由 `CliAdapter` 声明，共享服务不按具体客户端 ID 分支。

- `latest_version_url` / `parse_latest_version`：默认查询 npm `latest`；非 npm 客户端在自身目录提供官方清单和解析器。没有可验证来源时返回 `None`，`ToolProbe.latestVersionSupported` 告知 UI 展示官方渠道说明。
- `npm_install_command`：安装和更新共用策略，包含可选依赖、执行生命周期脚本、前台收集脚本输出和有限网络重试。`npm_script_dependencies` 声明需要执行脚本的依赖包；`--allow-scripts` 仅作用于本次调用，不修改用户 npm 配置。旧 npm 可能提示未知配置；npm 11.17 的严格脚本许可模式使用该列表。
- 只有适配器声明的安装、更新、卸载命令可执行。未知来源或没有自动安装能力时继续使用官方说明，不猜测下载地址或安装指令。

`native::releases` 负责 8 秒网络超时、清单大小限制、版本校验和 5 分钟成功缓存。查询失败不缓存，UI 可重试。

`native::maintenance` 串行执行包管理操作，防止同一 npm 全局目录被并发修改。Windows 使用隐藏 PowerShell 和 `npm.cmd`，Unix 使用 bash；实时排空 stdout/stderr，只保留最近 64 KiB。总执行期限为 15 分钟，取消和超时均终止进程树并释放执行槽。取消可能留下部分安装变更，用户可以直接重试；不承诺包管理器事务回滚。

IPC：`maintain_registered_cli` 返回 `{ output, version }`，执行中通过 `cliora:maintenance-progress` 发送 `{ toolId, output }`。`cancel_cli_maintenance` 按工具取消当前操作。成功退出后，在实际安装渠道中重新运行版本验证；失败、取消和成功均失效旧探测缓存。前端保留错误与重试按钮，关闭按钮/Escape 在运行中触发取消。

CLI 版本进程按适配器和路径合并并发请求，文件变化或主动刷新失效缓存；成功缓存 60 秒，失败缓存 8 秒。双通道输出并发读取，单次版本进程最多 4 秒。适配器的 `version_probe_environment` 只影响版本查询进程：Command Code 声明 `OTEL_SDK_DISABLED=true`，避免本地版本查询等待遥测网络；正常交互启动和用户配置不受影响。配置、账号和作用域信息仍各自读取，不随版本结果缓存。

历史发现缓存使用数据库与 WAL 的共享文件修订信息；失败、取消及扫描期间发生变更的结果不进入缓存。ZCode 的外部 rollout 文件仍独立检查。统计按工具和模型索引复用分组，保持去重、费用及时间过滤语义。

扩展证明见 `tests/adapter/sixth.rs`；新增客户端只实现适配器端口和注册，不需要修改版本服务、安装服务或共享 UI。
