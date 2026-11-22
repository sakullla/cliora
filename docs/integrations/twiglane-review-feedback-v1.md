# Cliora ↔ Twiglane 审阅意见回传协议 feedback-v1

本文件是意见回传的唯一合同，独立于 [审查协议 v3](twiglane-review-v3.md)：v3 的 accepted / rejected / returned 语义不变，本协议也不自动降级到 v2。两端各自实现同一份小型文件安全合同，并消费逐字一致的 `tests/fixtures/reviews/protocol-feedback-v1.json`（两个仓库各一份，内容必须完全相同）。

## 1. 角色与方向

| 方向 | scheme | host | 用途 |
| --- | --- | --- | --- |
| Twiglane → cliora | `cliora` | `review-feedback` | 声明一批已准备好的行定位意见 |

只新增这一个方向。`cliora://review` 仍是 v2/v3 的接收回执与返回事件，两者互不替代。发起仍固定 v3。

## 2. 交接流程

1. 用户在 Twiglane 的任务审阅里显式选择「准备送回原任务」。普通「返回 cliora」不写文件、不产生 feedbackId。
2. Twiglane 原生层校验当前来源、结果版本、工作树、任务起点与全部意见，写入专用交接目录中的 `<feedbackId>.json`，回读核对 schema 与 digest。
3. 只有写入并回读成功后才打开 `cliora://review-feedback` 深链。深链只带标识、结果版本与 digest。
4. cliora 校验 URL、文件 schema、digest、来源与当前 review/resultRevision，把意见读入有界内存暂存并删除一次性文件。读取只用于预览：不启动 CLI、不写 PTY、不写 Git。
5. 旧版本、重复 feedbackId、旧 reviewId/resultRevision、路径或 digest 不符、超限都明确失败；失败不产生任何 Agent 操作。

## 3. 交接目录与文件安全

- 目录：两端各自平台的临时根目录下的同名子目录 `cliora-review-feedback`，即 `std::env::temp_dir().join("cliora-review-feedback")`（macOS 的 `TMPDIR` 与 Windows 的 `%TEMP%` 都按当前用户隔离）。
- Unix：目录必须存在时已是 `0700` 且属于当前用户，否则拒绝；新建目录直接 `0700`。文件以 ```create_new` 打开并立即是 `0600`。
- Windows：目录必须是普通目录（不是符号链接）；文件 ACL 继承自当前用户临时目录，创建时同样 `create_new`，绝不覆盖。
- 文件名固定为 `<feedbackId>.json`，`feedbackId` 是 RFC 4122 UUID；不接受调用方指定路径。
- 原子完成：先写 ```<feedbackId>.part`（`create_new`），`write_all` 后 `sync_all`，再 `rename` 到目标名，最后对文件做一次有界回读（schema、上限、digest）才算成功。失败会删除临时文件，不打开深链。
- 拒绝符号链接：目标路径已存在（含符号链接、目录或指向外部文件的链接）即失败，不覆盖、不跟随；读取端对符号链接同样拒绝。
- 有界读取：先看元数据长度，再以 `MAX_FILE_BYTES + 1` 上限读取，超过 1 MiB 直接失败，不完整分配。

## 4. 文件 schema（feedback-v1）

JSON 对象，**不接受任何额外字段**（`deny_unknown_fields`）。字段顺序见第 6 节的 digest 规范。

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| `v` | number | 恰好 `1` |
| `feedbackId` | string | UUID 形式，本批次的唯一身份 |
| `reviewId` | string | UUID 形式，必须与当前审查来源一致 |
| `sessionId` | string | UUID 形式，必须与当前审查来源一致 |
| `resultRevision` | number | 非负整数，≤ 9007199254740991；等于 Twiglane 最近一次 returned 的序号，从未返回过为 `0` |
| `worktreePath` | string | 绝对路径（POSIX `/` 开头或 Windows 盘符），1–1000 字符，无控制字符；接收端重新 canonicalize |
| `rangeVersion` | string | 1–200 字符，无控制字符；任务范围版本，用于判断意见是否已过期 |
| `baselineOid` | string | 恰好 40 位小写十六进制，必须等于该来源的任务起点 |
| `headOid` | string | 恰好 40 位小写十六进制，必须等于这批意见看到的 HEAD |
| `comments` | array | 1–64 条，见下 |
| `digest` | string | 64 位小写十六进制，见第 6 节 |

每条意见：

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| `id` | string | UUID 形式；同一批内不得重复 |
| `path` | string | 仓库相对路径，1–500 字符；不得以 `/` 开头、含反斜杠、含 `.` 或 ```..``` 段、以 `/` 结尾 |
| `hunkIndex` | number | 该文件差异里的规范块号 |
| `kind` | string | `add` \| `del` \| `context` |
| `oldNo` | number \| null | 旧侧行号 |
| `newNo` | number \| null | 新侧行号；`oldNo` 与 `newNo` 不能同时为 null |
| `body` | string | 1–16384 个 UTF-8 字节；trim 后非空；只允许 `\n` 与 `\t` 作为控制字符 |

上限：单条正文 16 KiB，整批 64 条，整个文件 1 MiB。任何一项超出在写文件与打开深链之前失败。

## 5. 深链

`cliora://review-feedback?v=1&feedbackId=<uuid>&reviewId=<uuid>&sessionId=<uuid>&resultRevision=<n>&digest=<64 hex>`

- 只允许这六个参数，每个恰好一次，顺序不参与语义。未知参数、重复参数、空值都无效。
- 参数值只含未保留字符 `A-Z a-z 0-9 - _ . ~`；不接受百分号编码、`+` 空格或裸空白。
- 整个 URL 上限 2048 字节；不接受 fragment、控制字符、多余路径段（`review-feedback` 后允许恰好一个 `/` 再跟查询串，这是系统对无路径 URL 的等价规范化）。
- `v` 只接受 `1`；`digest` 只接受 64 位小写十六进制；`resultRevision` 不接受前导零与符号。
- URL 与两端日志都不得包含意见正文、文件路径、代码、命令、提示词或凭据。日志只记 feedbackId、reviewId 与稳定错误码。

示例：

```
cliora://review-feedback?v=1&feedbackId=8b7c6d5e-4f30-4121-8394-a5b6c7d8e9f1&reviewId=6f1a2b3c-4d5e-4f60-8172-93a4b5c6d7e8&sessionId=0b1c2d3e-4f50-4172-8394-a5b6c7d8e9f0&resultRevision=2&digest=082476955cbba23ba6e82c2eacfff6d59f82c347b088fdb2df0f426ee62c56fc
```

## 6. digest 规范

`digest = SHA-256(UTF-8 bytes of canonical JSON)`，小写十六进制。

canonical JSON 是同一份文件**去掉 `digest` 字段**后的紧凑序列化：键顺序固定为 `v, feedbackId, reviewId, sessionId, resultRevision, worktreePath, rangeVersion, baselineOid, headOid, comments`；每条意见固定为 `id, path, hunkIndex, kind, oldNo, newNo, body`；无任何空白；非 ASCII 字符按 UTF-8 原样输出（不转义为 \uXXXX）；`null` 写为 `null`。两端都必须用同一套结构体序列化（Rust 的 `serde_json::to_vec` 即为该规范形式），不得依赖字段顺序以外的差异。

## 7. 失败与恢复

| 条件 | 结果 |
| --- | --- |
| version 不是 1 | `feedback_unsupported_version`，不读文件、不打开深链 |
| schema 有未知/缺失字段 | `feedback_invalid` |
| 重复意见 ID、坏路径、坏行类型、空正文、非完整 OID | `feedback_invalid` |
| 超过 64 条、单条 16 KiB、整体 1 MiB | `feedback_too_large` |
| 同一 feedbackId 已有文件 | `feedback_duplicate`，不覆盖 |
| digest 与正文不符 | `feedback_digest_mismatch` |
| 目录/文件权限或符号链接不合规、写入失败 | `feedback_write_failed` |
| 来源已失效、目录或任务起点不符、结果版本落后 | Twiglane 在写文件前失败，不打开 cliora |
| 深链形状不合法 | `feedback_url_invalid` |

失败时两端的意见与草稿都保留：Twiglane 的原意见仍在，可以重新准备一个新 feedbackId；cliora 不自动重试、不创建替代会话、不写 Git。用户取消时同样不产生交接。

## 8. 与 v2/v3 的关系

- `cliora://review` 的 accepted / rejected / returned 与 `meta.*` 语义完全不变；意见正文不进入 v3 `meta`。
- 本协议不回落到 v2：v2 来源不能准备 feedback-v1，反之亦然。
- 发送与接受由 cliora 侧单独确认（见 R5/R7）：本文件只描述交接准备，不描述 PTY 写入。

## 9. 夹具

`tests/fixtures/reviews/protocol-feedback-v1.json` 在 Cliora 与 Twiglane 两个仓库各一份且逐字一致：

- `schemaVersion: 1`
- `batches[]`：`{name, valid, reject, file}`；`reject` 为 `null` 表示有效批次，否则是失败阶段 `schema` / `digest` / `validation`。
- `urls[]`：`{name, url, valid}`。

两侧测试都读取同一文件：有效批次必须通过 schema、校验、digest 与深链生成；失败批次必须在指定阶段失败；URL 用例直接验证入站规则。
