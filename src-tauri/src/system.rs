//! System state shown on the island: volume, brightness, mic/camera use, Bluetooth devices, the
//! next calendar event and new notifications. Each is polled and sent to the UI as an event when
//! it changes (and re-sent every few seconds, so a UI that started late still gets it).

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use std::thread;
use tauri::{Emitter, WebviewWindow};
use windows::ApplicationModel::Appointments::{AppointmentManager, AppointmentStore, AppointmentStoreAccessType};
use windows::Devices::Bluetooth::{BluetoothConnectionStatus, BluetoothDevice, BluetoothLEDevice};
use windows::Devices::Enumeration::{DeviceInformation, DeviceInformationKind};
use windows::Foundation::{DateTime, IReference, Size, TimeSpan};
use windows::UI::Notifications::Management::{UserNotificationListener, UserNotificationListenerAccessStatus};
use windows::UI::Notifications::{KnownNotificationBindings, NotificationKinds};
use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
use windows::Win32::Media::Audio::{IMMDeviceEnumerator, MMDeviceEnumerator, eConsole, eRender};
use windows::Win32::System::Com::{CLSCTX_ALL, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx};
use windows::core::{GUID, HSTRING, Interface};
use windows_collections::IIterable;
use winreg::RegKey;
use winreg::enums::HKEY_CURRENT_USER;

#[derive(Clone, Copy, PartialEq, Serialize)]
struct Volume {
    percent: u8,
    muted: bool,
}

#[derive(Clone, Default, PartialEq, Serialize)]
struct Privacy {
    mic: Vec<String>,
    camera: Vec<String>,
}

#[derive(Clone, PartialEq, Serialize)]
struct Device {
    name: String,
    battery: Option<u8>,
}

#[derive(Clone, PartialEq, Serialize)]
struct Event {
    title: String,
    /// Unix time in milliseconds, so JS can use it directly.
    start: i64,
    location: String,
}

#[derive(Clone, Serialize)]
struct Notification {
    /// Windows' id for the toast, to dismiss it from the notification centre.
    id: u32,
    app: String,
    /// The app's id, to open it ("Reply" / "Open").
    aumid: String,
    /// The app's own logo as a data: URL.
    icon: Option<String>,
    title: String,
    /// Every line after the title (the message itself, sometimes more lines).
    body: String,
}

/// Sends `value` when it differs from the last one sent, or when `resend` is true.
fn send<T: Clone + PartialEq + Serialize>(window: &WebviewWindow, name: &str, last: &mut Option<T>, value: T, resend: bool) {
    if resend || last.as_ref() != Some(&value) {
        let _ = window.emit(name, &value);
        *last = Some(value);
    }
}

pub fn spawn(window: WebviewWindow) {
    let w = window.clone();
    thread::spawn(move || fast(w));
    thread::spawn(move || slow(window));
}

/// Volume, brightness and mic/camera: cheap to read, and the UI should react within a blink.
fn fast(window: WebviewWindow) {
    // WMI first: it sets up COM (MTA plus the security WMI needs); the audio API then shares it.
    let wmi = wmi::WMIConnection::with_namespace_path("ROOT\\WMI").ok();
    let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    let (mut endpoint, mut volume, mut brightness, mut privacy) = (None, None, None, None);
    for tick in 0u64.. {
        let resend = tick % 50 == 0;
        // Re-fetched every 2 s so a switch to headphones/speakers is followed.
        if tick % 20 == 0 {
            endpoint = audio_endpoint();
        }
        if let Some(v) = endpoint.as_ref().and_then(read_volume) {
            send(&window, "volume", &mut volume, v, resend);
        }
        // shortcut: brightness polls WMI every 300 ms, subscribe to WmiMonitorBrightnessEvent if CPU use shows up
        if tick % 3 == 0 {
            if let Some(b) = wmi.as_ref().and_then(read_brightness) {
                send(&window, "brightness", &mut brightness, b, resend);
            }
        }
        if tick % 5 == 0 {
            let now = Privacy { mic: apps_using("microphone"), camera: apps_using("webcam") };
            send(&window, "privacy", &mut privacy, now, resend);
        }
        thread::sleep(Duration::from_millis(100));
    }
}

/// Bluetooth, calendar and notifications: WinRT queries that can take a while.
fn slow(window: WebviewWindow) {
    let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    let listener = UserNotificationListener::Current().ok();
    if let Some(l) = &listener {
        if l.GetAccessStatus().ok() != Some(UserNotificationListenerAccessStatus::Allowed) {
            let _ = l.RequestAccessAsync().and_then(|op| op.join());
        }
    }
    let (mut devices, mut event, mut store) = (None, None, None::<AppointmentStore>);
    let mut seen: Option<HashSet<u32>> = None;
    let mut logos = HashMap::new();
    for tick in 0u64.. {
        let resend = tick % 5 == 0;
        if let Some(l) = &listener {
            if let Ok(new) = new_notifications(l, &mut seen, &mut logos) {
                new.iter().for_each(|n| drop(window.emit("notification", n)));
            }
        }
        if tick % 3 == 0 {
            if let Ok(d) = bluetooth() {
                send(&window, "bluetooth", &mut devices, d, resend);
            }
        }
        if tick % 60 == 0 {
            if store.is_none() {
                store = AppointmentManager::RequestStoreAsync(AppointmentStoreAccessType::AllCalendarsReadOnly)
                    .and_then(|op| op.join())
                    .ok();
            }
            if let Some(next) = store.as_ref().and_then(|s| next_event(s).ok()) {
                send(&window, "event", &mut event, next, true);
            }
        }
        thread::sleep(Duration::from_secs(1));
    }
}

fn audio_endpoint() -> Option<IAudioEndpointVolume> {
    unsafe {
        let devices: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok()?;
        devices.GetDefaultAudioEndpoint(eRender, eConsole).ok()?.Activate(CLSCTX_ALL, None).ok()
    }
}

fn read_volume(endpoint: &IAudioEndpointVolume) -> Option<Volume> {
    unsafe {
        let level = endpoint.GetMasterVolumeLevelScalar().ok()?;
        Some(Volume { percent: (level * 100.0).round() as u8, muted: endpoint.GetMute().ok()?.as_bool() })
    }
}

#[derive(Deserialize)]
#[serde(rename = "WmiMonitorBrightness", rename_all = "PascalCase")]
struct WmiMonitorBrightness {
    current_brightness: u8,
}

/// Brightness of the built-in screen; None on desktops (external monitors don't report it here).
fn read_brightness(wmi: &wmi::WMIConnection) -> Option<u8> {
    wmi.query::<WmiMonitorBrightness>().ok()?.first().map(|b| b.current_brightness)
}

/// Apps using the microphone or webcam right now. Windows records each app's last use under
/// ConsentStore; an app is still using it while `LastUsedTimeStop` is 0.
fn apps_using(capability: &str) -> Vec<String> {
    let path = format!(r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\{capability}");
    let Ok(root) = RegKey::predef(HKEY_CURRENT_USER).open_subkey(path) else { return vec![] };
    let in_use = |key: &RegKey| {
        key.get_value::<u64, _>("LastUsedTimeStop").is_ok_and(|t| t == 0) && key.get_value::<u64, _>("LastUsedTimeStart").is_ok_and(|t| t > 0)
    };
    let mut apps = vec![];
    for name in root.enum_keys().flatten() {
        let Ok(key) = root.open_subkey(&name) else { continue };
        // Store apps sit directly under the capability, desktop apps under "NonPackaged".
        if name == "NonPackaged" {
            for sub in key.enum_keys().flatten() {
                if key.open_subkey(&sub).is_ok_and(|k| in_use(&k)) {
                    apps.push(app_name(&sub));
                }
            }
        } else if in_use(&key) {
            apps.push(app_name(&name));
        }
    }
    apps.sort();
    apps.dedup();
    apps
}

/// "C:#Program Files#Zoom#Zoom.exe" -> "Zoom", "Microsoft.WindowsCamera_8wekyb3d8bbwe" -> "WindowsCamera".
fn app_name(key: &str) -> String {
    let file = key.rsplit('#').next().unwrap_or(key);
    let stem = file.get(..file.len().saturating_sub(4)).filter(|_| file.to_ascii_lowercase().ends_with(".exe")).unwrap_or(file);
    let family = stem.split('_').next().unwrap_or(stem);
    family.rsplit('.').next().unwrap_or(family).to_string()
}

const CONTAINER: &str = "System.Devices.Aep.ContainerId";
const BATTERY: &str = "{104EA319-6EE2-4701-BD47-8DDBF425BBE5} 2";

fn props(names: &[&str]) -> IIterable<HSTRING> {
    names.iter().map(|n| HSTRING::from(*n)).collect::<Vec<_>>().into()
}

/// Connected Bluetooth devices (classic and LE), with the battery level where the device reports one.
fn bluetooth() -> windows::core::Result<Vec<Device>> {
    let status = BluetoothConnectionStatus::Connected;
    let mut out: Vec<Device> = vec![];
    for selector in [
        BluetoothDevice::GetDeviceSelectorFromConnectionStatus(status)?,
        BluetoothLEDevice::GetDeviceSelectorFromConnectionStatus(status)?,
    ] {
        let found = DeviceInformation::FindAllAsyncAqsFilterAndAdditionalProperties(&selector, &props(&[CONTAINER]))?.join()?;
        for i in 0..found.Size()? {
            let d = found.GetAt(i)?;
            let name = d.Name()?.to_string();
            // Earbuds often show up both as classic and LE devices.
            if out.iter().any(|o| o.name == name) {
                continue;
            }
            let container = d.Properties()?.Lookup(&HSTRING::from(CONTAINER)).and_then(|v| v.cast::<IReference<GUID>>()?.Value());
            out.push(Device { name, battery: container.ok().and_then(|c| battery_of(c).ok().flatten()) });
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// The battery level Windows shows in Bluetooth settings lives on one of the device's PnP nodes.
fn battery_of(container: GUID) -> windows::core::Result<Option<u8>> {
    let aqs = HSTRING::from(format!("System.Devices.ContainerId:=\"{{{container:?}}}\""));
    let nodes = DeviceInformation::FindAllAsyncWithKindAqsFilterAndAdditionalProperties(&aqs, &props(&[BATTERY]), DeviceInformationKind::Device)?.join()?;
    for i in 0..nodes.Size()? {
        if let Ok(level) = nodes.GetAt(i)?.Properties()?.Lookup(&HSTRING::from(BATTERY)).and_then(|v| v.cast::<IReference<u8>>()?.Value()) {
            return Ok(Some(level));
        }
    }
    Ok(None)
}

/// Seconds between 1601 (WinRT DateTime) and 1970 (Unix).
const EPOCH_GAP_SECS: i64 = 11_644_473_600;

pub(crate) fn unix_ms(t: DateTime) -> i64 {
    t.UniversalTime / 10_000 - EPOCH_GAP_SECS * 1000
}

/// The next timed (not all-day) event in the next 12 hours, from the calendars Windows syncs.
fn next_event(store: &AppointmentStore) -> windows::core::Result<Option<Event>> {
    let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64);
    let now = DateTime { UniversalTime: (now_ms + EPOCH_GAP_SECS * 1000) * 10_000 };
    let found = store.FindAppointmentsAsync(now, TimeSpan { Duration: 12 * 3600 * 10_000_000 })?.join()?;
    let mut next: Option<Event> = None;
    for i in 0..found.Size()? {
        let a = found.GetAt(i)?;
        let start = unix_ms(a.StartTime()?);
        // The query also returns events already in progress.
        if a.AllDay()? || start < now_ms || next.as_ref().is_some_and(|n| n.start <= start) {
            continue;
        }
        next = Some(Event { title: a.Subject()?.to_string(), start, location: a.Location()?.to_string() });
    }
    Ok(next)
}

/// Toasts that arrived since the last call. The first call only records what's already there.
fn new_notifications(
    listener: &UserNotificationListener,
    seen: &mut Option<HashSet<u32>>,
    logos: &mut HashMap<String, Option<String>>,
) -> windows::core::Result<Vec<Notification>> {
    let list = listener.GetNotificationsAsync(NotificationKinds::Toast)?.join()?;
    let mut current = HashSet::new();
    let mut new = vec![];
    for i in 0..list.Size()? {
        let n = list.GetAt(i)?;
        let id = n.Id()?;
        current.insert(id);
        if seen.as_ref().is_none_or(|s| s.contains(&id)) {
            continue;
        }
        let texts = n.Notification()?.Visual()?.GetBinding(&KnownNotificationBindings::ToastGeneric()?)?.GetTextElements()?;
        let lines: Vec<String> = (0..texts.Size()?).filter_map(|i| texts.GetAt(i).and_then(|t| t.Text()).ok()).map(|t| t.to_string()).collect();
        let info = n.AppInfo().ok();
        let app = info.as_ref().and_then(|a| a.DisplayInfo().and_then(|d| d.DisplayName()).ok()).map(|s| s.to_string()).unwrap_or_default();
        let aumid = info.as_ref().and_then(|a| a.AppUserModelId().ok()).map(|s| s.to_string()).unwrap_or_default();
        // Logos are read once per app; they don't change between messages. The Start menu's icon
        // works for Store and desktop apps; the app's own logo is the fallback.
        let icon = logos
            .entry(aumid.clone())
            .or_insert_with(|| {
                crate::openwith::app_icon(&aumid).or_else(|| {
                    let logo = info.as_ref()?.DisplayInfo().ok()?.GetLogo(Size { Width: 64.0, Height: 64.0 }).ok()?;
                    crate::media::data_url(&logo.cast().ok()?).ok()
                })
            })
            .clone();
        let (title, body) = lines.split_first().map(|(t, rest)| (t.clone(), rest.join("\n"))).unwrap_or_default();
        new.push(Notification { id, app, aumid, icon, title, body });
    }
    *seen = Some(current);
    Ok(new)
}

/// An app id is letters, digits and `._-!` (e.g. "5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App").
fn valid_aumid(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || "._-!".contains(c))
}

/// Opens the app a notification came from, the way Start would.
#[tauri::command]
pub fn open_app(aumid: String) -> Result<(), String> {
    // The id ends up on a command line, so nothing but app-id characters gets through.
    if !valid_aumid(&aumid) {
        return Err("not an app id".into());
    }
    crate::platform::explorer(format!("shell:AppsFolder\\{aumid}"))
}

/// Removes a notification from the Windows notification centre.
#[tauri::command]
pub fn dismiss_notification(id: u32) -> Result<(), String> {
    UserNotificationListener::Current().and_then(|l| l.RemoveNotification(id)).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_real_app_ids_are_opened() {
        assert!(valid_aumid("5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App"));
        assert!(valid_aumid("Microsoft.Windows.Explorer"));
        assert!(!valid_aumid(""));
        assert!(!valid_aumid("x\" & calc"));
        assert!(!valid_aumid(r"C:\Windows\System32\calc.exe"));
    }

    #[test]
    fn app_names_from_consent_store_keys() {
        assert_eq!(app_name(r"C:#Program Files#Zoom#bin#Zoom.exe"), "Zoom");
        assert_eq!(app_name("C:#Apps#discord#Discord.EXE"), "Discord");
        assert_eq!(app_name("Microsoft.WindowsCamera_8wekyb3d8bbwe"), "WindowsCamera");
    }

    #[test]
    fn winrt_time_converts_to_unix_ms() {
        // 2026-01-01T00:00:00Z
        let unix = 1_767_225_600_000;
        assert_eq!(unix_ms(DateTime { UniversalTime: (unix + EPOCH_GAP_SECS * 1000) * 10_000 }), unix);
    }
}

