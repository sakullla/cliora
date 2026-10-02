//! Native extension contracts checked against the versions shown in the UI.
use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginCapability {
    pub version: &'static str,
    pub sources: &'static str,
    pub actions: Vec<&'static str>,
    pub project: bool,
    pub detail: &'static str,
}

pub fn capability(tool: &str) -> Result<PluginCapability, String> {
    let (version, sources, actions, project, detail) = match tool {
        "claude_code" => ("2.1.287", "已配置市场中的 plugin@marketplace 或 package@npm", vec!["install", "update", "enable", "disable", "uninstall"], true, "原生命令管理插件；命令型市场需要额外原生确认，Cliora 不自动同意。重启会话后加载。"),
        "codex" => ("0.160.0", "已配置市场中的 plugin@marketplace", vec!["install", "enable", "disable", "uninstall"], false, "原生安装/移除及已核验 plugins.<id>.enabled 配置；此版没有独立插件更新命令。重启会话后加载。"),
        "grok" => ("1.0.46", "Git URL、user/repo@ref#subdir 或绝对本地路径", vec!["install", "update", "enable", "disable", "uninstall"], false, "原生命令管理用户插件；项目插件操作的作用域尚未核验。安装明确授权 --trust；重启会话后加载。"),
        "pi" => ("0.99.2", "npm:包@版本、git:仓库或绝对本地路径", vec!["install", "update", "enable", "disable", "uninstall"], true, "Pi packages/extensions；禁用保留完整资源过滤，恢复时还原。项目包需要原生信任；重启或原生 /reload 后加载。"),
        "open_code" => ("1.18.34", "npm 包@版本或 file:///绝对路径", vec!["install", "enable", "disable", "uninstall"], true, "维护 plugin 数组声明；依赖由 OpenCode 启动安装，安装及加载尚未验证。更新请卸载声明后添加新版本。自动发现的 plugins 目录项只读。"),
        _ => return Err("未知 CLI 插件能力".into()),
    };
    Ok(PluginCapability {
        version,
        sources,
        actions,
        project,
        detail,
    })
}

pub fn command_args(
    tool: &str,
    action: &str,
    source: &str,
    project: bool,
) -> Result<Vec<String>, String> {
    if source.is_empty()
        || source.starts_with('-')
        || source.chars().any(char::is_control)
        || source.len() > 2048
    {
        return Err("插件来源/标识无效".into());
    }
    let cap = capability(tool)?;
    if !cap.actions.contains(&action) || (project && !cap.project) {
        return Err("此原生操作或作用域未支持".into());
    }
    let args = match tool {
        "claude_code" => vec![
            "plugin",
            action,
            source,
            "--scope",
            if project { "project" } else { "user" },
            "--json",
        ],
        "codex" => vec![
            "plugin",
            match action {
                "install" => "add",
                "uninstall" => "remove",
                _ => return Err("此操作使用配置事务".into()),
            },
            source,
            "--json",
        ],
        "grok" => {
            let mut args = vec!["plugin", action, source];
            if action == "install" {
                args.push("--trust");
            }
            args
        }
        "pi" => {
            if action == "update" && project {
                return Err(
                    "Pi update 可能合并全局与项目同源包；项目更新请在原生 CLI 中执行".into(),
                );
            }
            let mut args = match action {
                "install" => vec!["install", source],
                "uninstall" => vec!["remove", source],
                "update" => vec!["update", "--extension", source],
                _ => return Err("此操作使用配置事务".into()),
            };
            if project {
                args.extend(["--local", "--approve"]);
            } else {
                args.push("--no-approve");
            }
            args
        }
        _ => return Err("此操作使用配置事务".into()),
    };
    Ok(args.into_iter().map(str::to_owned).collect())
}
