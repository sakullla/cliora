# 0.4.100 内存与积压调查

## 结论与修复范围

确认两种不同的积压：原 0.4.95 Windows 现场的 WebView2 原生合成器 tracker 积压，以及应用在终端尚未挂载/已经关闭时保留迟到输出的缓存增长。后者已复现并增加全局上限；前者的首次触发条件仍未确定，不将应用缓存修复等同于浏览器内核泄漏修复。

- `PendingTerminalOutput` 将未挂载终端缓存限制为最多 32 个会话、总计 4 MiB base64 字符、每会话 512 KiB 和 256 个分片。按最近收到输出的顺序淘汰会话，保留完整分片及原生流 offset，不截断 base64。终端挂载时由原生 replay 恢复近期输出；活动终端仍直接写入。
- 合并分片与字节计数的生命周期，drain、删除和卸载都释放对应记录，避免独立计数 Map 遗留。
- 工作台同时观察页面 active 和 document visibility。窗口隐藏后释放 WebGL 并停止光标闪烁，恢复可见时重新挂载渲染器；仍处理输出和终端协议回复。
- 未暂停整个 WebView。Microsoft 的 TrySuspend 会暂停脚本定时器与动画，可能干扰正在运行的 CLI 协议处理，不适合作为本次直接替代方案。

## 现场及上游研究

原 0.4.95 进程运行约 32 小时，使用 WebView2 156.0.4314.58。匹配 PDB 的采样显示合成线程约占一个 CPU 核心，主线程约 3%，Rust 约 0–0.6%；渲染进程约 1 GB。热点约 64% 位于 `cc::FrameSequenceTrackerCollection::DestroyTrackers`、33% 位于 `cc::Scheduler::FinishImplFrame`。

`removal_trackers_` 在约 8 分钟内由 1,029,244 增至 1,036,658。分布抽取的 128 个 tracker 均为 `kScheduledForTermination`，inside_frame 为 0；类型包括 62 个 RAF、58 个 JSAnimation、8 个 CanvasAnimation。这证明待终止对象持续积压，但不足以认定某一应用动画就是唯一触发源。

上游 collection 的停止逻辑将 tracker 加入待移除集合，清理循环扫描集合，仅移除 ReadyForTermination 的对象；tracker 的终止条件还涉及帧、来源和呈现结果。历史 Chromium 1072482 曾涉及 tracker 无法终止和 OOM，但不能据此认定当前故障与旧问题相同或已被某个版本修复。

用户当前应用已另行重启为 0.4.97。一次 20 秒只读采样中，渲染器平均约 18.34% 单核、private bytes 约 199.96 MB，变化 -0.20 MB；GPU 约 16.31% 单核、206.3 MB。该短样本未出现原百万 tracker 的满核现象，也不是 0.4.100 原生验收。未终止用户进程或会话。

参考资料：

- [Chromium tracker collection](https://chromium.googlesource.com/chromium/src/+/HEAD/cc/metrics/frame_sequence_tracker_collection.cc)
- [Chromium tracker termination](https://chromium.googlesource.com/chromium/src/+/52919f68e3f1ebc946d372232618512d0ec82de0/cc/metrics/frame_sequence_tracker.cc)
- [历史 tracker/OOM 修复记录](https://chromium.googlesource.com/chromium/src/+log/84.0.4122.7..84.0.4128.3?n=10000&pretty=fuller)
- [Microsoft WebView2 TrySuspend](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2_3)

## 回归与内存实验

浏览器使用合成 IPC。向 256 个未挂载会话分别发送 48 KiB 随机 ASCII 输出，再两次强制 GC。测量 `Runtime.getHeapUsage` 的 usedSize **加 backingStorageSize**，包含 base64 字符串外部存储；只看 usedSize 会漏掉主要保留量。

- 修复前：8,674,312 → 25,519,816 字节，净增长 **16,845,504 字节**。
- 修复后单轮：8,714,156 → 10,846,408 字节，净增长 **2,132,252 字节**，同负载保留增量约减少 **87%**。这是特定缓存负载的改进，不是整个应用内存降低 87%。
- 最终连续三轮各新增 256 个会话（共 768 个不同 ID），基线 8,682,668 字节，三轮相对基线的保留增量分别为 **2,130,552、2,138,396、2,139,348 字节**；每轮低于 8 MiB 回归阈值，未随会话数量线性增长。压力后活动终端仍正确响应 DSR。
- document hidden 回归在旧代码上失败（WebGL canvas 仍存在），修复后通过；连续三次隐藏/显示，确认资源释放、隐藏期间 DSR 回复正常、三次输出均能查找。

最终验证：

- TypeScript 类型检查、Vite 生产构建通过。
- Node 单元及仓库检查 **163/163 通过**，包括新增的缓存容量、淘汰、分片 offset 与释放计数回归。
- 工作台 host、terminal、WebGL 三个 Playwright 套件 **101/101 通过**（单 worker，约 4.6 分钟），覆盖本机/远程会话、replay、输入、布局、WebGL 生命周期及以上内存实验。
- `git diff --check` 通过。版本在 npm、Cargo 及 Tauri 五处文件一致更新至 0.4.100。
- 本版本 Rust 实现与 0.4.99 相同，仅更新版本字段；复用该版本已通过的严格 Clippy、96 项针对性 Rust 复跑及远端完整 CI 证据，未重复宣称新一轮原生压力验收。

没有新增可见布局，隐藏/恢复行为由实际软件 WebGL 浏览器测试验证；这些合成 IPC 结果不替代 Windows WebView2 长时间运行证据。

## 后续待验证项

2026-11-06 查询仓库 open GitHub issues 返回空列表。结合代码和现场，本轮后续项如下；这些是调查边界，不把未经复现的疑点标成已确认泄漏：

1. 在 Windows 原生新版本上持续运行数十小时，检查合成线程 CPU、渲染进程内存及窗口隐藏/显示后走势；确认 WebView2 tracker 积压是否再现。
2. 终端输出通路已有原生有界队列，但尚无从 xterm parser 到原生生产端的完整消费确认。持续超速输出时的端到端背压需单独压测，不能宣称本次全链路有界。
3. replay 完成前的临时输出队列、frameChunks 和按目录保存的 gitWorktrees 缓存尚无独立泄漏复现；本次未改动它们。

诊断 PDB、原始内存采样及本机路径留在系统临时目录，不提交仓库。
