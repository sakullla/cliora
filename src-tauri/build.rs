use std::path::Path;

fn main() {
    stage_conpty();
    tauri_build::build()
}

/// `portable-pty` prefers a `conpty.dll` beside the executable over the inbox copy.
/// Installers place the bundled ConPTY there through `tauri.windows.conf.json`; copy it
/// next to development builds too so `tauri dev` hosts CLIs the same way.
fn stage_conpty() {
    println!("cargo:rerun-if-changed=vendor/conpty/x64");
    let windows = std::env::var("CARGO_CFG_TARGET_OS").is_ok_and(|os| os == "windows");
    let x64 = std::env::var("CARGO_CFG_TARGET_ARCH").is_ok_and(|arch| arch == "x86_64");
    if !windows || !x64 {
        return;
    }
    let Ok(out_dir) = std::env::var("OUT_DIR") else { return };
    // OUT_DIR is <target>/<profile>/build/<package>-<hash>/out.
    let Some(profile_dir) = Path::new(&out_dir).ancestors().nth(3) else { return };
    for name in ["conpty.dll", "OpenConsole.exe"] {
        let source = Path::new("vendor/conpty/x64").join(name);
        let target = profile_dir.join(name);
        let Ok(wanted) = std::fs::read(&source) else { continue };
        if std::fs::read(&target).ok().as_deref() != Some(wanted.as_slice()) {
            // A running development build keeps OpenConsole.exe open; the copy then
            // already matches the last staged build, so a failure is not fatal.
            let _ = std::fs::copy(&source, &target);
        }
    }
}
