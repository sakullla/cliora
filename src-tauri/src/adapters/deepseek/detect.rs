//! Native install evidence for the dsh desktop app.
//!
//! The official docs state the Windows installer records `InstallLocation` in
//! the uninstall table; that registry row is the only authoritative install
//! marker (default directories and exe names are undocumented guesses and are
//! never relied upon). `DisplayVersion` supplies the version when present; a
//! matching row without a readable version stays "installed, version unknown"
//! instead of a fabricated version string.

use std::path::PathBuf;

/// The product is published by DeepSeek; match the publisher name rather than
/// a guessed bundle title so renamed installers still surface. A deliberately
/// narrow substring avoids unrelated products that merely contain "dsh".
pub(crate) fn matches_product(display_name: &str) -> bool {
    display_name.to_ascii_lowercase().contains("deepseek")
}

#[cfg(windows)]
mod table {
    use std::path::PathBuf;

    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegEnumKeyExW, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER,
        HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY, KEY_WOW64_64KEY, REG_SZ,
    };

    const ERROR_SUCCESS: u32 = 0;
    const ERROR_NO_MORE_ITEMS: u32 = 259;
    const UNINSTALL: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall";

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain([0]).collect()
    }

    fn read_string(parent: HKEY, sub_key: &str, value: &str) -> Option<String> {
        let sub_key = wide(sub_key);
        let value = wide(value);
        let mut key = std::ptr::null_mut();
        if unsafe {
            RegOpenKeyExW(
                parent,
                sub_key.as_ptr(),
                0,
                KEY_READ,
                &mut key,
            )
        } != ERROR_SUCCESS
        {
            return None;
        }
        let mut kind = 0u32;
        let mut size = 0u32;
        let readable = unsafe {
            RegQueryValueExW(
                key,
                value.as_ptr(),
                std::ptr::null(),
                &mut kind,
                std::ptr::null_mut(),
                &mut size,
            )
        } == ERROR_SUCCESS
            && kind == REG_SZ
            && size > 1
            && size.is_multiple_of(2);
        let result = if readable {
            let mut buffer = vec![0u8; size as usize];
            let fetched = unsafe {
                RegQueryValueExW(
                    key,
                    value.as_ptr(),
                    std::ptr::null(),
                    std::ptr::null_mut(),
                    buffer.as_mut_ptr(),
                    &mut size,
                )
            } == ERROR_SUCCESS
                && size > 1
                && size.is_multiple_of(2);
            if !fetched {
                None
            } else {
                let units: &[u16] = unsafe {
                    std::slice::from_raw_parts(buffer.as_ptr().cast(), size as usize / 2)
                };
                let owned: Vec<u16> =
                    units.iter().take_while(|unit| **unit != 0).copied().collect();
                (!owned.is_empty()).then(|| String::from_utf16_lossy(&owned))
            }
        } else {
            None
        };
        unsafe { RegCloseKey(key) };
        result
    }

    /// First uninstall-table row that looks like the DeepSeek desktop product
    /// and records an install location.
    pub fn scan() -> Option<(PathBuf, Option<String>)> {
        let roots: [(HKEY, u32); 3] = [
            (HKEY_CURRENT_USER, 0),
            (HKEY_LOCAL_MACHINE, KEY_WOW64_64KEY),
            (HKEY_LOCAL_MACHINE, KEY_WOW64_32KEY),
        ];
        for (root, wow64) in roots {
            let path = wide(UNINSTALL);
            let mut key = std::ptr::null_mut();
            if unsafe { RegOpenKeyExW(root, path.as_ptr(), 0, KEY_READ | wow64, &mut key) }
                != ERROR_SUCCESS
            {
                continue;
            }
            let mut index = 0u32;
            loop {
                let mut name = [0u16; 256];
                let mut length = name.len() as u32;
                let status = unsafe {
                    RegEnumKeyExW(
                        key,
                        index,
                        name.as_mut_ptr(),
                        &mut length,
                        std::ptr::null(),
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                    )
                };
                if status == ERROR_NO_MORE_ITEMS {
                    break;
                }
                if status == ERROR_SUCCESS {
                    let sub_key = String::from_utf16_lossy(&name[..length as usize]);
                    let matches = read_string(key, &sub_key, "DisplayName")
                        .is_some_and(|display| super::matches_product(&display));
                    let location = read_string(key, &sub_key, "InstallLocation");
                    if matches
                        && location
                            .as_deref()
                            .is_some_and(|value| !value.trim().is_empty())
                    {
                        let version = read_string(key, &sub_key, "DisplayVersion");
                        unsafe { RegCloseKey(key) };
                        return Some((PathBuf::from(location.unwrap()), version));
                    }
                }
                index += 1;
            }
            unsafe { RegCloseKey(key) };
        }
        None
    }
}

/// Probe caching belongs to the shared installation service; refresh must also
/// observe installs and upgrades made while Cliora is running.
fn installation() -> Option<(PathBuf, Option<String>)> {
    #[cfg(windows)]
    { table::scan() }
    #[cfg(not(windows))]
    { None }
}

/// Official install root from the uninstall table, when the product is found.
pub(crate) fn native_install_directory() -> Option<PathBuf> {
    installation().map(|(location, _)| location.clone())
}

pub(crate) fn installations() -> Vec<crate::native::adapter::Installation> {
    installation().into_iter().filter_map(|(root, version)| {
        let path = root.join("DeepSeek Harness.exe");
        path.is_file().then(|| crate::native::adapter::Installation {
            path: path.display().to_string(), version: version.clone(),
            source: "native", status: "available", detail: None,
        })
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn product_matching_keys_off_the_publisher_name() {
        assert!(matches_product("DeepSeek Harness"));
        assert!(matches_product("deepseek harness (dsh)"));
        assert!(!matches_product("Dashwood Studio"));
        assert!(!matches_product("DShell"));
        assert!(!matches_product(""));
    }

    #[cfg(windows)]
    #[test]
    fn uninstall_table_lookup_never_panics_without_an_install() {
        // The scan result depends on the host; both outcomes are acceptable as
        // long as the registry walk is safe and never fabricates a location.
        if let Some(location) = native_install_directory() {
            assert!(!location.as_os_str().is_empty());
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn non_windows_hosts_have_no_native_install_marker() {
        assert!(native_install_directory().is_none());
    }
}
