//! Read-only Windows installation evidence, without launching reg.exe.
#[derive(Clone)]
pub(crate) struct InstalledApplication {
    pub version: Option<String>,
    pub uninstall: Option<String>,
}
#[cfg(windows)]
mod native {
    use windows_sys::Win32::System::Registry::*;
    struct Key(HKEY);
    impl Drop for Key {
        fn drop(&mut self) {
            unsafe { RegCloseKey(self.0) };
        }
    }
    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain([0]).collect()
    }
    fn open(parent: HKEY, path: &str, flags: u32) -> Option<Key> {
        let mut key = std::ptr::null_mut();
        if unsafe { RegOpenKeyExW(parent, wide(path).as_ptr(), 0, KEY_READ | flags, &mut key) } == 0
        {
            Some(Key(key))
        } else {
            None
        }
    }
    fn read(key: HKEY, name: &str) -> Option<String> {
        let name = wide(name);
        let mut kind = 0;
        let mut size = 0;
        if unsafe {
            RegQueryValueExW(
                key,
                name.as_ptr(),
                std::ptr::null(),
                &mut kind,
                std::ptr::null_mut(),
                &mut size,
            )
        } != 0
            || kind != REG_SZ
            || !(2..=32768).contains(&size)
            || !size.is_multiple_of(2)
        {
            return None;
        }
        let mut units = vec![0u16; size as usize / 2];
        if unsafe {
            RegQueryValueExW(
                key,
                name.as_ptr(),
                std::ptr::null(),
                &mut kind,
                units.as_mut_ptr().cast(),
                &mut size,
            )
        } != 0
            || kind != REG_SZ
            || !size.is_multiple_of(2)
        {
            return None;
        }
        units.truncate(size as usize / 2);
        let end = units
            .iter()
            .position(|unit| *unit == 0)
            .unwrap_or(units.len());
        String::from_utf16(&units[..end])
            .ok()
            .filter(|text| !text.is_empty())
    }
    pub(super) fn user_value(path: &str, name: &str) -> Option<String> {
        read(open(HKEY_CURRENT_USER, path, 0)?.0, name)
    }
    pub(super) fn application(
        matches: impl Fn(&str) -> bool,
    ) -> Option<super::InstalledApplication> {
        for (parent, flags) in [
            (HKEY_CURRENT_USER, 0),
            (HKEY_LOCAL_MACHINE, KEY_WOW64_64KEY),
            (HKEY_LOCAL_MACHINE, KEY_WOW64_32KEY),
        ] {
            let Some(root) = open(
                parent,
                r"Software\Microsoft\Windows\CurrentVersion\Uninstall",
                flags,
            ) else {
                continue;
            };
            let mut index = 0;
            while index < 10000 {
                let mut name = [0u16; 256];
                let mut length = name.len() as u32;
                let result = unsafe {
                    RegEnumKeyExW(
                        root.0,
                        index,
                        name.as_mut_ptr(),
                        &mut length,
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                    )
                };
                if result == 259 {
                    break;
                }
                if result != 0 {
                    index += 1;
                    continue;
                }
                if let Ok(name) = String::from_utf16(&name[..length as usize]) {
                    if let Some(key) = open(root.0, &name, 0) {
                        if read(key.0, "DisplayName").is_some_and(|name| matches(&name)) {
                            return Some(super::InstalledApplication {
                                version: read(key.0, "DisplayVersion"),
                                uninstall: read(key.0, "UninstallString"),
                            });
                        }
                    }
                }
                index += 1;
            }
        }
        None
    }
}
pub(crate) fn user_value(path: &str, name: &str) -> Option<String> {
    #[cfg(windows)]
    {
        native::user_value(path, name)
    }
    #[cfg(not(windows))]
    {
        let _ = (path, name);
        None
    }
}
pub(crate) fn application(matches: impl Fn(&str) -> bool) -> Option<InstalledApplication> {
    #[cfg(windows)]
    {
        native::application(matches)
    }
    #[cfg(not(windows))]
    {
        let _ = matches;
        None
    }
}
