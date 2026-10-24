//! Win32 calls Tauri doesn't cover. A Linux version goes next to this later.
//!
//! tao rewrites every window style whenever one of its own flags changes (visibility,
//! always-on-top, its ignore-cursor-events...), so styles set here are applied after the
//! window is shown, and click-through is done here instead of through Tauri.

use windows::Win32::Foundation::HWND;
use windows::Win32::UI::Shell::{
    QUNS_BUSY, QUNS_PRESENTATION_MODE, QUNS_RUNNING_D3D_FULL_SCREEN, SHQueryUserNotificationState,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GWL_EXSTYLE, GetWindowLongPtrW, SetWindowLongPtrW, WS_EX_APPWINDOW, WS_EX_LAYERED, WS_EX_TOOLWINDOW,
    WS_EX_TRANSPARENT,
};

fn update_ex_style(hwnd: isize, add: u32, remove: u32) {
    let h = HWND(hwnd as *mut _);
    unsafe {
        let style = GetWindowLongPtrW(h, GWL_EXSTYLE) as u32;
        SetWindowLongPtrW(h, GWL_EXSTYLE, ((style | add) & !remove) as isize);
    }
}

/// Keep the island out of Alt-Tab (Tauri's skip_taskbar only covers the taskbar).
/// tao sets WS_EX_APPWINDOW, which would override WS_EX_TOOLWINDOW.
pub fn hide_from_alt_tab(hwnd: isize) {
    update_ex_style(hwnd, WS_EX_TOOLWINDOW.0, WS_EX_APPWINDOW.0);
}

/// Let mouse clicks fall through to the windows below.
pub fn set_click_through(hwnd: isize, on: bool) {
    let flags = (WS_EX_TRANSPARENT | WS_EX_LAYERED).0;
    let (add, remove) = if on { (flags, 0) } else { (0, flags) };
    update_ex_style(hwnd, add, remove);
}

/// Put the island back at the top of the always-on-top band. Windows lets other windows end up
/// above it (newer topmost windows, apps that were just launched), so the watcher re-asserts it.
pub fn keep_on_top(hwnd: isize) {
    use windows::Win32::UI::WindowsAndMessaging::{HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOOWNERZORDER, SWP_NOSIZE, SetWindowPos};
    let flags = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER;
    let _ = unsafe { SetWindowPos(HWND(hwnd as *mut _), Some(HWND_TOPMOST), 0, 0, 0, 0, flags) };
}

/// The window the user is working in.
pub fn foreground_window() -> isize {
    unsafe { windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow() }.0 as isize
}

/// True while a fullscreen game, video or presentation is in front.
pub fn fullscreen_app_running() -> bool {
    // The desktop (Progman/WorkerW) covers the whole monitor, so Windows reports it as QUNS_BUSY.
    if is_desktop(foreground_window()) {
        return false;
    }
    matches!(
        unsafe { SHQueryUserNotificationState() },
        Ok(QUNS_BUSY | QUNS_RUNNING_D3D_FULL_SCREEN | QUNS_PRESENTATION_MODE)
    )
}

fn is_desktop(hwnd: isize) -> bool {
    use windows::Win32::UI::WindowsAndMessaging::GetClassNameW;
    let mut buf = [0u16; 16];
    let n = unsafe { GetClassNameW(HWND(hwnd as *mut _), &mut buf) } as usize;
    matches!(String::from_utf16_lossy(&buf[..n]).as_str(), "Progman" | "WorkerW")
}

#[derive(Clone, Copy, PartialEq, serde::Serialize)]
pub struct Battery {
    pub percent: u8,
    pub plugged: bool,
}

/// Battery level and whether the charger is plugged in; None on a PC without a battery.
pub fn battery() -> Option<Battery> {
    use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
    let mut s = SYSTEM_POWER_STATUS::default();
    unsafe { GetSystemPowerStatus(&mut s) }.ok()?;
    // 128 = no system battery, 255 = unknown status.
    if s.BatteryFlag & 128 != 0 || s.BatteryLifePercent > 100 {
        return None;
    }
    Some(Battery { percent: s.BatteryLifePercent, plugged: s.ACLineStatus == 1 })
}

/// Whether the left mouse button is held right now.
pub fn left_button_held() -> bool {
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
    (unsafe { GetAsyncKeyState(VK_LBUTTON.0 as i32) }) < 0
}

/// Whether Shift is held right now, whichever window has focus.
pub fn shift_held() -> bool {
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_SHIFT};
    (unsafe { GetAsyncKeyState(VK_SHIFT.0 as i32) }) < 0
}

/// Changes every time anything is copied, so the clipboard can be checked cheaply.
pub fn clipboard_sequence() -> u32 {
    unsafe { windows::Win32::System::DataExchange::GetClipboardSequenceNumber() }
}

/// Password managers and other apps mark secrets so clipboard history leaves them out (the same
/// markers Windows' own Win+V history respects).
pub fn clipboard_is_private() -> bool {
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::System::DataExchange::{CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard, RegisterClipboardFormatW};
    use windows::Win32::System::Memory::{GlobalLock, GlobalUnlock};
    use windows::core::HSTRING;
    unsafe {
        let format = |name: &str| RegisterClipboardFormatW(&HSTRING::from(name));
        let has = |f: u32| IsClipboardFormatAvailable(f).is_ok();
        if has(format("ExcludeClipboardContentFromMonitorProcessing")) || has(format("Clipboard Viewer Ignore")) {
            return true;
        }
        let allowed = format("CanIncludeInClipboardHistory");
        if !has(allowed) {
            return false;
        }
        // The marker holds a DWORD: 0 means "keep this out of history".
        if OpenClipboard(None).is_err() {
            return true; // can't check, so play safe
        }
        let mut private = false;
        if let Ok(handle) = GetClipboardData(allowed) {
            let memory = HGLOBAL(handle.0);
            let value = GlobalLock(memory) as *const u32;
            if !value.is_null() {
                private = *value == 0;
                let _ = GlobalUnlock(memory);
            }
        }
        let _ = CloseClipboard();
        private
    }
}

/// The last window the user worked in that isn't the island: where "paste" should go.
static LAST_OTHER_WINDOW: std::sync::atomic::AtomicIsize = std::sync::atomic::AtomicIsize::new(0);

pub fn remember_foreground(foreground: isize, island: isize) {
    if foreground != 0 && foreground != island {
        LAST_OTHER_WINDOW.store(foreground, std::sync::atomic::Ordering::Relaxed);
    }
}

/// Gives focus back to the window the user was in and presses Ctrl+V there.
pub fn paste_into_last_window() -> Result<(), String> {
    use windows::Win32::UI::Input::KeyboardAndMouse::{INPUT, INPUT_0, INPUT_KEYBOARD, KEYBD_EVENT_FLAGS, KEYBDINPUT, KEYEVENTF_KEYUP, SendInput, VIRTUAL_KEY, VK_CONTROL, VK_V};
    use windows::Win32::UI::WindowsAndMessaging::SetForegroundWindow;
    let target = LAST_OTHER_WINDOW.load(std::sync::atomic::Ordering::Relaxed);
    if target == 0 {
        return Err("no window to paste into".into());
    }
    if !unsafe { SetForegroundWindow(HWND(target as *mut _)) }.as_bool() {
        return Err("couldn't switch back to that window".into());
    }
    // Give the window a moment to take focus before the keys arrive.
    std::thread::sleep(std::time::Duration::from_millis(120));
    let key = |vk: VIRTUAL_KEY, up: bool| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: vk, dwFlags: if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) }, ..Default::default() } },
    };
    let keys = [key(VK_CONTROL, false), key(VK_V, false), key(VK_V, true), key(VK_CONTROL, true)];
    let sent = unsafe { SendInput(&keys, size_of::<INPUT>() as i32) };
    if sent as usize == keys.len() { Ok(()) } else { Err("couldn't press Ctrl+V".into()) }
}

/// The user's Documents folder, wherever it really is (OneDrive often moves it).
pub fn documents_dir() -> Option<std::path::PathBuf> {
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::UI::Shell::{FOLDERID_Documents, KF_FLAG_DEFAULT, SHGetKnownFolderPath};
    unsafe {
        let path = SHGetKnownFolderPath(&FOLDERID_Documents, KF_FLAG_DEFAULT, None).ok()?;
        let dir = path.to_string().ok();
        CoTaskMemFree(Some(path.0 as *const _));
        dir.map(std::path::PathBuf::from)
    }
}

/// False if another linnotch is already running (two islands would sit on top of each other).
/// The mutex lives as long as this process; the installer checks for it by name too.
pub fn first_instance() -> bool {
    use windows::Win32::Foundation::{ERROR_ALREADY_EXISTS, GetLastError};
    use windows::Win32::System::Threading::CreateMutexW;
    let created = unsafe { CreateMutexW(None, true, windows::core::w!(r"Local\linnotch.island")) };
    created.is_ok() && unsafe { GetLastError() } != ERROR_ALREADY_EXISTS
}

/// Hands `arg` (a file, URL or `shell:` path) to Explorer, which opens it the way a double-click would.
pub fn explorer(arg: impl AsRef<std::ffi::OsStr>) -> Result<(), String> {
    std::process::Command::new("explorer.exe").arg(arg).spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Whether `path` sits directly in `dir` (both resolved, so `..` and junctions can't escape).
/// False when either can't be resolved, never "both unknown, so equal".
pub fn directly_in(path: &std::path::Path, dir: &std::path::Path) -> bool {
    match (path.parent().and_then(|p| p.canonicalize().ok()), dir.canonicalize().ok()) {
        (Some(parent), Some(dir)) => parent == dir,
        _ => false,
    }
}

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";

/// Whether linnotch starts when you sign in (the same value the installer sets).
pub fn starts_with_windows() -> bool {
    winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
        .open_subkey(RUN_KEY)
        .is_ok_and(|k| k.get_value::<String, _>("linnotch").is_ok())
}

pub fn set_start_with_windows(on: bool) {
    let Ok((key, _)) = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER).create_subkey(RUN_KEY) else { return };
    if on {
        if let Ok(exe) = std::env::current_exe() {
            let _ = key.set_value("linnotch", &format!("\"{}\"", exe.display()));
        }
    } else {
        let _ = key.delete_value("linnotch");
    }
}
