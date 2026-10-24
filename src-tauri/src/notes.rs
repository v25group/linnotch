//! Notes: plain-text files in Documents\linnotch\Notes that the island edits and Notepad opens,
//! plus text files you drop on the island (edited in place, for this session only). The UI can
//! only touch those two kinds of file.

use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

const MAX: u64 = 1 << 20;
/// Files you can drop on the island to read and edit as a note.
pub const TEXT: &[&str] = &["txt", "md", "markdown", "log", "json", "jsonc", "csv", "tsv", "ini", "cfg", "conf", "yaml", "yml", "toml", "xml", "env", "gitignore", "sql", "srt"];

/// Dropped files this session, which may be read and written like notes.
static OPENED: Mutex<Option<HashSet<PathBuf>>> = Mutex::new(None);

fn dir() -> Result<PathBuf, String> {
    let root = crate::platform::documents_dir().ok_or("can't find the Documents folder")?.join("linnotch");
    let dir = root.join("Notes");
    if !dir.is_dir() {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        // The first version kept one note next to this folder; bring it in.
        let old = root.join("Quick note.txt");
        if old.metadata().is_ok_and(|m| m.len() > 0) {
            let _ = std::fs::rename(&old, dir.join("Quick note.txt"));
        }
    }
    Ok(dir)
}

fn in_notes(path: &Path) -> bool {
    let (Ok(dir), Some(parent)) = (dir(), path.parent()) else { return false };
    parent.canonicalize().ok() == dir.canonicalize().ok() && path.extension().is_some_and(|e| e.eq_ignore_ascii_case("txt"))
}

/// Only our notes and files dropped on the island this session.
fn allowed(path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(path);
    if in_notes(&path) || OPENED.lock().unwrap().as_ref().is_some_and(|o| o.contains(&path)) {
        Ok(path)
    } else {
        Err("That file isn't one of your notes.".into())
    }
}

fn modified(path: &Path) -> u64 {
    path.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64)
}

const BOM: &[u8] = b"\xEF\xBB\xBF";

fn decode(bytes: &[u8]) -> Result<String, String> {
    let bytes = bytes.strip_prefix(BOM).unwrap_or(bytes);
    if bytes.contains(&0) {
        return Err("That looks like a binary file, not text.".into());
    }
    Ok(String::from_utf8_lossy(bytes).replace("\r\n", "\n"))
}

#[derive(Serialize)]
pub struct Note {
    path: String,
    name: String,
    text: String,
    /// When the file last changed (Unix ms), to notice edits made in Notepad.
    modified: u64,
    /// A dropped file, not one of the notes.
    external: bool,
}

fn read(path: &Path) -> Result<Note, String> {
    if path.metadata().map_err(|e| e.to_string())?.len() > MAX {
        return Err("That file is too big for a note (1 MB at most).".into());
    }
    Ok(Note {
        path: path.display().to_string(),
        name: path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
        text: decode(&std::fs::read(path).map_err(|e| e.to_string())?)?,
        modified: modified(path),
        external: !in_notes(path),
    })
}

#[derive(Serialize)]
pub struct NoteInfo {
    path: String,
    name: String,
    /// The first line, for the list.
    preview: String,
    modified: u64,
}

/// Your notes, newest first.
#[tauri::command]
pub fn notes_list() -> Result<Vec<NoteInfo>, String> {
    let mut list: Vec<NoteInfo> = std::fs::read_dir(dir()?)
        .map_err(|e| e.to_string())?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("txt")))
        .filter_map(|p| {
            let head: Vec<u8> = std::fs::read(&p).ok()?.into_iter().take(400).collect();
            let preview = decode(&head).ok()?.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("").chars().take(40).collect();
            Some(NoteInfo { path: p.display().to_string(), name: p.file_stem()?.to_string_lossy().into_owned(), preview, modified: modified(&p) })
        })
        .collect();
    list.sort_by(|a, b| b.modified.cmp(&a.modified));
    list.truncate(30);
    Ok(list)
}

#[tauri::command]
pub fn note_read(path: String) -> Result<Note, String> {
    read(&allowed(&path)?)
}

/// Saves keeping the file's own ways: a UTF-8 BOM and Windows line endings stay if it had them
/// (notes always use Windows line endings, so any Notepad shows the lines).
#[tauri::command]
pub fn note_write(path: String, text: String) -> Result<u64, String> {
    let path = allowed(&path)?;
    if text.len() as u64 > MAX {
        return Err("The note is too long (1 MB at most).".into());
    }
    let old = std::fs::read(&path).unwrap_or_default();
    let crlf = in_notes(&path) || old.windows(2).any(|w| w == b"\r\n");
    let text = text.replace("\r\n", "\n");
    let mut bytes = if old.starts_with(BOM) { BOM.to_vec() } else { vec![] };
    bytes.extend_from_slice(if crlf { text.replace('\n', "\r\n") } else { text }.as_bytes());
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(modified(&path))
}

/// Starts an empty note named after now ("Note 24 Oct 12.18"). Empty notes left over from
/// earlier New presses are cleared out first.
#[tauri::command]
pub fn note_new(stamp: String) -> Result<Note, String> {
    let dir = dir()?;
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let p = entry.path();
        if p.extension().is_some_and(|e| e.eq_ignore_ascii_case("txt")) && p.metadata().is_ok_and(|m| m.len() == 0) {
            let _ = std::fs::remove_file(&p);
        }
    }
    // The stamp comes from the UI (local date format); keep only what's safe in a file name.
    let stamp: String = stamp.chars().filter(|c| c.is_alphanumeric() || " .-,".contains(*c)).take(40).collect();
    for n in 1.. {
        let name = if n == 1 { format!("Note {stamp}.txt") } else { format!("Note {stamp} ({n}).txt") };
        let path = dir.join(name);
        if std::fs::OpenOptions::new().write(true).create_new(true).open(&path).is_ok() {
            return read(&path);
        }
    }
    unreachable!()
}

/// Opens a text file dropped on the island, to read and edit it as a note.
#[tauri::command]
pub fn note_import(path: String) -> Result<Note, String> {
    let path = PathBuf::from(path);
    let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let name = path.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    if !path.is_file() || !(TEXT.contains(&ext.as_str()) || name == ".env" || name == ".gitignore") {
        return Err("Only text files open as notes.".into());
    }
    let note = read(&path)?;
    if note.external {
        OPENED.lock().unwrap().get_or_insert_default().insert(path);
    }
    Ok(note)
}

/// Deletes one of your notes (never a dropped file).
#[tauri::command]
pub fn note_delete(path: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    if !in_notes(&path) {
        return Err("Only notes made here can be deleted here.".into());
    }
    std::fs::remove_file(path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn note_open(path: String) -> Result<(), String> {
    let path = allowed(&path)?;
    std::process::Command::new("notepad.exe").arg(path).spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_is_decoded_and_binary_refused() {
        assert_eq!(decode(b"\xEF\xBB\xBFone\r\ntwo").unwrap(), "one\ntwo");
        assert!(decode(b"PK\x03\x04\x00\x00").is_err());
    }

    #[test]
    fn files_outside_the_notes_are_off_limits() {
        assert!(allowed(r"C:\Windows\win.ini").is_err());
        assert!(note_delete(r"C:\Windows\win.ini".into()).is_err());
    }
}
