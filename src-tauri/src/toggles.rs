//! Quick toggles: Wi-Fi, Bluetooth, dark mode and the microphone. `toggles()` reads them all;
//! `set_toggle` flips one. Do Not Disturb is linnotch's own (src/features/today/toggles.tsx): Windows'
//! FocusSessionManager.TryStartFocusSession crashes (access violation) from a desktop app, and
//! the registry switch for notifications only applies after a sign-out.

use serde::Serialize;
use windows::Devices::Radios::{Radio, RadioKind, RadioState};
use windows::Win32::Foundation::{LPARAM, WPARAM};
use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
use windows::Win32::Media::Audio::{IMMDeviceEnumerator, MMDeviceEnumerator, eCapture, eConsole};
use windows::Win32::System::Com::{CLSCTX_ALL, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx};
use windows::Win32::UI::WindowsAndMessaging::{HWND_BROADCAST, SMTO_ABORTIFHUNG, SendMessageTimeoutW, WM_SETTINGCHANGE};
use windows::core::w;
use winreg::RegKey;
use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE};

/// Each is None when this PC doesn't have it (no Bluetooth radio, no microphone...).
#[derive(Serialize, Default)]
pub struct Toggles {
    wifi: Option<bool>,
    bluetooth: Option<bool>,
    dark: Option<bool>,
    mic_muted: Option<bool>,
}

/// Runs `f` on a thread with COM ready (WinRT and Core Audio both need it).
fn com<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
    std::thread::spawn(move || {
        let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        f()
    })
    .join()
    .expect("toggle worker panicked")
}

fn radio(kind: RadioKind) -> Option<Radio> {
    let radios = Radio::GetRadiosAsync().ok()?.join().ok()?;
    (0..radios.Size().ok()?).filter_map(|i| radios.GetAt(i).ok()).find(|r| r.Kind().ok() == Some(kind))
}

fn radio_on(kind: RadioKind) -> Option<bool> {
    radio(kind).and_then(|r| r.State().ok()).map(|s| s == RadioState::On)
}

fn set_radio(kind: RadioKind, on: bool) -> Result<(), String> {
    let _ = Radio::RequestAccessAsync().and_then(|op| op.join());
    let r = radio(kind).ok_or("this PC doesn't have that radio")?;
    let status = r.SetStateAsync(if on { RadioState::On } else { RadioState::Off }).and_then(|op| op.join()).map_err(|e| e.to_string())?;
    if status.0 == 1 { Ok(()) } else { Err("Windows didn't allow changing it".into()) } // 1 = Allowed
}

const PERSONALIZE: &str = r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize";

fn dark_mode() -> Option<bool> {
    let key = RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(PERSONALIZE, KEY_READ).ok()?;
    key.get_value::<u32, _>("AppsUseLightTheme").ok().map(|v| v == 0)
}

fn set_dark_mode(dark: bool) -> Result<(), String> {
    let key = RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(PERSONALIZE, KEY_SET_VALUE).map_err(|e| e.to_string())?;
    let light = u32::from(!dark);
    key.set_value("AppsUseLightTheme", &light).map_err(|e| e.to_string())?;
    key.set_value("SystemUsesLightTheme", &light).map_err(|e| e.to_string())?;
    // Tell open windows the theme changed, the way Settings does.
    unsafe {
        SendMessageTimeoutW(HWND_BROADCAST, WM_SETTINGCHANGE, WPARAM(0), LPARAM(w!("ImmersiveColorSet").as_ptr() as isize), SMTO_ABORTIFHUNG, 200, None);
    }
    Ok(())
}

fn mic() -> Option<IAudioEndpointVolume> {
    unsafe {
        let devices: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok()?;
        devices.GetDefaultAudioEndpoint(eCapture, eConsole).ok()?.Activate(CLSCTX_ALL, None).ok()
    }
}

fn read() -> Toggles {
    Toggles {
        wifi: radio_on(RadioKind::WiFi),
        bluetooth: radio_on(RadioKind::Bluetooth),
        dark: dark_mode(),
        mic_muted: mic().and_then(|m| unsafe { m.GetMute() }.ok()).map(|b| b.as_bool()),
    }
}

#[tauri::command]
pub async fn toggles() -> Toggles {
    tauri::async_runtime::spawn_blocking(|| com(read)).await.unwrap_or_default()
}

#[tauri::command]
pub async fn set_toggle(name: String, on: bool) -> Result<Toggles, String> {
    tauri::async_runtime::spawn_blocking(move || {
        com(move || {
            match name.as_str() {
                "wifi" => set_radio(RadioKind::WiFi, on)?,
                "bluetooth" => set_radio(RadioKind::Bluetooth, on)?,
                "dark" => set_dark_mode(on)?,
                "mic" => {
                    let m = mic().ok_or("no microphone found")?;
                    unsafe { m.SetMute(on, std::ptr::null()) }.map_err(|e| e.to_string())?
                }
                _ => return Err(format!("unknown toggle: {name}")),
            }
            Ok(read())
        })
    })
    .await
    .map_err(|e| e.to_string())?
}


/// Opens Windows' notification centre (Win+N), where its own Do Not Disturb switch is.
#[tauri::command]
pub fn open_notification_center() -> Result<(), String> {
    use windows::Win32::UI::Input::KeyboardAndMouse::{INPUT, INPUT_0, INPUT_KEYBOARD, KEYBD_EVENT_FLAGS, KEYBDINPUT, KEYEVENTF_KEYUP, SendInput, VIRTUAL_KEY, VK_LWIN, VK_N};
    let key = |vk: VIRTUAL_KEY, up: bool| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: vk, dwFlags: if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) }, ..Default::default() } },
    };
    let keys = [key(VK_LWIN, false), key(VK_N, false), key(VK_N, true), key(VK_LWIN, true)];
    let sent = unsafe { SendInput(&keys, size_of::<INPUT>() as i32) };
    if sent as usize == keys.len() { Ok(()) } else { Err("couldn't open the notification centre".into()) }
}
