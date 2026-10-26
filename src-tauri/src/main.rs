#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // OpenSSH starts Cliora as SSH_ASKPASS to answer a saved remote password.
    if cliora_lib::remote::password::askpass_entry() {
        return;
    }
    if cliora_lib::usage::helper_entry() {
        return;
    }
    cliora_lib::run();
}
