//! Focus sessions (Timer tab): while one runs, only the apps you picked may be in front. Any other
//! app that comes to the front is minimised and the island says so. The UI owns the session (its
//! length, pause, stop) and hands the allowed apps to `focus_set` / `focus_clear`.

use std::collections::HashSet;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{Emitter, WebviewWindow};
use windows::Win32::Foundation::{HWND, LPARAM};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GW_OWNER, GWL_EXSTYLE, GetWindow, GetWindowLongPtrW, GetWindowTextLengthW, GetWindowThreadProcessId,
    IsWindowVisible, SW_MINIMIZE, ShowWindow, WS_EX_TOOLWINDOW,
};
use windows::core::BOOL;

/// Always allowed: linnotch, and Windows' own shell (desktop, taskbar, Start, search, sign-in,
/// UAC prompts, Task Manager), so a session can't lock anyone out of their PC.
/// shortcut: Store apps all run inside applicationframehost.exe, so they're always allowed; resolve the real app if people ask.
const ALWAYS: &[&str] = &[
    "linnotch.exe", "explorer.exe", "taskmgr.exe", "lockapp.exe", "logonui.exe", "consent.exe", "searchhost.exe", "searchapp.exe",
    "startmenuexperiencehost.exe", "shellexperiencehost.exe", "shellhost.exe", "textinputhost.exe", "applicationframehost.exe",
];

static ALLOWED: Mutex<Option<HashSet<String>>> = Mutex::new(None);

#[derive(Serialize)]
pub struct FocusApp {
    /// "code.exe": what `focus_set` takes.
    exe: String,
    name: String,
    icon: Option<String>,
}

fn exe_name(hwnd: HWND) -> Option<(String, std::path::PathBuf)> {
    let mut pid = 0;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    let path = crate::dev::exe_of(pid)?;
    Some((path.file_name()?.to_string_lossy().to_lowercase(), path))
}

fn blocked(exe: &str, allowed: &HashSet<String>) -> bool {
    !allowed.contains(exe) && !ALWAYS.contains(&exe)
}

/// The apps with a window open now, to pick from.
#[tauri::command]
pub async fn focus_apps() -> Vec<FocusApp> {
    unsafe extern "system" fn each(hwnd: HWND, list: LPARAM) -> BOOL {
        let list = unsafe { &mut *(list.0 as *mut Vec<HWND>) };
        let tool = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) } as u32 & WS_EX_TOOLWINDOW.0 != 0;
        let owned = unsafe { GetWindow(hwnd, GW_OWNER) }.is_ok_and(|o| !o.is_invalid());
        if unsafe { IsWindowVisible(hwnd) }.as_bool() && !tool && !owned && unsafe { GetWindowTextLengthW(hwnd) } > 0 {
            list.push(hwnd);
        }
        true.into()
    }
    let mut windows: Vec<HWND> = Vec::new();
    let _ = unsafe { EnumWindows(Some(each), LPARAM(&mut windows as *mut _ as isize)) };
    let mut seen = HashSet::new();
    windows
        .into_iter()
        .filter_map(exe_name)
        .filter(|(exe, _)| !ALWAYS.contains(&exe.as_str()) && seen.insert(exe.clone()))
        .map(|(exe, path)| {
            let p = path.to_string_lossy();
            FocusApp { name: crate::openwith::display_name(&p, &p), icon: crate::openwith::icon(&p, 0), exe }
        })
        .collect()
}

/// Where a shortcut (.lnk) points.
fn shortcut_target(lnk: &str) -> Option<String> {
    use windows::Win32::System::Com::{CLSCTX_INPROC_SERVER, CoCreateInstance, IPersistFile, STGM_READ};
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};
    use windows::core::{HSTRING, Interface};
    let lnk = lnk.to_string();
    crate::openwith::sta(move || unsafe {
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).ok()?;
        link.cast::<IPersistFile>().ok()?.Load(&HSTRING::from(lnk), STGM_READ).ok()?;
        let mut buf = [0u16; 1024];
        link.GetPath(&mut buf, std::ptr::null_mut(), 0).ok()?;
        let target = String::from_utf16_lossy(&buf[..buf.iter().position(|&c| c == 0)?]);
        (!target.is_empty()).then_some(target)
    })
}

/// An app picked with "Add app": its exe, or a shortcut to one (the Start menu is full of them).
#[tauri::command]
pub async fn focus_app(path: String) -> Result<FocusApp, String> {
    let path = if path.to_lowercase().ends_with(".lnk") { shortcut_target(&path).ok_or("That shortcut doesn't point to an app")? } else { path };
    let p = std::path::Path::new(&path);
    let exe = p.file_name().map(|n| n.to_string_lossy().to_lowercase()).filter(|n| n.ends_with(".exe") && p.is_file());
    let exe = exe.ok_or("Pick an app (.exe)")?;
    Ok(FocusApp { name: crate::openwith::display_name(&path, &path), icon: crate::openwith::icon(&path, 0), exe })
}

#[tauri::command]
pub fn focus_set(apps: Vec<String>) {
    *ALLOWED.lock().unwrap() = Some(apps.into_iter().map(|a| a.to_lowercase()).collect());
}

#[tauri::command]
pub fn focus_clear() {
    *ALLOWED.lock().unwrap() = None;
}

/// Minimises any app outside the session that comes to the front, and tells the UI ("focus-blocked"
/// with the app's name, at most every few seconds per app so a fight with one window isn't a flood).
pub fn spawn(window: WebviewWindow) {
    thread::spawn(move || {
        let mut last: Option<(String, Instant)> = None;
        loop {
            thread::sleep(Duration::from_millis(300));
            let Some(allowed) = ALLOWED.lock().unwrap().clone() else { continue };
            let hwnd = HWND(crate::platform::foreground_window() as *mut _);
            let Some((exe, path)) = exe_name(hwnd) else { continue };
            if !blocked(&exe, &allowed) {
                continue;
            }
            let _ = unsafe { ShowWindow(hwnd, SW_MINIMIZE) };
            if last.as_ref().is_some_and(|(e, at)| *e == exe && at.elapsed() < Duration::from_secs(4)) {
                continue;
            }
            let p = path.to_string_lossy();
            let _ = window.emit("focus-blocked", crate::openwith::display_name(&p, &p));
            last = Some((exe, Instant::now()));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_apps_outside_the_session_and_the_shell_are_blocked() {
        let allowed: HashSet<String> = ["code.exe".to_string()].into();
        assert!(!blocked("code.exe", &allowed));
        assert!(!blocked("explorer.exe", &allowed));
        assert!(!blocked("linnotch.exe", &allowed));
        assert!(blocked("chrome.exe", &allowed));
    }

    #[test]
    fn a_shortcut_resolves_to_its_app() {
        use windows::Win32::System::Com::{CLSCTX_INPROC_SERVER, CoCreateInstance, IPersistFile};
        use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};
        use windows::core::{HSTRING, Interface};
        let lnk = std::env::temp_dir().join(format!("linnotch-focus-{}.lnk", std::process::id()));
        let at = lnk.to_string_lossy().into_owned();
        crate::openwith::sta(move || unsafe {
            let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).unwrap();
            link.SetPath(&HSTRING::from(r"C:\Windows\notepad.exe")).unwrap();
            link.cast::<IPersistFile>().unwrap().Save(&HSTRING::from(at), true).unwrap();
        });
        let app = tauri::async_runtime::block_on(focus_app(lnk.to_string_lossy().into_owned()));
        let _ = std::fs::remove_file(&lnk);
        assert_eq!(app.map(|a| a.exe), Ok("notepad.exe".to_string()));
    }

    #[test]
    fn lists_open_apps_without_the_shell() {
        let apps = tauri::async_runtime::block_on(focus_apps());
        assert!(apps.iter().all(|a| !ALWAYS.contains(&a.exe.as_str()) && a.exe.ends_with(".exe")));
    }
}
