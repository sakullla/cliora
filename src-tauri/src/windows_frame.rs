//! Keeps a maximized window still after a fullscreen snip.
//!
//! Windows 11's snipping overlay (Win+Shift+S) leaves the window under the
//! cursor in a size/move loop. Each later mouse move posts a position change
//! about one frame thick. WebView2 applies it, the maximized frame snaps
//! back, and the whole window shakes. A real drag or restore moves by much
//! more than the frame, and the auto-hide taskbar only nudges by a pixel, so
//! those still go through.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct FrameShift {
    pub move_x: i32,
    pub move_y: i32,
    pub size_x: i32,
    pub size_y: i32,
}

/// `frame` is the window frame thickness in physical pixels (`SM_CXFRAME` +
/// `SM_CXPADDEDBORDER`). A shift in `2..=frame` on one axis, with the other
/// axis quiet or equally small, is the snipping-tool nudge.
pub(crate) fn is_frame_jitter(shift: FrameShift, frame: i32) -> bool {
    if frame < 2 {
        return false;
    }
    let frame = frame as u32;
    let move_delta = shift.move_x.unsigned_abs().max(shift.move_y.unsigned_abs());
    let size_delta = shift.size_x.unsigned_abs().max(shift.size_y.unsigned_abs());
    let hit = |delta: u32| (2..=frame).contains(&delta);
    let quiet = |delta: u32| delta <= 1;
    (hit(move_delta) && (hit(size_delta) || quiet(size_delta)))
        || (hit(size_delta) && quiet(move_delta))
}

pub(crate) fn install(app: &tauri::App) {
    #[cfg(windows)]
    native::install(app);
    #[cfg(not(windows))]
    let _ = app;
}

#[cfg(windows)]
mod native {
    use super::{is_frame_jitter, FrameShift};
    use std::sync::atomic::{AtomicBool, Ordering};
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
    use windows_sys::Win32::UI::HiDpi::{GetDpiForWindow, GetSystemMetricsForDpi};
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, GetCapture, ReleaseCapture, VK_LBUTTON,
    };
    use windows_sys::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowRect, IsZoomed, SM_CXFRAME, SM_CXPADDEDBORDER, SWP_NOMOVE, SWP_NOSIZE, WINDOWPOS,
        WM_ENTERSIZEMOVE, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEMOVE, WM_NCDESTROY,
        WM_NCLBUTTONDOWN, WM_NCLBUTTONUP, WM_WINDOWPOSCHANGING,
    };

    const SUBCLASS_ID: usize = 0x434C_4652;
    static BUTTON_HELD: AtomicBool = AtomicBool::new(false);
    static SUPPRESS_FRAME_SHIFT: AtomicBool = AtomicBool::new(false);

    pub(crate) fn install(app: &tauri::App) {
        use tauri::Manager;
        let Some(window) = app.get_webview_window("main") else {
            return;
        };
        let Ok(hwnd) = window.hwnd() else {
            return;
        };
        unsafe {
            SetWindowSubclass(hwnd.0, Some(subclass_proc), SUBCLASS_ID, 0);
        }
    }

    fn button_held(held: bool) {
        BUTTON_HELD.store(held, Ordering::Relaxed);
        if held {
            SUPPRESS_FRAME_SHIFT.store(false, Ordering::Relaxed);
        }
    }

    fn engaged() -> bool {
        BUTTON_HELD.load(Ordering::Relaxed)
            && unsafe { GetAsyncKeyState(i32::from(VK_LBUTTON)) } < 0
    }

    fn note_spurious_loop() {
        SUPPRESS_FRAME_SHIFT.store(true, Ordering::Relaxed);
    }

    fn should_freeze(hwnd: HWND) -> bool {
        !engaged()
            && (unsafe { IsZoomed(hwnd) } != 0 || SUPPRESS_FRAME_SHIFT.load(Ordering::Relaxed))
    }

    fn frame_thickness(hwnd: HWND) -> i32 {
        let mut dpi = unsafe { GetDpiForWindow(hwnd) };
        if dpi == 0 {
            dpi = 96;
        }
        let frame = unsafe { GetSystemMetricsForDpi(SM_CXFRAME, dpi) };
        let pad = unsafe { GetSystemMetricsForDpi(SM_CXPADDEDBORDER, dpi) };
        frame.saturating_add(pad).max(0)
    }

    fn shift_of(pos: &WINDOWPOS, current: RECT) -> FrameShift {
        let (move_x, move_y) = if pos.flags & SWP_NOMOVE != 0 {
            (0, 0)
        } else {
            (pos.x - current.left, pos.y - current.top)
        };
        let (size_x, size_y) = if pos.flags & SWP_NOSIZE != 0 {
            (0, 0)
        } else {
            (
                pos.cx - (current.right - current.left),
                pos.cy - (current.bottom - current.top),
            )
        };
        FrameShift {
            move_x,
            move_y,
            size_x,
            size_y,
        }
    }

    fn freeze_frame(hwnd: HWND, lparam: LPARAM) {
        if lparam == 0 {
            return;
        }
        let pos = unsafe { &mut *(lparam as *mut WINDOWPOS) };
        let mut current = RECT::default();
        if unsafe { GetWindowRect(hwnd, &mut current) } == 0 {
            return;
        }
        if is_frame_jitter(shift_of(pos, current), frame_thickness(hwnd)) {
            pos.flags |= SWP_NOMOVE | SWP_NOSIZE;
        }
    }

    unsafe extern "system" fn subclass_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _id: usize,
        _data: usize,
    ) -> LRESULT {
        match msg {
            WM_NCDESTROY => unsafe {
                RemoveWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID);
            },
            WM_NCLBUTTONDOWN | WM_LBUTTONDOWN => button_held(true),
            WM_NCLBUTTONUP | WM_LBUTTONUP => button_held(false),
            WM_ENTERSIZEMOVE if !engaged() => {
                note_spurious_loop();
                unsafe { ReleaseCapture() };
            }
            WM_MOUSEMOVE if !engaged() && unsafe { GetCapture() } == hwnd => {
                note_spurious_loop();
                unsafe { ReleaseCapture() };
            }
            WM_WINDOWPOSCHANGING if should_freeze(hwnd) => freeze_frame(hwnd, lparam),
            _ => {}
        }
        unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
    }
}

#[cfg(test)]
mod tests {
    use super::{is_frame_jitter, FrameShift};

    fn shift(move_x: i32, move_y: i32, size_x: i32, size_y: i32) -> FrameShift {
        FrameShift {
            move_x,
            move_y,
            size_x,
            size_y,
        }
    }

    #[test]
    fn a_frame_thick_nudge_is_the_snipping_shake() {
        assert!(is_frame_jitter(shift(8, 0, 0, 0), 8));
        assert!(is_frame_jitter(shift(0, 0, 0, 8), 8));
        assert!(is_frame_jitter(shift(8, 8, 8, 8), 8));
        assert!(is_frame_jitter(shift(0, 4, 0, 0), 8));
    }

    #[test]
    fn a_pixel_taskbar_nudge_and_a_real_restore_stay_free() {
        assert!(!is_frame_jitter(shift(0, 1, 0, 0), 8));
        assert!(!is_frame_jitter(shift(1, 0, 0, 1), 8));
        assert!(!is_frame_jitter(shift(0, 0, 0, 0), 8));
        assert!(!is_frame_jitter(shift(0, 48, 0, 0), 8));
        assert!(!is_frame_jitter(shift(400, 240, 0, 0), 8));
        assert!(!is_frame_jitter(shift(8, 0, 0, 0), 1));
    }
}
