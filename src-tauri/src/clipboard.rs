//! Clipboard history: the last things copied (text and images), kept in memory only, never on
//! disk. Anything an app marks as private (password managers) is skipped. The UI gets the list
//! as "clipboard" events and can copy an item back, or paste it straight into the last window.

use base64::Engine;
use serde::Serialize;
use std::borrow::Cow;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{Emitter, WebviewWindow};

use crate::platform;

const MAX_ITEMS: usize = 40;
const MAX_IMAGES: usize = 6; // full images are kept (as PNG) so they can be copied back
const MAX_TEXT: usize = 200_000;
const THUMB: usize = 320; // px, longest side of the preview

#[derive(Clone, Serialize)]
pub struct Clip {
    id: u64,
    text: Option<String>,
    /// PNG data: URL preview for images.
    image: Option<String>,
    width: usize,
    height: usize,
    /// Unix ms.
    at: i64,
    /// What kind of secret it looks like ("GitHub token"...). Shown masked and forgotten after
    /// SECRET_MS, and taken off the clipboard then too if it's still there.
    secret: Option<&'static str>,
}

const SECRET_MS: i64 = 60_000;

/// API keys, tokens, private keys and database URLs with a password in them.
fn secret_kind(text: &str) -> Option<&'static str> {
    let t = text.trim();
    if t.starts_with("-----BEGIN") && t.contains("PRIVATE KEY-----") {
        return Some("Private key");
    }
    if t.chars().any(char::is_whitespace) || t.len() > 4096 {
        return None;
    }
    let token = |prefix: &str, min: usize| t.starts_with(prefix) && t.len() >= min && t.chars().all(|c| c.is_ascii_alphanumeric() || "_-".contains(c));
    let known: &[(&str, usize, &str)] = &[
        ("sk-ant-", 40, "Anthropic key"), ("sk-", 40, "OpenAI key"), ("github_pat_", 40, "GitHub token"), ("ghp_", 40, "GitHub token"),
        ("gho_", 40, "GitHub token"), ("ghu_", 40, "GitHub token"), ("ghs_", 40, "GitHub token"), ("glpat-", 26, "GitLab token"),
        ("xoxb-", 24, "Slack token"), ("xoxp-", 24, "Slack token"), ("sk_live_", 24, "Stripe key"), ("rk_live_", 24, "Stripe key"),
        ("npm_", 40, "npm token"), ("AIza", 39, "Google API key"), ("hf_", 34, "Hugging Face token"),
    ];
    if let Some((_, _, kind)) = known.iter().find(|(prefix, min, _)| token(prefix, *min)) {
        return Some(kind);
    }
    if t.len() == 20 && (t.starts_with("AKIA") || t.starts_with("ASIA")) && t.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()) {
        return Some("AWS key");
    }
    // scheme://user:password@host
    let (scheme, rest) = t.split_once("://")?;
    let schemes = ["postgres", "postgresql", "mysql", "mariadb", "mongodb", "mongodb+srv", "redis", "rediss", "amqp", "amqps"];
    let creds = rest.split_once('@')?.0;
    (schemes.contains(&scheme.to_ascii_lowercase().as_str()) && creds.split_once(':').is_some_and(|(_, pass)| !pass.is_empty())).then_some("Database URL with password")
}

struct Entry {
    clip: Clip,
    /// The whole image as PNG, to copy it back at full size.
    png: Option<Vec<u8>>,
    hash: u64,
}

static HISTORY: Mutex<Vec<Entry>> = Mutex::new(Vec::new());
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

fn hash<T: Hash + ?Sized>(v: &T) -> u64 {
    let mut h = DefaultHasher::new();
    v.hash(&mut h);
    h.finish()
}

fn encode_png(width: usize, height: usize, rgba: &[u8]) -> Option<Vec<u8>> {
    let mut out = vec![];
    {
        let mut enc = png::Encoder::new(&mut out, width as u32, height as u32);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        enc.write_header().ok()?.write_image_data(rgba).ok()?;
    }
    Some(out)
}

/// Box-averaged downscale so the longest side is at most `max`.
fn shrink(width: usize, height: usize, rgba: &[u8], max: usize) -> (usize, usize, Vec<u8>) {
    let scale = (width.max(height) as f64 / max as f64).max(1.0);
    let (w, h) = (((width as f64 / scale).round() as usize).max(1), ((height as f64 / scale).round() as usize).max(1));
    let mut out = vec![0u8; w * h * 4];
    for y in 0..h {
        for x in 0..w {
            let (x0, x1) = (x * width / w, ((x + 1) * width / w).max(x * width / w + 1));
            let (y0, y1) = (y * height / h, ((y + 1) * height / h).max(y * height / h + 1));
            let mut sum = [0u32; 4];
            for sy in y0..y1 {
                for sx in x0..x1 {
                    let i = (sy * width + sx) * 4;
                    (0..4).for_each(|c| sum[c] += rgba[i + c] as u32);
                }
            }
            let n = ((x1 - x0) * (y1 - y0)) as u32;
            (0..4).for_each(|c| out[(y * w + x) * 4 + c] = (sum[c] / n) as u8);
        }
    }
    (w, h, out)
}

fn data_url(png: &[u8]) -> String {
    format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png))
}

/// Adds an item to the top of the history; copying the same thing again just moves it up.
fn remember(text: Option<String>, image: Option<(usize, usize, Vec<u8>)>) -> bool {
    let key = match (&text, &image) {
        (Some(t), _) => hash(t.as_str()),
        (None, Some((_, _, rgba))) => hash(rgba.as_slice()),
        _ => return false,
    };
    let mut history = HISTORY.lock().unwrap();
    if let Some(i) = history.iter().position(|e| e.hash == key) {
        let mut entry = history.remove(i);
        entry.clip.at = now_ms();
        history.insert(0, entry);
        return true;
    }
    let (clip_image, png, (width, height)) = match image {
        Some((w, h, rgba)) => {
            let (tw, th, thumb) = shrink(w, h, &rgba, THUMB);
            (encode_png(tw, th, &thumb).map(|p| data_url(&p)), encode_png(w, h, &rgba), (w, h))
        }
        None => (None, None, (0, 0)),
    };
    let secret = text.as_deref().and_then(secret_kind);
    let clip = Clip { id: NEXT_ID.fetch_add(1, Ordering::Relaxed), text, image: clip_image, width, height, at: now_ms(), secret };
    history.insert(0, Entry { clip, png, hash: key });
    // Drop the oldest images first (they're the heavy ones), then anything past the limit.
    while history.iter().filter(|e| e.png.is_some()).count() > MAX_IMAGES {
        let last = history.iter().rposition(|e| e.png.is_some()).unwrap();
        history.remove(last);
    }
    history.truncate(MAX_ITEMS);
    true
}

/// Drops secrets older than SECRET_MS, and clears the clipboard if it still holds one of them.
fn forget_old_secrets() -> bool {
    let mut history = HISTORY.lock().unwrap();
    let old: Vec<u64> = history.iter().filter(|e| e.clip.secret.is_some() && now_ms() - e.clip.at > SECRET_MS).map(|e| e.hash).collect();
    if old.is_empty() {
        return false;
    }
    history.retain(|e| !old.contains(&e.hash));
    drop(history);
    if let Ok(mut cb) = arboard::Clipboard::new() {
        if cb.get_text().is_ok_and(|t| old.contains(&hash(t.as_str()))) {
            let _ = cb.clear();
        }
    }
    true
}

fn list() -> Vec<Clip> {
    HISTORY.lock().unwrap().iter().map(|e| e.clip.clone()).collect()
}

/// Reads whatever was just copied: text if there is any, otherwise an image.
fn read_clipboard() -> (Option<String>, Option<(usize, usize, Vec<u8>)>) {
    let Ok(mut cb) = arboard::Clipboard::new() else { return (None, None) };
    if let Ok(text) = cb.get_text() {
        if !text.trim().is_empty() {
            let text = if text.len() > MAX_TEXT { text.chars().take(MAX_TEXT).collect() } else { text };
            return (Some(text), None);
        }
    }
    match cb.get_image() {
        Ok(img) => (None, Some((img.width, img.height, img.bytes.into_owned()))),
        Err(_) => (None, None),
    }
}

pub fn spawn(window: WebviewWindow) {
    std::thread::spawn(move || {
        let mut seen = platform::clipboard_sequence();
        loop {
            std::thread::sleep(Duration::from_millis(400));
            if forget_old_secrets() {
                let _ = window.emit("clipboard", list());
            }
            let now = platform::clipboard_sequence();
            if now == seen {
                continue;
            }
            seen = now;
            if platform::clipboard_is_private() {
                continue;
            }
            let (text, image) = read_clipboard();
            if remember(text, image) {
                let _ = window.emit("clipboard", list());
            }
        }
    });
}

fn find(id: u64) -> Result<(Option<String>, Option<Vec<u8>>), String> {
    let history = HISTORY.lock().unwrap();
    let entry = history.iter().find(|e| e.clip.id == id).ok_or("that item is no longer in the history")?;
    Ok((entry.clip.text.clone(), entry.png.clone()))
}

/// Decodes a PNG to 8-bit RGBA.
pub(crate) fn decode_png(bytes: &[u8]) -> Result<(usize, usize, Vec<u8>), String> {
    let mut decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info().map_err(|e| e.to_string())?;
    let mut buf = vec![0; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).map_err(|e| e.to_string())?;
    let px = &buf[..info.buffer_size()];
    let rgba = match info.color_type {
        png::ColorType::Rgba => px.to_vec(),
        png::ColorType::Rgb => px.chunks(3).flat_map(|c| [c[0], c[1], c[2], 255]).collect(),
        png::ColorType::GrayscaleAlpha => px.chunks(2).flat_map(|c| [c[0], c[0], c[0], c[1]]).collect(),
        png::ColorType::Grayscale => px.iter().flat_map(|&g| [g, g, g, 255]).collect(),
        png::ColorType::Indexed => return Err("unexpected indexed PNG".into()),
    };
    Ok((info.width as usize, info.height as usize, rgba))
}

pub(crate) fn set_image(width: usize, height: usize, rgba: Vec<u8>) -> Result<(), String> {
    arboard::Clipboard::new()
        .and_then(|mut cb| cb.set_image(arboard::ImageData { width, height, bytes: Cow::Owned(rgba) }))
        .map_err(|e| e.to_string())
}

fn copy(id: u64) -> Result<(), String> {
    match find(id)? {
        (Some(text), _) => arboard::Clipboard::new().and_then(|mut cb| cb.set_text(text)).map_err(|e| e.to_string()),
        (None, Some(png)) => {
            let (w, h, rgba) = decode_png(&png)?;
            set_image(w, h, rgba)
        }
        _ => Err("nothing to copy".into()),
    }
}

#[tauri::command]
pub fn clipboard_list() -> Vec<Clip> {
    list()
}

#[tauri::command]
pub async fn clipboard_copy(id: u64) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || copy(id)).await.map_err(|e| e.to_string())?
}

/// Copies the item and pastes it into the window the user was in before clicking the island.
#[tauri::command]
pub async fn clipboard_paste(id: u64) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        copy(id)?;
        platform::paste_into_last_window()
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Copies text the UI made (a decoded token, pretty JSON...); it joins the history like any copy.
#[tauri::command]
pub async fn clipboard_write(text: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || arboard::Clipboard::new().and_then(|mut c| c.set_text(text)).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn clipboard_remove(window: WebviewWindow, id: u64) {
    HISTORY.lock().unwrap().retain(|e| e.clip.id != id);
    let _ = window.emit("clipboard", list());
}

#[tauri::command]
pub fn clipboard_clear(window: WebviewWindow) {
    HISTORY.lock().unwrap().clear();
    let _ = window.emit("clipboard", list());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_are_recognised() {
        assert_eq!(secret_kind("ghp_0123456789abcdefABCDEF0123456789abcd"), Some("GitHub token"));
        assert_eq!(secret_kind(&format!("sk-proj-{}", "a".repeat(40))), Some("OpenAI key"));
        assert_eq!(secret_kind(&format!("sk-ant-api03-{}", "b".repeat(40))), Some("Anthropic key"));
        assert_eq!(secret_kind("AKIAIOSFODNN7EXAMPLE"), Some("AWS key"));
        assert_eq!(secret_kind("postgres://app:s3cret@db.example.com:5432/shop"), Some("Database URL with password"));
        assert_eq!(secret_kind("-----BEGIN OPENSSH PRIVATE KEY-----
b3Blbn...
-----END OPENSSH PRIVATE KEY-----"), Some("Private key"));
        assert_eq!(secret_kind("postgres://localhost/shop"), None, "no password");
        assert_eq!(secret_kind("sk-short"), None);
        assert_eq!(secret_kind("hello world"), None);
        assert_eq!(secret_kind("https://user:pass@example.com"), None, "only database schemes");
    }

    #[test]
    fn history_dedupes_caps_images_and_shrinks_previews() {
        HISTORY.lock().unwrap().clear();
        assert!(remember(Some("hello".into()), None));
        assert!(remember(Some("world".into()), None));
        assert!(remember(Some("hello".into()), None));
        let texts: Vec<_> = list().into_iter().filter_map(|c| c.text).collect();
        assert_eq!(texts, ["hello", "world"], "copying again moves it to the top instead of duplicating");

        for i in 0..(MAX_IMAGES + 2) {
            let rgba = vec![i as u8; 800 * 400 * 4];
            assert!(remember(None, Some((800, 400, rgba))));
        }
        let history = HISTORY.lock().unwrap();
        assert_eq!(history.iter().filter(|e| e.png.is_some()).count(), MAX_IMAGES);
        let newest = &history[0];
        assert_eq!((newest.clip.width, newest.clip.height), (800, 400));
        let (w, h, _) = decode_png(&base64::engine::general_purpose::STANDARD.decode(newest.clip.image.as_ref().unwrap().trim_start_matches("data:image/png;base64,")).unwrap()).unwrap();
        assert_eq!((w, h), (THUMB, THUMB / 2), "previews are small; the full image is kept separately");
        let (fw, fh, full) = decode_png(newest.png.as_ref().unwrap()).unwrap();
        assert_eq!((fw, fh, full[0]), (800, 400, (MAX_IMAGES + 1) as u8));
        assert!(history.iter().any(|e| e.clip.text.as_deref() == Some("hello")), "text survives the image cap");
    }
}
