#[cfg(windows)]
mod clipboard;
mod convert;
#[cfg(windows)]
mod dev;
#[cfg(windows)]
mod downloads;
mod library;
#[cfg(windows)]
mod notes;
#[cfg(windows)]
mod openwith;
mod radio;
#[cfg(windows)]
mod screenshots;
#[cfg(windows)]
mod toggles;
#[cfg(windows)]
mod media;
mod platform;
#[cfg(windows)]
mod system;

use serde::Serialize;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::{thread, time::Duration};
use tauri::{Emitter, Manager, PhysicalPosition, State, WebviewWindow};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

/// What the UI is showing: the pill's target size (logical px) and whether it must stay open.
#[derive(Clone, Copy)]
struct Pill {
    width: f64,
    height: f64,
    pinned: bool,
}

#[derive(Clone)]
struct PillState(Arc<Mutex<Pill>>);

#[tauri::command]
fn set_pill(state: State<PillState>, width: f64, height: f64, pinned: bool) {
    *state.0.lock().unwrap() = Pill { width, height, pinned };
}

// Runs ffprobe, and is called while a file is being dragged, so keep it off the main thread.
#[tauri::command]
async fn inspect(path: String) -> Result<convert::FileInfo, String> {
    tauri::async_runtime::spawn_blocking(move || convert::inspect(PathBuf::from(path).as_path()))
        .await
        .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
struct Converted {
    out: String,
    size: u64,
}

#[tauri::command]
async fn convert_file(window: WebviewWindow, path: String, preset: String) -> Result<Converted, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut last = -1.0;
        let out = convert::convert(PathBuf::from(path).as_path(), &preset, |p| {
            // ffmpeg reports several times a second; only send whole-percent changes.
            if p - last >= 0.01 {
                last = p;
                let _ = window.emit("progress", p);
            }
        })?;
        let size = out.metadata().map(|m| m.len()).unwrap_or(0);
        Ok(Converted { out: out.to_string_lossy().into_owned(), size })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Open Explorer with the file selected.
#[tauri::command]
fn reveal(path: String) -> Result<(), String> {
    if !PathBuf::from(&path).is_file() {
        return Err(format!("not a file: {path}"));
    }
    std::process::Command::new("explorer")
        .arg(format!("/select,{path}"))
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Is `(x, y)` (logical px, relative to a window `window_w` wide) inside the pill?
fn in_pill((x, y): (f64, f64), pill: Pill, window_w: f64) -> bool {
    let left = (window_w - pill.width) / 2.0;
    (left..=left + pill.width).contains(&x) && (0.0..=pill.height).contains(&y)
}

/// The window gets no mouse events while click-through, so poll the cursor and tell the UI.
/// `origin` and `scale` are where we placed the window; `outer_position()` isn't used because
/// it jumps by the hidden frame size whenever click-through toggles.
fn watch(window: WebviewWindow, hwnd: isize, origin: PhysicalPosition<i32>, scale: f64, window_w: f64, pill: PillState) {
    let (mut hovered, mut hidden, mut click_through) = (false, false, false);
    let mut battery = None;
    let (mut was_over, mut was_shift, mut foreground) = (false, false, 0);
    for tick in 0u64.. {
        let now_hidden = platform::fullscreen_app_running();
        let cursor = window
            .cursor_position()
            .ok()
            .map(|c| ((c.x - origin.x as f64) / scale, (c.y - origin.y as f64) / scale));
        let pill = *pill.0.lock().unwrap();
        let over = !now_hidden && cursor.is_some_and(|c| in_pill(c, pill, window_w));
        // A file dragged onto the island opens "Open with"; with Shift held it shows the formats instead.
        // Drag events don't carry modifier keys, so Shift is reported on its own.
        let shift = platform::shift_held();
        if shift != was_shift {
            was_shift = shift;
            let _ = window.emit("shift", shift);
        }
        // Pinned keeps the island open, but only the cursor being over it makes it catch the mouse:
        // the transparent rest of the window must never block clicks or scrolling underneath.
        let now_hovered = !now_hidden && (pill.pinned || over);

        if over != was_over {
            was_over = over;
            let _ = window.emit("over", over);
        }
        if now_hovered != hovered {
            hovered = now_hovered;
            let _ = window.emit("hover", hovered);
        }
        // Re-sent every second too: an event fired before the UI started listening is lost.
        if now_hidden != hidden || tick % 30 == 0 {
            hidden = now_hidden;
            let _ = window.emit("hidden", hidden);
        }
        if tick % 15 == 0 {
            let now = platform::battery();
            // Re-sent every 30 ticks like "hidden", so the UI gets it even if it started late.
            if now != battery || tick % 30 == 0 {
                battery = now;
                let _ = window.emit("battery", battery);
            }
        }
        if click_through == over {
            click_through = !over;
            platform::set_click_through(hwnd, click_through);
        }
        // Stay above other windows: re-assert on every focus change, and once a second for
        // windows that cover us without taking focus. Not over fullscreen games and videos.
        let now_foreground = platform::foreground_window();
        // Not while a mouse button is held (repositioning the window cancels a drag or text
        // selection in the webview) or while the island itself has focus (it's on top then).
        let busy = platform::left_button_held() || now_foreground == hwnd;
        if !now_hidden && !busy && (now_foreground != foreground || tick % 30 == 0) {
            platform::keep_on_top(hwnd);
        }
        foreground = now_foreground;
        platform::remember_foreground(now_foreground, hwnd);
        // shortcut: polls at ~30Hz, swap for a low-level mouse hook if CPU use shows up
        thread::sleep(Duration::from_millis(33));
    }
}

/// Global shortcuts: Ctrl+Alt plus a key. The UI gets the action name as a "shortcut" event;
/// the list it shows people lives in src/features/shortcuts/shortcuts.tsx.
const SHORTCUTS: &[(Code, &str)] = &[
    (Code::Space, "toggle"),
    (Code::KeyN, "next"),
    (Code::KeyB, "previous"),
    (Code::KeyI, "open"),
    (Code::KeyL, "library"),
    (Code::KeyR, "radio"),
    (Code::KeyT, "timer"),
    (Code::KeyV, "clipboard"),
    (Code::KeyS, "shelf"),
    (Code::KeyD, "dev"),
];

/// Where people report problems and ideas (the repo takes issues, not pull requests).
pub const ISSUES_URL: &str = "https://github.com/v25group/linnotch/issues";

/// The tray icon: the only way to quit the island, plus start-with-Windows and a way to report issues.
fn tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::TrayIconBuilder;
    let version = MenuItem::with_id(app, "version", format!("linnotch {} · V25Group", env!("CARGO_PKG_VERSION")), false, None::<&str>)?;
    let startup = CheckMenuItem::with_id(app, "startup", "Start with Windows", true, platform::starts_with_windows(), None::<&str>)?;
    let issue = MenuItem::with_id(app, "issue", "Report an issue or idea…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit linnotch", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&version, &PredefinedMenuItem::separator(app)?, &startup, &issue, &PredefinedMenuItem::separator(app)?, &quit])?;
    let check = startup.clone();
    let mut tray = TrayIconBuilder::with_id("main").tooltip("linnotch").menu(&menu).show_menu_on_left_click(true);
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.on_menu_event(move |app, event| match event.id().as_ref() {
        "startup" => {
            // The check mark flips by itself on click; make the setting follow it.
            let on = check.is_checked().unwrap_or(false);
            platform::set_start_with_windows(on);
        }
        "issue" => {
            let _ = std::process::Command::new("explorer.exe").arg(ISSUES_URL).spawn();
        }
        "quit" => app.exit(0),
        _ => {}
    })
    .build(app)?;
    Ok(())
}

fn shortcut(code: Code) -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), code)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // The uninstaller runs `linnotch.exe --cleanup` to undo what the Developer tab set up.
    #[cfg(windows)]
    if std::env::args().any(|a| a == "--cleanup") {
        dev::cleanup();
        platform::set_start_with_windows(false);
        return;
    }
    #[cfg(windows)]
    if !platform::first_instance() {
        return;
    }
    // Started from inside VS Code (its terminal, an extension) the island inherits
    // ELECTRON_RUN_AS_NODE=1 and VS Code's own variables; anything it launches would inherit them
    // too, and Electron apps (VS Code, Cursor...) then start as plain Node and exit at once.
    for (key, _) in std::env::vars_os() {
        let key_str = key.to_string_lossy();
        if key_str == "ELECTRON_RUN_AS_NODE" || key_str.starts_with("VSCODE_") {
            // SAFETY: runs first thing in run(), before Tauri or any of our threads start.
            unsafe { std::env::remove_var(&key) };
        }
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_drag::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, pressed, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    if let Some((_, action)) = SHORTCUTS.iter().find(|(code, _)| shortcut(*code) == *pressed) {
                        let _ = app.emit("shortcut", action);
                    }
                })
                .build(),
        )
        .setup(|app| {
            let window = app.get_webview_window("main").expect("main window is in tauri.conf.json");
            let m = window.primary_monitor()?.ok_or("no primary monitor")?;
            let scale = m.scale_factor();
            let width = window.outer_size()?.width as i32;
            let origin = PhysicalPosition::new(m.position().x + (m.size().width as i32 - width) / 2, m.position().y);
            // The window must be created visible (tauri.conf.json): if it's shown later, WebView2
            // re-registers its own drop target over wry's and every file drop is rejected.
            window.set_position(origin)?;
            let hwnd = window.hwnd()?.0 as isize;
            platform::hide_from_alt_tab(hwnd);

            // Until the UI reports its size, assume the collapsed pill from src/App.tsx.
            let pill = PillState(Arc::new(Mutex::new(Pill { width: 406.0, height: 34.0, pinned: false })));
            app.manage(pill.clone());
            #[cfg(windows)]
            system::spawn(window.clone());
            #[cfg(windows)]
            media::spawn(window.clone());
            #[cfg(windows)]
            clipboard::spawn(window.clone());
            #[cfg(windows)]
            dev::spawn(window.clone());
            #[cfg(windows)]
            screenshots::spawn(app.handle().clone(), window.clone());
            #[cfg(windows)]
            downloads::spawn(app.handle().clone(), window.clone());
            // A shortcut another app already owns is skipped rather than stopping the island.
            for (code, action) in SHORTCUTS {
                if let Err(e) = app.global_shortcut().register(shortcut(*code)) {
                    eprintln!("shortcut for {action} not available: {e}");
                }
            }
            tray(app)?;
            thread::spawn(move || watch(window, hwnd, origin, scale, width as f64 / scale, pill));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![set_pill, inspect, convert_file, reveal, media::media_control, media::media_seek, media::media_art, library::scan_library, library::track_art, library::read_tracks, system::open_app, system::dismiss_notification,
            clipboard::clipboard_list, clipboard::clipboard_copy, clipboard::clipboard_paste, clipboard::clipboard_remove, clipboard::clipboard_clear,
            screenshots::screenshots, screenshots::screenshot_copy, screenshots::screenshot_open,
            downloads::open_download, toggles::toggles, toggles::set_toggle, toggles::open_notification_center, openwith::apps_for, openwith::open_with, radio::radio_watch, radio::radio_stop,
            dev::focus_window, dev::ports, dev::stop_port, dev::open_url, dev::meters, dev::github, dev::dev_setup, dev::install_cli, dev::connect_claude, clipboard::clipboard_write,
            dev::answer_ask, dev::free_port, dev::containers, dev::stop_container, dev::shell_watch, notes::notes_list, notes::note_read, notes::note_write, notes::note_new, notes::note_import, notes::note_delete, notes::note_open])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pill_hit_area_follows_the_reported_size() {
        let small = Pill { width: 200.0, height: 34.0, pinned: false };
        let big = Pill { width: 480.0, height: 160.0, ..small };
        let window_w = 520.0;
        assert!(in_pill((260.0, 20.0), small, window_w));
        assert!(!in_pill((260.0, 40.0), small, window_w), "below the pill is click-through");
        let near_right_edge = (260.0 + 200.0, 100.0);
        assert!(!in_pill(near_right_edge, small, window_w));
        assert!(in_pill(near_right_edge, big, window_w));
    }
}
