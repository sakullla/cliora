#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if cliora_lib::remote::twiglane::helper_entry() {
        return;
    }
    // OpenSSH starts Cliora as its ProxyCommand to reach a remote host through the local proxy.
    if cliora_lib::remote::proxy::helper_entry() {
        return;
    }
    // OpenSSH starts Cliora as SSH_ASKPASS to answer a saved remote password.
    if cliora_lib::remote::password::askpass_entry() {
        return;
    }
    if cliora_lib::usage::helper_entry() {
        return;
    }
    // AI CLIs call the same binary as a thin secret helper; it reaches the running
    // broker over the per-user local IPC address.
    if cliora_lib::secrets::cli::helper_entry() {
        return;
    }
    // An MCP client starts the same binary as its stdio secret server; it forwards
    // everything to the same broker and never opens local storage itself.
    if cliora_lib::secrets::mcp::helper_entry() {
        return;
    }
    cliora_lib::run();
}
