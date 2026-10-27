//! The Bookshelf tab: apps, folders and files pinned to open in one click (src/features/pins/pins.tsx
//! keeps the list). Pinned with "Add" or by Ctrl+dropping onto the island.

use std::path::Path;

use serde::Serialize;

#[derive(Serialize)]
pub struct Pin {
    path: String,
    name: String,
    /// "app", "folder" or "file".
    kind: &'static str,
    icon: Option<String>,
}

/// What to show for a path being pinned. Shortcuts stay shortcuts, so their arguments still apply.
#[tauri::command]
pub async fn pin_info(path: String) -> Result<Pin, String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err(format!("{path} doesn't exist"));
    }
    let ext = p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let kind = if p.is_dir() { "folder" } else if ext == "exe" || ext == "lnk" { "app" } else { "file" };
    // "Report.pdf" keeps its extension; "Google Chrome.lnk" shows as "Google Chrome".
    let name = if ext == "exe" {
        crate::openwith::display_name(&path, &path)
    } else {
        let part = if ext == "lnk" { p.file_stem() } else { p.file_name() };
        part.map_or_else(|| path.clone(), |n| n.to_string_lossy().into_owned())
    };
    Ok(Pin { kind, icon: crate::openwith::path_image(&path, kind == "file"), name, path })
}

/// Opens a pin the way a double-click in Explorer would.
#[tauri::command]
pub fn pin_open(path: String) -> Result<(), String> {
    if !Path::new(&path).exists() {
        return Err("It was moved or deleted".into());
    }
    crate::platform::explorer(&path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn describes_apps_folders_and_files() {
        let info = |p: &str| tauri::async_runtime::block_on(pin_info(p.into()));
        let notepad = info(r"C:\Windows\notepad.exe").unwrap();
        assert_eq!((notepad.kind, notepad.icon.is_some()), ("app", true));
        let windows = info(r"C:\Windows").unwrap();
        assert_eq!((windows.kind, windows.name.as_str()), ("folder", "Windows"));
        assert_eq!(info(r"C:\Windows\win.ini").unwrap().kind, "file");
        assert!(info(r"C:\no\such\thing.txt").is_err());
    }
}
