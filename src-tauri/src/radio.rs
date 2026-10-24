//! "Now on air" for radio: most stations (Shoutcast/Icecast) put the current song's title inside
//! the stream every few KB when asked with `Icy-MetaData: 1`. The webview's <audio> can't read
//! that, so a second connection here reads only the titles and sends them as "radio-title".

use serde::Serialize;
use std::io::Read;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::{Emitter, WebviewWindow};

/// Bumped whenever the station changes or stops; an older reader sees it and quits.
static GENERATION: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Serialize)]
struct OnAir {
    id: String,
    title: String,
}

/// `StreamTitle='Artist - Song';StreamUrl='';` -> "Artist - Song".
fn stream_title(meta: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(meta);
    let start = text.find("StreamTitle='")? + "StreamTitle='".len();
    let end = text[start..].find("';").unwrap_or(text.len() - start);
    let title = text[start..start + end].trim();
    (!title.is_empty() && title != "-").then(|| title.to_string())
}

/// Reads titles from `url` until the stream ends, it has none, or `keep_going` says stop.
// shortcut: a second connection downloads the audio again just to read titles (~128 kbps), proxy the stream through Rust if that bandwidth matters
fn read_titles(url: &str, mut on_title: impl FnMut(String), keep_going: impl Fn() -> bool) -> Result<(), String> {
    let agent = ureq::Agent::config_builder().timeout_connect(Some(Duration::from_secs(8))).build().new_agent();
    let res = agent.get(url).header("Icy-MetaData", "1").call().map_err(|e| e.to_string())?;
    let every: usize = res
        .headers()
        .get("icy-metaint")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse().ok())
        .ok_or("station sends no song titles")?;
    let mut body = res.into_body().into_reader();
    let (mut audio, mut last) = (vec![0u8; every], String::new());
    while keep_going() {
        body.read_exact(&mut audio).map_err(|e| e.to_string())?;
        let mut len = [0u8];
        body.read_exact(&mut len).map_err(|e| e.to_string())?;
        if len[0] == 0 {
            continue;
        }
        let mut meta = vec![0u8; len[0] as usize * 16];
        body.read_exact(&mut meta).map_err(|e| e.to_string())?;
        if let Some(title) = stream_title(&meta).filter(|t| *t != last) {
            last = title.clone();
            on_title(title);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn radio_watch(window: WebviewWindow, id: String, url: String) {
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    std::thread::spawn(move || {
        let current = || GENERATION.load(Ordering::SeqCst) == generation;
        // A dropped connection is retried a couple of times; a station without titles isn't.
        for _ in 0..3 {
            let result = read_titles(&url, |title| drop(window.emit("radio-title", OnAir { id: id.clone(), title })), current);
            if !current() || matches!(&result, Err(e) if e.contains("no song titles")) {
                return;
            }
            std::thread::sleep(Duration::from_secs(5));
        }
    });
}

#[tauri::command]
pub fn radio_stop() {
    GENERATION.fetch_add(1, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_stream_titles() {
        assert_eq!(stream_title(b"StreamTitle='A.R. Rahman - Jai Ho';StreamUrl='';\0\0").as_deref(), Some("A.R. Rahman - Jai Ho"));
        assert_eq!(stream_title(b"StreamTitle='It''s fine';").as_deref(), Some("It''s fine"));
        assert_eq!(stream_title(b"StreamTitle='';"), None);
        assert_eq!(stream_title(b"StreamTitle=' - ';"), None);
        assert_eq!(stream_title(b"garbage"), None);
    }
}

