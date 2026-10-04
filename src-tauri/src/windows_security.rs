//! Shared private-file ACL primitive. It replaces the DACL rather than retaining
//! explicit grants, and does not launch a shell or external permissions tool.
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use windows_sys::Win32::Foundation::{CloseHandle, LocalFree};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
    SetNamedSecurityInfoW, SE_FILE_OBJECT,
};
use windows_sys::Win32::Security::{
    GetSecurityDescriptorDacl, GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER,
    DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION,
};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

struct LocalAllocation(*mut core::ffi::c_void);
impl Drop for LocalAllocation {
    fn drop(&mut self) { unsafe { LocalFree(self.0); } }
}

fn current_sid() -> Result<String, String> {
    let mut token = std::ptr::null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err("无法检查当前 Windows 用户身份".into());
    }
    let mut size = 0;
    unsafe { GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut size); }
    if size == 0 || size > 65536 {
        unsafe { CloseHandle(token); }
        return Err("Windows 用户身份格式异常".into());
    }
    // TOKEN_USER contains pointers, so its backing buffer must be aligned.
    let mut buffer = vec![0usize; (size as usize).div_ceil(std::mem::size_of::<usize>())];
    let ok = unsafe { GetTokenInformation(token, TokenUser, buffer.as_mut_ptr().cast(), size, &mut size) };
    unsafe { CloseHandle(token); }
    if ok == 0 { return Err("无法读取 Windows 用户身份".into()); }
    let user = unsafe { &*buffer.as_ptr().cast::<TOKEN_USER>() };
    let mut text = std::ptr::null_mut();
    if unsafe { ConvertSidToStringSidW(user.User.Sid, &mut text) } == 0 {
        return Err("无法转换 Windows 用户 SID".into());
    }
    let _allocation = LocalAllocation(text.cast());
    let mut len = 0;
    while len < 256 && unsafe { *text.add(len) } != 0 { len += 1; }
    if len == 256 { return Err("Windows 用户 SID 无效".into()); }
    Ok(String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(text, len) }))
}

pub(crate) fn restrict(path: &Path, directory: bool) -> Result<(), String> {
    let sid = current_sid()?;
    let inheritance = if directory { "OICI" } else { "" };
    let sddl: Vec<u16> = format!("D:P(A;{inheritance};FA;;;{sid})(A;{inheritance};FA;;;SY)")
        .encode_utf16().chain([0]).collect();
    let mut descriptor = std::ptr::null_mut();
    if unsafe { ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), 1, &mut descriptor, std::ptr::null_mut()) } == 0 {
        return Err("无法创建受限 Windows ACL".into());
    }
    let _allocation = LocalAllocation(descriptor);
    let (mut present, mut defaulted) = (0, 0);
    let mut dacl = std::ptr::null_mut();
    if unsafe { GetSecurityDescriptorDacl(descriptor, &mut present, &mut dacl, &mut defaulted) } == 0 || present == 0 || dacl.is_null() {
        return Err("受限 Windows ACL 无效".into());
    }
    let mut name: Vec<u16> = path.as_os_str().encode_wide().collect();
    if name.contains(&0) { return Err("文件路径无效".into()); }
    name.push(0);
    let result = unsafe { SetNamedSecurityInfoW(name.as_ptr(), SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
        std::ptr::null_mut(), std::ptr::null_mut(), dacl, std::ptr::null_mut()) };
    if result != 0 { return Err("无法限制 Windows 文件权限，未写入密钥".into()); }
    Ok(())
}
