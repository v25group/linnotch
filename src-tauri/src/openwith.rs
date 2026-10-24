//! "Open with" for files and folders dragged onto the island: the apps Explorer recommends for
//! the file type, plus developer tools (editors, IDEs, terminals) that also take folders, each
//! with its icon. The UI shows them as tiles; dropping on one opens the path in that app.

use base64::Engine;
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use windows::Win32::Foundation::SIZE;
use windows::Win32::Graphics::Gdi::{
    BI_RGB, HBITMAP, BITMAPINFO, BITMAPINFOHEADER, CreateCompatibleDC, DIB_RGB_COLORS, DeleteDC, DeleteObject, GetDIBits,
};
use windows::Win32::System::Com::{COINIT_APARTMENTTHREADED, CoInitializeEx, CoTaskMemFree, IDataObject};
use windows::Win32::UI::Shell::{
    ASSOC_FILTER_RECOMMENDED, ASSOCF_INIT_BYEXENAME, ASSOCSTR_FRIENDLYAPPNAME, AssocQueryStringW, FOLDERID_AppsFolder,
    IShellItemImageFactory, KF_FLAG_DEFAULT, SHCreateItemInKnownFolder, SIIGBF_ICONONLY, BHID_DataObject, IAssocHandler, IShellItem, SHAssocEnumHandlers, SHCreateItemFromParsingName,
    SHDefExtractIconW, SHLoadIndirectString,
};
use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, HICON, ICONINFO};
use windows::core::{HSTRING, PWSTR};

#[derive(Serialize)]
pub struct App {
    /// "assoc:<name>" for an Explorer handler, "tool:<exe>" for a developer tool.
    id: String,
    name: String,
    /// PNG data: URL, or None when Windows has no usable icon.
    icon: Option<String>,
}

/// Shell objects want a single-threaded apartment; run `f` on a fresh thread that has one.
fn sta<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
    std::thread::spawn(move || {
        let _ = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
        f()
    })
    .join()
    .expect("open-with worker panicked")
}

/// Reads and frees a string the shell allocated for us.
fn take(p: PWSTR) -> String {
    let s = unsafe { p.to_string() }.unwrap_or_default();
    unsafe { CoTaskMemFree(Some(p.0 as _)) };
    s
}

fn handlers(path: &Path) -> Vec<IAssocHandler> {
    let Some(ext) = path.extension() else { return vec![] };
    let ext = HSTRING::from(format!(".{}", ext.to_string_lossy()));
    let Ok(list) = (unsafe { SHAssocEnumHandlers(&ext, ASSOC_FILTER_RECOMMENDED) }) else { return vec![] };
    let mut out = vec![];
    loop {
        let (mut one, mut fetched) = ([None], 0u32);
        if unsafe { list.Next(&mut one, Some(&mut fetched)) }.is_err() || fetched == 0 {
            return out;
        }
        out.extend(one[0].take());
    }
}

fn handler_name(h: &IAssocHandler) -> String {
    unsafe { h.GetUIName() }.map(take).unwrap_or_default()
}

/// What to show for a handler. Some apps register no display name and Windows hands back their
/// exe path; show the exe's own description instead ("Claude", not "C:\Users\...\claude.exe").
fn display_name(ui_name: &str, exe: &str) -> String {
    if !ui_name.contains('\\') {
        return ui_name.to_string();
    }
    let path = if exe.is_empty() { ui_name } else { exe };
    let mut buf = [0u16; 260];
    let mut len = buf.len() as u32;
    let found = unsafe {
        AssocQueryStringW(ASSOCF_INIT_BYEXENAME, ASSOCSTR_FRIENDLYAPPNAME, &HSTRING::from(path), None, Some(PWSTR(buf.as_mut_ptr())), &mut len)
    };
    let friendly = String::from_utf16_lossy(&buf[..len.saturating_sub(1) as usize]);
    if found.is_ok() && !friendly.trim().is_empty() && !friendly.contains('\\') {
        return friendly.trim().to_string();
    }
    Path::new(path).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| ui_name.to_string())
}

/// The icon at `location` ("file,index" style, or a "@{package?ms-resource}" string for Store apps).
fn icon(location: &str, index: i32) -> Option<String> {
    if location.starts_with('@') {
        let mut buf = [0u16; 1024];
        unsafe { SHLoadIndirectString(&HSTRING::from(location), &mut buf, None) }.ok()?;
        let file = String::from_utf16_lossy(&buf[..buf.iter().position(|&c| c == 0).unwrap_or(0)]);
        let bytes = std::fs::read(file).ok()?;
        return Some(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)));
    }
    let mut hicon = HICON::default();
    unsafe { SHDefExtractIconW(&HSTRING::from(location), index, 0, Some(&mut hicon), None, 64) }.ok().ok()?;
    let png = icon_png(hicon);
    let _ = unsafe { DestroyIcon(hicon) };
    png
}

/// HICON -> PNG data: URL.
fn icon_png(hicon: HICON) -> Option<String> {
    let mut info = ICONINFO::default();
    unsafe { GetIconInfo(hicon, &mut info) }.ok()?;
    let png = bitmap_png(info.hbmColor, false);
    unsafe {
        let _ = DeleteObject(info.hbmColor.into());
        let _ = DeleteObject(info.hbmMask.into());
    }
    png
}

/// The icon Start shows for an app id (Store and desktop apps alike), as a PNG data: URL.
pub(crate) fn app_icon(aumid: &str) -> Option<String> {
    let aumid = aumid.to_string();
    sta(move || unsafe {
        let item: IShellItemImageFactory = SHCreateItemInKnownFolder(&FOLDERID_AppsFolder, KF_FLAG_DEFAULT, &HSTRING::from(aumid)).ok()?;
        let bitmap = item.GetImage(SIZE { cx: 64, cy: 64 }, SIIGBF_ICONONLY).ok()?;
        let png = bitmap_png(bitmap, true);
        let _ = DeleteObject(bitmap.into());
        png
    })
}

/// A 32-bit bitmap -> PNG data: URL. Shell images come with premultiplied alpha, icons without.
fn bitmap_png(bitmap: HBITMAP, premultiplied: bool) -> Option<String> {
    unsafe {
        let dc = CreateCompatibleDC(None);
        let mut bmi = BITMAPINFO { bmiHeader: BITMAPINFOHEADER { biSize: size_of::<BITMAPINFOHEADER>() as u32, ..Default::default() }, ..Default::default() };
        GetDIBits(dc, bitmap, 0, 0, None, &mut bmi, DIB_RGB_COLORS);
        let (w, h) = (bmi.bmiHeader.biWidth, bmi.bmiHeader.biHeight.abs());
        bmi.bmiHeader = BITMAPINFOHEADER {
            biSize: size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: w,
            biHeight: -h, // top-down rows
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        };
        let mut px = vec![0u8; (w * h * 4).max(0) as usize];
        let rows = GetDIBits(dc, bitmap, 0, h as u32, Some(px.as_mut_ptr() as _), &mut bmi, DIB_RGB_COLORS);
        let _ = DeleteDC(dc);
        if rows == 0 || w == 0 {
            return None;
        }
        px.chunks_mut(4).for_each(|c| {
            c.swap(0, 2); // BGRA -> RGBA
            let alpha = c[3] as u32;
            if premultiplied && alpha > 0 && alpha < 255 {
                for v in &mut c[..3] {
                    *v = (*v as u32 * 255 / alpha).min(255) as u8;
                }
            }
        });
        // Old icons have no alpha channel at all; show them opaque rather than invisible.
        if px.chunks(4).all(|c| c[3] == 0) {
            px.chunks_mut(4).for_each(|c| c[3] = 255);
        }
        let mut out = vec![];
        {
            let mut enc = png::Encoder::new(&mut out, w as u32, h as u32);
            enc.set_color(png::ColorType::Rgba);
            enc.set_depth(png::BitDepth::Eight);
            enc.write_header().ok()?.write_image_data(&px).ok()?;
        }
        Some(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(out)))
    }
}

fn env_dir(var: &str) -> Option<PathBuf> {
    std::env::var_os(var).map(PathBuf::from)
}

/// Developer tools installed on this PC, as (name, exe).
fn dev_tools() -> Vec<(String, PathBuf)> {
    let local = env_dir("LOCALAPPDATA");
    let pf = env_dir("ProgramFiles");
    let pf86 = env_dir("ProgramFiles(x86)");
    let under = |base: &Option<PathBuf>, rel: &str| base.as_ref().map(|b| b.join(rel));
    let known: Vec<(&str, Vec<Option<PathBuf>>)> = vec![
        ("VS Code", vec![under(&local, r"Programs\Microsoft VS Code\Code.exe"), under(&pf, r"Microsoft VS Code\Code.exe")]),
        ("Cursor", vec![under(&local, r"Programs\cursor\Cursor.exe")]),
        ("Windsurf", vec![under(&local, r"Programs\Windsurf\Windsurf.exe")]),
        ("Antigravity", vec![under(&local, r"Programs\Antigravity\Antigravity.exe")]),
        ("Kiro", vec![under(&local, r"Programs\Kiro\Kiro.exe")]),
        ("VSCodium", vec![under(&local, r"Programs\VSCodium\VSCodium.exe"), under(&pf, r"VSCodium\VSCodium.exe")]),
        ("Zed", vec![under(&local, r"Programs\Zed\zed.exe"), under(&pf, r"Zed\zed.exe")]),
        ("Sublime Text", vec![under(&pf, r"Sublime Text\sublime_text.exe"), under(&pf, r"Sublime Text 3\sublime_text.exe")]),
        ("Notepad++", vec![under(&pf, r"Notepad++\notepad++.exe"), under(&pf86, r"Notepad++\notepad++.exe")]),
        ("Android Studio", vec![under(&pf, r"Android\Android Studio\bin\studio64.exe")]),
        ("Terminal", vec![under(&local, r"Microsoft\WindowsApps\wt.exe")]),
        ("Git Bash", vec![under(&pf, r"Git\git-bash.exe")]),
    ];
    let mut tools: Vec<(String, PathBuf)> = known
        .into_iter()
        .filter_map(|(name, paths)| paths.into_iter().flatten().find(|p| p.exists()).map(|p| (name.to_string(), p)))
        .collect();
    // JetBrains IDEs: <JetBrains or Toolbox folder>\<IDE name and version>\bin\<ide>64.exe
    for root in [under(&pf, "JetBrains"), under(&local, "Programs")].into_iter().flatten() {
        for dir in std::fs::read_dir(root).into_iter().flatten().flatten() {
            let bin = dir.path().join("bin");
            let Some(exe) = std::fs::read_dir(&bin).into_iter().flatten().flatten().map(|e| e.path()).find(|p| {
                let n = p.file_name().and_then(|n| n.to_str()).unwrap_or("").to_ascii_lowercase();
                n.ends_with("64.exe") && ["idea", "pycharm", "webstorm", "clion", "rider", "goland", "phpstorm", "rustrover", "datagrip", "rubymine"].iter().any(|ide| n.starts_with(ide))
            }) else { continue };
            // "IntelliJ IDEA 2024.2.1" -> "IntelliJ IDEA"
            let name = dir.file_name().to_string_lossy().split_whitespace().take_while(|w| !w.starts_with(|c: char| c.is_ascii_digit())).collect::<Vec<_>>().join(" ");
            tools.push((name, exe));
        }
    }
    tools.push(("File Explorer".into(), env_dir("WINDIR").unwrap_or_else(|| r"C:\Windows".into()).join("explorer.exe")));
    tools
}

fn exe_key(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().to_ascii_lowercase()).unwrap_or_default()
}

fn list(path: &Path) -> Vec<App> {
    let mut apps = vec![];
    let mut seen = HashSet::new();
    if path.is_file() {
        for h in handlers(path) {
            let name = handler_name(&h);
            let exe = unsafe { h.GetName() }.map(take).unwrap_or_default();
            if name.is_empty() || !seen.insert(exe_key(Path::new(&exe))) {
                continue;
            }
            let (mut loc, mut index) = (PWSTR::null(), 0);
            let icon = unsafe { h.GetIconLocation(&mut loc, &mut index) }.ok().and_then(|_| icon(&take(loc), index));
            // The id keeps Windows' own name: launch() finds the handler again by it.
            apps.push(App { id: format!("assoc:{name}"), name: display_name(&name, &exe), icon });
        }
    }
    for (name, exe) in dev_tools() {
        if seen.insert(exe_key(&exe)) {
            let icon = icon(&exe.to_string_lossy(), 0);
            apps.push(App { id: format!("tool:{}", exe.display()), name, icon });
        }
    }
    apps
}

fn launch(path: &Path, id: &str) -> Result<(), String> {
    if let Some(name) = id.strip_prefix("assoc:") {
        let h = handlers(path).into_iter().find(|h| handler_name(h) == name).ok_or("that app is no longer available")?;
        let item: IShellItem = unsafe { SHCreateItemFromParsingName(&HSTRING::from(path.as_os_str()), None) }.map_err(|e| e.to_string())?;
        let data: IDataObject = unsafe { item.BindToHandler(None, &BHID_DataObject) }.map_err(|e| e.to_string())?;
        return unsafe { h.Invoke(&data) }.map_err(|e| e.to_string());
    }
    let exe = PathBuf::from(id.strip_prefix("tool:").ok_or("unknown app")?);
    // Only tools we found ourselves can be started; the UI can't make us run any exe.
    if !dev_tools().iter().any(|(_, t)| t == &exe) {
        return Err("unknown app".into());
    }
    let dir = if path.is_dir() { path } else { path.parent().unwrap_or(path) };
    let mut cmd = std::process::Command::new(&exe);
    match exe_key(&exe).as_str() {
        "wt.exe" => cmd.arg("-d").arg(dir),
        "git-bash.exe" => cmd.arg(format!("--cd={}", dir.display())),
        "explorer.exe" if path.is_file() => cmd.arg(format!("/select,{}", path.display())),
        _ => cmd.arg(path),
    };
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn apps_for(path: String) -> Vec<App> {
    tauri::async_runtime::spawn_blocking(move || sta(move || list(Path::new(&path)))).await.unwrap_or_default()
}

#[tauri::command]
pub async fn open_with(path: String, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || sta(move || launch(Path::new(&path), &id))).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_handlers_and_tools_with_icons_and_refuses_unknown_exes() {
        let dir = std::env::temp_dir();
        let file = dir.join(format!("island-openwith-{}.txt", std::process::id()));
        std::fs::write(&file, "hi").unwrap();
        let apps = sta({
            let file = file.clone();
            move || list(&file)
        });
        assert!(apps.iter().any(|a| a.id.starts_with("assoc:")), "a .txt file has Explorer handlers (Notepad)");
        assert!(apps.iter().any(|a| a.name == "File Explorer"));
        assert!(apps.iter().filter(|a| a.icon.is_some()).count() >= apps.len() / 2, "most apps come with an icon");
        let folder_apps = sta(move || list(&dir));
        assert!(folder_apps.iter().all(|a| a.id.starts_with("tool:")), "folders only get tools");
        assert!(launch(&file, r"tool:C:\Windows\System32\calc.exe").is_err());
        assert_eq!(display_name("Notepad", ""), "Notepad");
        assert!(app_icon(r"{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe").is_some(), "desktop app ids get an icon");
        assert!(app_icon("not.a.real.app!id").is_none());
        assert_eq!(display_name(r"C:\Windows\notepad.exe", r"C:\Windows\notepad.exe"), "Notepad");
        std::fs::remove_file(file).unwrap();
    }
}


