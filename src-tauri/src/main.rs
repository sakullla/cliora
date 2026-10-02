#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if cliora_lib::usage::helper_entry() {
        return;
    }
    cliora_lib::run();
}
