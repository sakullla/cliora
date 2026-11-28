//! Resolve the same adapter-owned ACP entry on a POSIX SSH target for both
//! the installation check and the stdio launch. No local path enters the command.
use super::{AcpEntry, AcpInstaller, CliAdapter};
use crate::remote::{quote_command_arg as quote, with_remote_user_path, RemoteTarget};

impl AcpEntry {
    fn remote_lookup(&self) -> String {
        let mut setup = String::new();
        if matches!(self.dependency.and_then(|d| d.installer), Some(AcpInstaller::Npm)) {
            setup.push_str("export PATH=\"$HOME/.cliora/acp/bin:$PATH\"; ");
        }
        setup.push_str(&format!("cliora_entry=$(command -v {} || :); ", quote(self.executable)));
        if let Some(old) = self.dependency.and_then(|d| d.obsolete_package) {
            setup.push_str(&format!("case $(readlink \"$cliora_entry\" 2>/dev/null) in *{}*) cliora_entry='' ;; esac; ", quote(&format!("/{old}/"))));
        }
        with_remote_user_path(&setup)
    }

    pub(crate) fn remote_installed(&self, target: &RemoteTarget) -> Result<bool, String> {
        let script = self.remote_lookup() + "if test -x \"$cliora_entry\"; then echo installed; else echo missing; fi";
        let result = crate::remote::run_command(target, &script).map_err(|error| error.to_string())?;
        match result.stdout.lines().last() {
            Some("installed") => Ok(true),
            Some("missing") => Ok(false),
            _ => Err("无法判断远程 ACP 入口状态".into()),
        }
    }

    pub(crate) fn remote_stdio(&self, adapter: &dyn CliAdapter, directory: &str, args: &[String]) -> String {
        let mut script = self.remote_lookup();
        script.push_str("test -x \"$cliora_entry\" || { echo 'ACP executable unavailable' >&2; exit 127; }; ");
        let cli = quote(adapter.command());
        script.push_str(&format!("cliora_cli=$(command -v {cli}) && test -x \"$cliora_cli\" || {{ echo 'CLI unavailable' >&2; exit 127; }}; "));
        if let Some(program) = self.dependency.and_then(|dep| dep.program) {
            script.push_str(&format!("command -v {} >/dev/null || exit 127; ", quote(program)));
        }
        for key in self.environment.remove {
            script.push_str(&format!("unset {key}; "));
        }
        for (key, value) in self.environment.set {
            script.push_str(&format!("export {key}={}; ", quote(value)));
        }
        for key in self.environment.bind_installation {
            script.push_str(&format!("export {key}=\"$cliora_cli\"; "));
        }
        script.push_str(&format!("cd {} && exec \"$cliora_entry\"", quote(directory)));
        for arg in args {
            script.push(' ');
            script.push_str(&quote(arg));
        }
        script
    }
}
