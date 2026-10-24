//! Updates from GitHub releases. A release carries `linnotch-<version>-setup.exe` and its
//! signature `…setup.exe.sig` (installer/build.ps1 makes both). The installer only runs if the
//! signature matches the public key built in here, so a tampered release or download can't.

use serde::Serialize;
use std::io::Read;
use std::path::PathBuf;
use tauri::{Emitter, WebviewWindow};

const RELEASES: &str = "https://api.github.com/repos/v25group/linnotch/releases?per_page=10";
const DOWNLOADS: &str = "https://github.com/v25group/linnotch/releases/download/";
/// `npx tauri signer generate` output; the private half signs releases in installer/build.ps1.
const PUBLIC_KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDBFMjBDMUUxNzUyREE0QUQKUldTdHBDMTE0Y0VnRHJqczhja1BVQzdvQ0dDSjlOQjVxcjdPck9tNEpsRUh5d1FSK2ZQWWplU2oK";
const MAX_SETUP: u64 = 200 * 1024 * 1024;

#[derive(Clone, Serialize)]
pub struct Update {
    version: String,
    notes: String,
    size: u64,
    #[serde(skip)]
    setup: String,
    #[serde(skip)]
    sig: String,
}

/// "0.1.0-alpha.1" -> ([0, 1, 0], ["alpha", "1"]). None for anything that isn't a version.
fn parse(v: &str) -> Option<(Vec<u64>, Vec<&str>)> {
    let v = v.trim_start_matches('v');
    let (core, pre) = v.split_once('-').map_or((v, None), |(c, p)| (c, Some(p)));
    let core = core.split('.').map(|n| n.parse().ok()).collect::<Option<Vec<u64>>>()?;
    let pre: Vec<&str> = pre.map(|p| p.split('.').collect()).unwrap_or_default();
    (core.len() == 3 && pre.iter().all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_alphanumeric()))).then_some((core, pre))
}

/// Semver order: 1.0.0-alpha < 1.0.0-alpha.2 < 1.0.0-beta < 1.0.0.
fn newer(candidate: &str, current: &str) -> bool {
    use std::cmp::Ordering::*;
    let (Some((c1, p1)), Some((c2, p2))) = (parse(candidate), parse(current)) else { return false };
    match c1.cmp(&c2) {
        Greater => return true,
        Less => return false,
        Equal => {}
    }
    // Same core version: a release beats any pre-release of it.
    match (p1.is_empty(), p2.is_empty()) {
        (true, true) | (false, true) => return false,
        (true, false) => return true,
        (false, false) => {}
    }
    for (a, b) in p1.iter().zip(&p2) {
        let order = match (a.parse::<u64>(), b.parse::<u64>()) {
            (Ok(x), Ok(y)) => x.cmp(&y),
            (Ok(_), Err(_)) => Less,
            (Err(_), Ok(_)) => Greater,
            _ => a.cmp(b),
        };
        if order != Equal {
            return order == Greater;
        }
    }
    p1.len() > p2.len()
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder().timeout_global(Some(std::time::Duration::from_secs(30))).build().new_agent()
}

/// The newest release that's newer than this build, if any. Pre-releases count only while this
/// build is one too, so people on a stable version stay on stable ones.
fn latest() -> Result<Option<Update>, String> {
    let current = env!("CARGO_PKG_VERSION");
    let on_pre = parse(current).is_some_and(|(_, pre)| !pre.is_empty());
    let text = agent()
        .get(RELEASES)
        .header("User-Agent", "linnotch-updater")
        .header("Accept", "application/vnd.github+json")
        .call()
        .map_err(|e| format!("Couldn't reach GitHub: {e}"))?
        .body_mut()
        .read_to_string()
        .map_err(|e| e.to_string())?;
    let releases: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
      let best = releases.as_array().into_iter().flatten().filter_map(|r| {
        if r["draft"].as_bool() != Some(false) || (r["prerelease"].as_bool() == Some(true) && !on_pre) {
            return None;
        }
        let version = r["tag_name"].as_str()?.trim_start_matches('v').to_string();
        if !newer(&version, current) {
            return None;
        }
        let name = format!("linnotch-{version}-setup.exe");
        let asset = |n: &str| r["assets"].as_array()?.iter().find(|a| a["name"].as_str() == Some(n)).cloned();
        let (setup, sig) = (asset(&name)?, asset(&format!("{name}.sig"))?);
        let url = |a: &serde_json::Value| a["browser_download_url"].as_str().filter(|u| u.starts_with(DOWNLOADS)).map(str::to_string);
        Some(Update {
            notes: r["body"].as_str().unwrap_or("").chars().take(600).collect(),
            size: setup["size"].as_u64().unwrap_or(0),
            setup: url(&setup)?,
            sig: url(&sig)?,
            version,
        })
    });
    Ok(best.reduce(|a, b| if newer(&b.version, &a.version) { b } else { a }))
}

/// Checks the signature and that it was made for `file`: the signer records the file name in the
/// signed comment, so an older signed installer re-uploaded under a newer version is refused.
fn verify(data: &[u8], sig_b64: &str, file: &str) -> Result<(), String> {
    use base64::Engine;
    let text = |b64: &str| {
        let bytes = base64::engine::general_purpose::STANDARD.decode(b64.trim()).map_err(|_| "bad signature encoding".to_string())?;
        String::from_utf8(bytes).map_err(|_| "bad signature encoding".to_string())
    };
    let key = minisign_verify::PublicKey::decode(&text(PUBLIC_KEY)?).map_err(|e| e.to_string())?;
    let sig = minisign_verify::Signature::decode(&text(sig_b64)?).map_err(|e| e.to_string())?;
    let bad = || "The update's signature doesn't match, so it wasn't installed.".to_string();
    key.verify(data, &sig, true).map_err(|_| bad())?;
    if !sig.trusted_comment().split('\t').any(|part| part == format!("file:{file}")) {
        return Err(bad());
    }
    Ok(())
}

#[tauri::command]
pub async fn update_check() -> Result<Option<Update>, String> {
    tauri::async_runtime::spawn_blocking(latest).await.map_err(|e| e.to_string())?
}

/// Downloads, verifies and runs the installer silently. The installer stops this app, replaces
/// it, and starts the new one (`/UPDATE`, see installer/linnotch.iss).
#[tauri::command]
pub async fn update_install(window: WebviewWindow) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let update = latest()?.ok_or("linnotch is already up to date.")?;
        let sig = agent().get(&update.sig).call().map_err(|e| e.to_string())?.body_mut().read_to_string().map_err(|e| e.to_string())?;
        let mut body = agent().get(&update.setup).call().map_err(|e| e.to_string())?.into_body().into_reader().take(MAX_SETUP + 1);
        let mut data = Vec::with_capacity(update.size as usize);
        let mut chunk = [0u8; 64 * 1024];
        let mut last = 0.0;
        loop {
            let n = body.read(&mut chunk).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            data.extend_from_slice(&chunk[..n]);
            if data.len() as u64 > MAX_SETUP {
                return Err("The update is unexpectedly large, so it wasn't installed.".into());
            }
            let p = data.len() as f64 / update.size.max(1) as f64;
            if p - last >= 0.01 {
                last = p;
                let _ = window.emit("update-progress", p.min(1.0));
            }
        }
        let name = format!("linnotch-{}-setup.exe", update.version);
        verify(&data, &sig, &name)?;
        // Written only after it checks out; a fresh folder each time so nothing stale is run.
        let dir: PathBuf = std::env::temp_dir().join("linnotch-update");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let setup = dir.join(name);
        std::fs::write(&setup, &data).map_err(|e| e.to_string())?;
        std::process::Command::new(&setup)
            .args(["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/UPDATE"])
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_follow_semver_order() {
        assert!(newer("0.1.0-alpha.2", "0.1.0-alpha.1"));
        assert!(newer("0.1.0-beta", "0.1.0-alpha.9"));
        assert!(newer("0.1.0", "0.1.0-alpha.1"));
        assert!(newer("0.2.0", "0.1.9"));
        assert!(newer("0.1.0-alpha.10", "0.1.0-alpha.9"));
        assert!(!newer("0.1.0-alpha.1", "0.1.0-alpha.1"));
        assert!(!newer("0.1.0-alpha.1", "0.1.0"));
        assert!(!newer("0.1.0", "0.1.0"));
        assert!(!newer("garbage", "0.1.0"));
        assert!(!newer("0.1.0-a;b", "0.0.1"), "odd characters never count as a version");
    }

    #[test]
    fn only_signed_installers_pass() {
        // "hello\n" signed as t.bin with the release key (npx tauri signer sign).
        const SIG: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVTdHBDMTE0Y0VnRGpxUE5rdm9VRnBvNHdWYnlONWplWXFBKzI3aVZpM2VRY1Z1ZnBnWEs1aXdLQWdPRnVxV2RKVFhNUGVFMkQrUTRHS0F3c3VLbXNabWxYK3kvckZIOVFFPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkyODMyMTQzCWZpbGU6dC5iaW4KYmRwbTlIaHNTYUFXcG9Pdzdqek1GVyt0THp1TWlOd2gwU2pzNWtoQkFUcEU0TXovQWREZE12ZlZvQzladlVMdDRZeEZMd09FQU1Mc1JYUXBjZE8vQnc9PQo=";
        assert!(verify(b"hello\n", SIG, "t.bin").is_ok());
        assert!(verify(b"hellO\n", SIG, "t.bin").is_err(), "changed bytes");
        assert!(verify(b"hello\n", SIG, "linnotch-9.9.9-setup.exe").is_err(), "signed for another file");
        assert!(verify(b"hello\n", "", "t.bin").is_err());
        assert!(verify(b"hello\n", "bm90IGEgc2lnbmF0dXJl", "t.bin").is_err());
    }
}
