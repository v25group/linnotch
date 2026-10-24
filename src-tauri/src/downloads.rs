//! "Download finished": watches the Downloads folder and sends a "download" event once a new
//! file has stopped changing. Browsers download into temporary names (.crdownload, .part...) and
//! rename the file when it's done, so those are ignored until they become the real file.

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

const TEMPORARY: &[&str] = &["crdownload", "part", "partial", "tmp", "download", "opdownload", "!ut", "temp"];

#[derive(Clone, Serialize)]
pub struct Download {
    path: String,
    name: String,
    size: u64,
}

fn finished(path: &Path) -> bool {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    !name.starts_with('.') && !name.starts_with("~$") && !TEMPORARY.contains(&ext.as_str())
}

/// Files in `dir` with their sizes (folders and temporary files left out).
fn snapshot(dir: &Path) -> HashMap<PathBuf, u64> {
    std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            (meta.is_file() && finished(&e.path())).then(|| (e.path(), meta.len()))
        })
        .collect()
}

/// Paths that are new since `known` and haven't changed size since the last look (`pending`).
fn settled(now: &HashMap<PathBuf, u64>, known: &mut HashSet<PathBuf>, pending: &mut HashMap<PathBuf, u64>) -> Vec<(PathBuf, u64)> {
    let mut done = vec![];
    for (path, &size) in now {
        if known.contains(path) {
            continue;
        }
        match pending.insert(path.clone(), size) {
            Some(before) if before == size && size > 0 => {
                pending.remove(path);
                known.insert(path.clone());
                done.push((path.clone(), size));
            }
            _ => {}
        }
    }
    pending.retain(|p, _| now.contains_key(p));
    known.retain(|p| now.contains_key(p));
    done
}

pub fn spawn(app: AppHandle, window: WebviewWindow) {
    let Ok(dir) = app.path().download_dir() else { return };
    std::thread::spawn(move || {
        let mut known: HashSet<PathBuf> = snapshot(&dir).into_keys().collect();
        let mut pending = HashMap::new();
        // shortcut: polls every 1.5 s, use ReadDirectoryChangesW if this shows up in CPU use
        loop {
            std::thread::sleep(Duration::from_millis(1500));
            for (path, size) in settled(&snapshot(&dir), &mut known, &mut pending) {
                let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                let _ = window.emit("download", Download { path: path.to_string_lossy().into_owned(), name, size });
            }
        }
    });
}

/// Opens a finished download with its default app. Only files in Downloads.
#[tauri::command]
pub fn open_download(app: AppHandle, path: String) -> Result<(), String> {
    let dir = app.path().download_dir().map_err(|e| e.to_string())?;
    let path = PathBuf::from(path);
    if path.parent().and_then(|p| p.canonicalize().ok()) != dir.canonicalize().ok() || !path.is_file() {
        return Err("not a download".into());
    }
    std::process::Command::new("explorer.exe").arg(path).spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_download_is_announced_once_it_stops_growing() {
        let mut known = HashSet::from([PathBuf::from("old.zip")]);
        let mut pending = HashMap::new();
        let look = |files: &[(&str, u64)]| files.iter().map(|(n, s)| (PathBuf::from(n), *s)).collect::<HashMap<_, _>>();

        assert!(settled(&look(&[("old.zip", 5), ("song.mp3", 100)]), &mut known, &mut pending).is_empty(), "first sighting: wait");
        assert!(settled(&look(&[("old.zip", 5), ("song.mp3", 300)]), &mut known, &mut pending).is_empty(), "still growing");
        let done = settled(&look(&[("old.zip", 5), ("song.mp3", 300)]), &mut known, &mut pending);
        assert_eq!(done, [(PathBuf::from("song.mp3"), 300)]);
        assert!(settled(&look(&[("old.zip", 5), ("song.mp3", 300)]), &mut known, &mut pending).is_empty(), "announced only once");

        assert!(!finished(Path::new("movie.mkv.crdownload")));
        assert!(!finished(Path::new("setup.exe.part")));
        assert!(finished(Path::new("report.pdf")));
    }
}
