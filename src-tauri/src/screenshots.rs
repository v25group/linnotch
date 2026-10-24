//! The screenshot shelf: watches Pictures\Screenshots (where Win+PrtScn and the Snipping Tool
//! save) and sends each new one as a "screenshot" event; lists the recent ones for the shelf.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

const SHELF: usize = 24;

#[derive(Clone, Serialize, PartialEq)]
pub struct Shot {
    path: String,
    /// Unix ms the file was written.
    at: i64,
}

fn folder(app: &AppHandle) -> Option<PathBuf> {
    app.path().picture_dir().ok().map(|p| p.join("Screenshots"))
}

fn list(dir: &Path) -> Vec<Shot> {
    let mut shots: Vec<Shot> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().extension().and_then(|x| x.to_str()).is_some_and(|x| ["png", "jpg", "jpeg"].contains(&x.to_ascii_lowercase().as_str())))
        .filter_map(|e| {
            let at = e.metadata().ok()?.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_millis() as i64;
            Some(Shot { path: e.path().to_string_lossy().into_owned(), at })
        })
        .collect();
    shots.sort_by(|a, b| b.at.cmp(&a.at));
    shots.truncate(SHELF);
    shots
}

pub fn spawn(app: AppHandle, window: WebviewWindow) {
    let Some(dir) = folder(&app) else { return };
    let _ = std::fs::create_dir_all(&dir);
    let _ = app.asset_protocol_scope().allow_directory(&dir, false);
    std::thread::spawn(move || {
        let mut newest = list(&dir).first().map_or(0, |s| s.at);
        // shortcut: polls the folder every second, use ReadDirectoryChangesW if that ever shows up in CPU use
        loop {
            std::thread::sleep(Duration::from_secs(1));
            let Some(latest) = list(&dir).into_iter().next() else { continue };
            if latest.at > newest {
                newest = latest.at;
                // The Snipping Tool writes the file in steps; give it a moment to finish.
                std::thread::sleep(Duration::from_millis(400));
                let _ = window.emit("screenshot", &latest);
            }
        }
    });
}

/// Only files in the Screenshots folder can be touched through these commands.
fn checked(app: &AppHandle, path: &str) -> Result<PathBuf, String> {
    let dir = folder(app).ok_or("no Pictures folder")?;
    let path = PathBuf::from(path);
    if !crate::platform::directly_in(&path, &dir) || !path.is_file() {
        return Err("not a screenshot".into());
    }
    Ok(path)
}

#[tauri::command]
pub fn screenshots(app: AppHandle) -> Vec<Shot> {
    folder(&app).map(|d| list(&d)).unwrap_or_default()
}

#[tauri::command]
pub async fn screenshot_copy(app: AppHandle, path: String) -> Result<(), String> {
    let path = checked(&app, &path)?;
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        let (w, h, rgba) = crate::clipboard::decode_png(&bytes)?;
        crate::clipboard::set_image(w, h, rgba)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Opens the screenshot in the default image viewer.
#[tauri::command]
pub fn screenshot_open(app: AppHandle, path: String) -> Result<(), String> {
    let path = checked(&app, &path)?;
    crate::platform::explorer(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_newest_images_first() {
        let dir = std::env::temp_dir().join(format!("linnotch-shots-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        for (i, name) in ["old.png", "notes.txt", "new.PNG"].iter().enumerate() {
            std::fs::write(dir.join(name), b"x").unwrap();
            if i < 2 {
                std::thread::sleep(Duration::from_millis(30));
            }
        }
        let names: Vec<_> = list(&dir).iter().map(|s| Path::new(&s.path).file_name().unwrap().to_string_lossy().into_owned()).collect();
        assert_eq!(names, ["new.PNG", "old.png"]);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
