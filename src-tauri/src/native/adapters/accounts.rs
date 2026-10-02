//! Authentication facts are separate from the legacy "open login terminal" facet.
use crate::accounts::AccountCapability;

pub fn capability(tool: &str) -> Option<AccountCapability> {
    let (provider, version, supported, reason, identity) = match tool {
        "codex" => ("chatgpt", "0.160.0", true,
            "CODEX_HOME 独立目录；强制 file 认证存储；account/read 核验 ChatGPT 身份。明确纳入默认目录时不复制令牌，退出会影响使用该目录的普通终端。", "Codex App Server account/read"),
        "claude_code" => ("claudeai", "2.1.287", !cfg!(target_os = "macos"),
            if cfg!(target_os = "macos") { "macOS Keychain 服务名随 CLAUDE_CONFIG_DIR 的隔离尚未验收，不开放受管登录。" }
            else { "CLAUDE_CONFIG_DIR 隔离 .credentials.json、配置与历史；auth status --json 核验 claude.ai 身份。" }, "Claude auth status --json"),
        "pi" => ("openai-codex", "0.99.2", true,
            "仅 openai-codex OAuth：PI_CODING_AGENT_DIR/auth.json 的原生 accountId 与无刷新 auth check；在终端执行 /login。其他提供方身份格式尚未核验。", "Pi native OAuth accountId + auth check --no-refresh"),
        "open_code" => ("openai", "1.18.34", true,
            "仅内置 OpenAI ChatGPT OAuth：同时隔离 XDG data/config/state/cache；原生 auth.json 的 accountId 核验本地身份。其他提供方未核验。", "OpenCode native OpenAI OAuth accountId"),
        "grok" => ("xai", "1.0.46", false,
            "已核对 GROK_HOME 与 login --oauth/--device-auth；发行包未公开认证存储实现，尚无可核验的身份和系统凭据隔离证据。usage 仅为本地会话费用。", "未核验"),
        _ => return None,
    };
    Some(AccountCapability {
        tool_id: match tool {
            "codex" => "codex",
            "claude_code" => "claude_code",
            "pi" => "pi",
            "open_code" => "open_code",
            _ => "grok",
        },
        provider,
        version,
        managed_login: supported,
        import_native: supported && tool == "codex",
        methods: if !supported {
            vec![]
        } else if tool == "codex" || tool == "open_code" {
            vec!["browser", "device"]
        } else {
            vec!["browser"]
        },
        reason,
        identity_source: identity,
        refresh_owner: "native_cli",
        acceptance: "源码/协议与隔离合成回归；真实授权账号及跨平台尚未验收",
    })
}

pub fn capabilities() -> Vec<AccountCapability> {
    ["codex", "claude_code", "grok", "pi", "open_code"]
        .into_iter()
        .filter_map(capability)
        .collect()
}
