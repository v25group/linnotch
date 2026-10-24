//! The local music library: scans a folder for audio files the webview can play, reads their
//! tags, and lets the webview load them through the asset protocol.

use base64::Engine;
use lofty::prelude::*;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// Formats WebView2 (Chromium) plays natively.
const PLAYABLE: &[&str] = &["mp3", "m4a", "aac", "wav", "flac", "ogg", "opus", "oga", "webm"];
// shortcut: stops after this many files, page/stream the scan if huge libraries show up
const MAX_TRACKS: usize = 5000;

#[derive(Serialize)]
pub struct Track {
    path: String,
    title: String,
    artist: String,
    album: String,
    /// Milliseconds; 0 when unknown.
    duration: u64,
}

fn playable(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()).is_some_and(|e| PLAYABLE.contains(&e.to_ascii_lowercase().as_str()))
}

/// Every playable file under `dir`, depth-first, skipping hidden folders.
fn collect(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = entries.flatten().map(|e| e.path()).collect();
    entries.sort();
    for path in entries {
        if out.len() >= MAX_TRACKS {
            return;
        }
        let hidden = path.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with('.'));
        if path.is_dir() && !hidden {
            collect(&path, out);
        } else if playable(&path) {
            out.push(path);
        }
    }
}

/// Reads tags leniently: plenty of downloaded MP3s have small defects (or the wrong extension)
/// that the default mode rejects outright, losing title, length and cover.
fn open(path: &Path) -> Option<lofty::file::TaggedFile> {
    use lofty::config::{ParseOptions, ParsingMode};
    lofty::probe::Probe::open(path).ok()?
        .options(ParseOptions::new().parsing_mode(ParsingMode::Relaxed))
        .guess_file_type().ok()?
        .read().ok()
}

fn read_track(path: &Path) -> Track {
    let file = open(path);
    let tag = file.as_ref().and_then(|f| f.primary_tag().or_else(|| f.first_tag()));
    let text = |v: Option<std::borrow::Cow<str>>| v.map(|s| s.trim().to_string()).unwrap_or_default();
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let title = text(tag.and_then(|t| t.title()));
    Track {
        path: path.to_string_lossy().into_owned(),
        title: if title.is_empty() { stem } else { title },
        artist: text(tag.and_then(|t| t.artist())),
        album: text(tag.and_then(|t| t.album())),
        duration: file.map_or(0, |f| f.properties().duration().as_millis() as u64),
    }
}

/// Scans `dir` (default: the user's Music folder) and lets the webview play files from it.
#[tauri::command]
pub async fn scan_library(app: AppHandle, dir: Option<String>) -> Result<(String, Vec<Track>), String> {
    let dir = match dir {
        Some(d) => PathBuf::from(d),
        None => app.path().audio_dir().map_err(|e| e.to_string())?,
    };
    if !dir.is_dir() {
        return Err(format!("not a folder: {}", dir.display()));
    }
    app.asset_protocol_scope().allow_directory(&dir, true).map_err(|e| e.to_string())?;
    let shown = dir.to_string_lossy().into_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let mut paths = vec![];
        collect(&dir, &mut paths);
        (shown, paths.iter().map(|p| read_track(p)).collect())
    })
    .await
    .map_err(|e| e.to_string())
}

/// Tags for files dropped on the island's player tile; also lets the webview play them.
#[tauri::command]
pub async fn read_tracks(app: AppHandle, paths: Vec<String>) -> Result<Vec<Track>, String> {
    let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).filter(|p| p.is_file() && playable(p)).collect();
    for p in &paths {
        app.asset_protocol_scope().allow_file(p).map_err(|e| e.to_string())?;
    }
    tauri::async_runtime::spawn_blocking(move || paths.iter().map(|p| read_track(p)).collect()).await.map_err(|e| e.to_string())
}

/// The cover embedded in the file, or a cover/folder image next to it, as a data: URL.
#[tauri::command]
pub async fn track_art(path: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(path);
        let encode = |mime: &str, bytes: &[u8]| format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes));
        if let Some(pic) = open(&path).and_then(|f| {
            f.tags().iter().flat_map(|t| t.pictures()).next().cloned()
        }) {
            return Some(encode(pic.mime_type().map_or("image/jpeg", |m| m.as_str()), pic.data()));
        }
        let dir = path.parent()?;
        ["cover.jpg", "cover.png", "folder.jpg", "folder.png", "front.jpg"].iter().find_map(|name| {
            let bytes = std::fs::read(dir.join(name)).ok()?;
            Some(encode(if name.ends_with("png") { "image/png" } else { "image/jpeg" }, &bytes))
        })
    })
    .await
    .ok()
    .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    #[test]
    fn scans_tags_and_cover_and_skips_what_it_cannot_play() {
        let dir = std::env::temp_dir().join(format!("island-library-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("album")).unwrap();
        std::fs::create_dir_all(dir.join(".hidden")).unwrap();
        let ff = |args: &[&str]| assert!(Command::new("ffmpeg").args(["-v", "error", "-y"]).args(args).status().unwrap().success());
        let song = dir.join("album/song.mp3");
        ff(&["-f", "lavfi", "-i", "color=red:s=64x64", "-frames:v", "1", dir.join("cover.png").to_str().unwrap()]);
        ff(&["-f", "lavfi", "-t", "2", "-i", "anullsrc", "-i", dir.join("cover.png").to_str().unwrap(), "-map", "0:a", "-map", "1:v",
            "-c:v", "png", "-disposition:v", "attached_pic", "-metadata", "title=Tagged", "-metadata", "artist=Someone", song.to_str().unwrap()]);
        ff(&["-f", "lavfi", "-t", "1", "-i", "anullsrc", dir.join("plain.wav").to_str().unwrap()]);
        std::fs::copy(dir.join("plain.wav"), dir.join(".hidden/secret.wav")).unwrap();
        std::fs::write(dir.join("notes.txt"), "x").unwrap();

        let mut paths = vec![];
        collect(&dir, &mut paths);
        let tracks: Vec<Track> = paths.iter().map(|p| read_track(p)).collect();
        assert_eq!(tracks.len(), 2, "hidden folders and non-audio files are skipped");
        let tagged = tracks.iter().find(|t| t.path.ends_with("song.mp3")).unwrap();
        assert_eq!((tagged.title.as_str(), tagged.artist.as_str()), ("Tagged", "Someone"));
        assert!((1900..2200).contains(&tagged.duration), "duration {}", tagged.duration);
        let plain = tracks.iter().find(|t| t.path.ends_with("plain.wav")).unwrap();
        assert_eq!(plain.title, "plain", "untagged files fall back to the file name");

        let art = tauri::async_runtime::block_on(track_art(tagged.path.clone())).unwrap();
        assert!(art.starts_with("data:image/png;base64,"));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

