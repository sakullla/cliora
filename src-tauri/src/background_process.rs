use std::ffi::OsStr;
use std::process::Command;

/// Background probes and file maintenance never create a console on Windows.
/// Interactive session terminals use the separate launch path.
pub(crate) fn command(program: impl AsRef<OsStr>) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    command
}
