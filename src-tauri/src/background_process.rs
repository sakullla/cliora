use std::ffi::OsStr;
use std::process::Command;

/// Background probes and file maintenance never create a console on Windows.
/// Interactive session terminals use the separate launch path.
pub(crate) fn command(program: impl AsRef<OsStr>) -> Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut command = Command::new(program);
        crate::process_environment::apply(&mut command);
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        command
    }
    #[cfg(not(windows))]
    {
        let mut command = Command::new(program);
        crate::process_environment::apply(&mut command);
        command
    }
}
