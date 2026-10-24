//! Now playing: whatever app Windows shows in its media flyout (Spotify, browsers, Media Player...),
//! read through the system media transport controls. Polled, and sent to the UI as "media" and
//! "media-art" events; the commands below control playback.

use base64::Engine;
use serde::Serialize;
use std::thread;
use std::time::Duration;
use tauri::{Emitter, WebviewWindow};
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession as Session,
    GlobalSystemMediaTransportControlsSessionManager as Manager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
};
use windows::Media::MediaPlaybackAutoRepeatMode as Repeat;
use windows::Storage::Streams::{Buffer, DataReader, IRandomAccessStreamReference, InputStreamOptions};
use windows::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx};

#[derive(Clone, PartialEq, Serialize)]
struct Media {
    title: String,
    artist: String,
    album: String,
    app: String,
    playing: bool,
    /// Position when the player last reported it, at `updated` (Unix ms). The UI extrapolates.
    position: i64,
    duration: i64,
    updated: i64,
    can_next: bool,
    can_previous: bool,
    can_seek: bool,
    /// None when the app doesn't report or allow it.
    shuffle: Option<bool>,
    /// 0 off, 1 one track, 2 whole list; None when the app doesn't report or allow it.
    repeat: Option<i32>,
}

const TICKS_PER_MS: i64 = 10_000; // WinRT TimeSpan is in 100 ns units

fn current() -> windows::core::Result<Session> {
    Manager::RequestAsync()?.join()?.GetCurrentSession()
}

fn read(session: &Session) -> windows::core::Result<Media> {
    let props = session.TryGetMediaPropertiesAsync()?.join()?;
    let info = session.GetPlaybackInfo()?;
    let controls = info.Controls()?;
    let timeline = session.GetTimelineProperties()?;
    Ok(Media {
        title: props.Title()?.to_string(),
        artist: props.Artist()?.to_string(),
        album: props.AlbumTitle()?.to_string(),
        app: app_name(&session.SourceAppUserModelId()?.to_string()),
        playing: info.PlaybackStatus()? == Status::Playing,
        position: timeline.Position()?.Duration / TICKS_PER_MS,
        duration: (timeline.EndTime()?.Duration - timeline.StartTime()?.Duration) / TICKS_PER_MS,
        updated: crate::system::unix_ms(timeline.LastUpdatedTime()?),
        can_next: controls.IsNextEnabled()?,
        can_previous: controls.IsPreviousEnabled()?,
        can_seek: controls.IsPlaybackPositionEnabled()?,
        shuffle: controls.IsShuffleEnabled()?.then(|| info.IsShuffleActive().and_then(|v| v.Value()).ok()).flatten(),
        repeat: controls.IsRepeatEnabled()?.then(|| info.AutoRepeatMode().and_then(|v| v.Value()).ok()).flatten().map(|m| m.0),
    })
}

/// The album art as a data: URL, if the player provides one.
fn art(session: &Session) -> windows::core::Result<Option<String>> {
    let Ok(thumb) = session.TryGetMediaPropertiesAsync()?.join()?.Thumbnail() else { return Ok(None) };
    data_url(&thumb).map(Some)
}

/// Reads a WinRT image stream (album art, an app logo) into a data: URL.
pub(crate) fn data_url(image: &IRandomAccessStreamReference) -> windows::core::Result<String> {
    let stream = image.OpenReadAsync()?.join()?;
    let size = stream.Size()? as u32;
    let buffer = Buffer::Create(size)?;
    let read = stream.ReadAsync(&buffer, size, InputStreamOptions::None)?.join()?;
    let mut bytes = vec![0u8; read.Length()? as usize];
    DataReader::FromBuffer(&read)?.ReadBytes(&mut bytes)?;
    let mime = stream.ContentType().map(|t| t.to_string()).ok().filter(|t| !t.is_empty()).unwrap_or("image/png".into());
    Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

/// "Spotify.exe" -> "Spotify", "SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify" -> "Spotify",
/// "Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic" -> "Media Player", "chrome" -> "Chrome".
fn app_name(id: &str) -> String {
    let id = id.rsplit('!').next().unwrap_or(id);
    let id = id.rsplit(['\\', '/']).next().unwrap_or(id);
    let id = id.strip_suffix(".exe").or_else(|| id.strip_suffix(".EXE")).unwrap_or(id);
    let name = id.rsplit('.').next().unwrap_or(id);
    match name.to_ascii_lowercase().as_str() {
        "zunemusic" => "Media Player".into(),
        "msedge" => "Edge".into(),
        _ => {
            let mut c = name.chars();
            c.next().map(|f| f.to_uppercase().chain(c).collect()).unwrap_or_default()
        }
    }
}

pub fn spawn(window: WebviewWindow) {
    thread::spawn(move || {
        let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        let (mut last, mut last_track, mut rechecks) = (None::<Option<Media>>, String::new(), 0u32);
        for tick in 0u64.. {
            let session = current().ok();
            let media = session.as_ref().and_then(|s| read(s).ok()).filter(|m| !m.title.is_empty());
            let resend = tick % 10 == 0;
            if resend || last.as_ref() != Some(&media) {
                let _ = window.emit("media", &media);
                last = Some(media.clone());
            }
            // Art is big, so it's read when the track changes, not every tick. Players (Spotify
            // especially) often swap the cover a moment after the title, so look again a few times.
            let track = media.as_ref().map(|m| format!("{}\u{1}{}\u{1}{}", m.app, m.title, m.artist)).unwrap_or_default();
            if track != last_track {
                last_track = track;
                rechecks = 5;
            }
            if rechecks > 0 && tick % 2 == 0 {
                rechecks -= 1;
                let now = session.as_ref().filter(|_| media.is_some()).and_then(|s| art(s).ok().flatten());
                let mut current = ART.lock().unwrap();
                if *current != now {
                    *current = now;
                    let _ = window.emit("media-art", &*current);
                }
            }
            thread::sleep(Duration::from_millis(500));
        }
    });
}

/// The current album art, kept for a UI that starts after it was last sent.
static ART: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

#[tauri::command]
pub fn media_art() -> Option<String> {
    ART.lock().unwrap().clone()
}

#[tauri::command]
pub async fn media_control(action: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let s = current().map_err(|e| e.to_string())?;
        let op = match action.as_str() {
            "toggle" => s.TryTogglePlayPauseAsync(),
            "next" => s.TrySkipNextAsync(),
            "previous" => s.TrySkipPreviousAsync(),
            "shuffle" => {
                let on = s.GetPlaybackInfo().and_then(|i| i.IsShuffleActive()?.Value()).unwrap_or(false);
                s.TryChangeShuffleActiveAsync(!on)
            }
            // Off -> whole list -> one track -> off, the order Spotify and Media Player use.
            "repeat" => {
                let now = s.GetPlaybackInfo().and_then(|i| i.AutoRepeatMode()?.Value()).unwrap_or(Repeat::None);
                s.TryChangeAutoRepeatModeAsync(match now {
                    Repeat::None => Repeat::List,
                    Repeat::List => Repeat::Track,
                    _ => Repeat::None,
                })
            }
            _ => return Err(format!("unknown action: {action}")),
        };
        op.and_then(|o| o.join()).map(|_| ()).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn media_seek(position: i64) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let s = current().map_err(|e| e.to_string())?;
        s.TryChangePlaybackPositionAsync(position.max(0) * TICKS_PER_MS).and_then(|o| o.join()).map(|_| ()).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn friendly_app_names() {
        assert_eq!(app_name("Spotify.exe"), "Spotify");
        assert_eq!(app_name("SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify"), "Spotify");
        assert_eq!(app_name("Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic"), "Media Player");
        assert_eq!(app_name("chrome"), "Chrome");
        assert_eq!(app_name("MSEdge"), "Edge");
    }
}


