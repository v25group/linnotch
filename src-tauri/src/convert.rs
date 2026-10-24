//! File conversion by shelling out to ffmpeg (video, audio and images all go through it).
//! The preset tables here are the single source of truth: the UI renders whatever `inspect` returns.

use serde::Serialize;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[derive(Serialize)]
pub struct Preset {
    pub id: &'static str,
    pub label: &'static str,
    pub note: &'static str,
    pub group: &'static str,
    #[serde(skip)]
    ext: &'static str,
    #[serde(skip)]
    args: &'static [&'static str],
    /// Output is cut to this many seconds (progress is measured against it).
    #[serde(skip)]
    max_seconds: Option<f64>,
}

const fn p(id: &'static str, label: &'static str, note: &'static str, group: &'static str, ext: &'static str, args: &'static [&'static str]) -> Preset {
    Preset { id, label, note, group, ext, args, max_seconds: None }
}

// Even dimensions + yuv420p, or H.264/HEVC output won't play in most players.
const EVEN: &str = "scale=trunc(iw/2)*2:trunc(ih/2)*2";
const MP3: &[&str] = &["-vn", "-c:a", "libmp3lame", "-q:a", "2"];
const M4A: &[&str] = &["-vn", "-c:a", "aac", "-b:a", "256k"];
const WAV: &[&str] = &["-vn", "-c:a", "pcm_s16le"];
const FLAC: &[&str] = &["-vn", "-c:a", "flac"];

const AUDIO_IN: &[&str] = &["mp3", "wav", "flac", "m4a", "aac", "ogg", "oga", "opus", "wma", "aif", "aiff", "alac", "ac3", "amr", "mka"];
const VIDEO_IN: &[&str] = &["mp4", "mov", "mkv", "webm", "avi", "m4v", "wmv", "flv", "mpg", "mpeg", "ts", "mts", "m2ts", "3gp", "ogv"];
const IMAGE_IN: &[&str] = &["png", "jpg", "jpeg", "webp", "bmp", "gif", "tif", "tiff", "avif", "jxl", "qoi", "tga"];

static AUDIO: &[Preset] = &[
    p("mp3", "MP3", "Plays everywhere", "Compressed", "mp3", MP3),
    p("m4a", "M4A", "AAC · Apple", "Compressed", "m4a", M4A),
    p("ogg", "OGG", "Vorbis · open", "Compressed", "ogg", &["-vn", "-c:a", "libvorbis", "-q:a", "6"]),
    p("opus", "Opus", "Smallest files", "Compressed", "opus", &["-vn", "-c:a", "libopus", "-b:a", "128k"]),
    p("wav", "WAV", "Uncompressed", "Lossless", "wav", WAV),
    p("flac", "FLAC", "Lossless · smaller", "Lossless", "flac", FLAC),
    p("alac", "ALAC", "Lossless · Apple", "Lossless", "m4a", &["-vn", "-c:a", "alac"]),
];

static VIDEO: &[Preset] = &[
    p("mp4", "MP4", "H.264 · universal", "Video", "mp4",
      &["-c:v", "libx264", "-crf", "23", "-preset", "medium", "-pix_fmt", "yuv420p", "-vf", EVEN, "-c:a", "aac", "-movflags", "+faststart"]),
    p("hevc", "HEVC", "Half the size", "Video", "mp4",
      &["-c:v", "libx265", "-crf", "28", "-preset", "medium", "-pix_fmt", "yuv420p", "-vf", EVEN, "-tag:v", "hvc1", "-c:a", "aac", "-movflags", "+faststart"]),
    p("webm", "WebM", "VP9 · web", "Video", "webm", &["-c:v", "libvpx-vp9", "-crf", "32", "-b:v", "0", "-row-mt", "1", "-c:a", "libopus"]),
    p("mov", "MOV", "Apple · editing", "Video", "mov",
      &["-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p", "-vf", EVEN, "-c:a", "aac"]),
    p("mkv", "MKV", "No re-encode", "Video", "mkv", &["-c", "copy"]),
    p("small", "720p", "Small MP4 to share", "Smaller", "mp4",
      &["-c:v", "libx264", "-crf", "28", "-preset", "medium", "-pix_fmt", "yuv420p", "-vf", "scale=-2:'min(720,trunc(ih/2)*2)'", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart"]),
    Preset {
        max_seconds: Some(10.0),
        ..p("gif", "GIF", "First 10 s · 480 px", "Smaller", "gif",
            &["-t", "10", "-vf", "fps=12,scale=480:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse", "-an"])
    },
    p("mp3", "MP3", "Extract the audio", "Audio only", "mp3", MP3),
    p("m4a", "M4A", "AAC audio", "Audio only", "m4a", M4A),
    p("wav", "WAV", "Uncompressed audio", "Audio only", "wav", WAV),
];

static IMAGE: &[Preset] = &[
    p("png", "PNG", "Lossless · transparency", "Common", "png", &["-frames:v", "1"]),
    p("jpg", "JPG", "Photos · works anywhere", "Common", "jpg", &["-frames:v", "1", "-q:v", "2"]),
    p("webp", "WebP", "Small · for the web", "Common", "webp", &["-frames:v", "1", "-c:v", "libwebp", "-quality", "85"]),
    p("avif", "AVIF", "Smallest · modern", "Modern", "avif", &["-frames:v", "1", "-c:v", "libaom-av1", "-still-picture", "1", "-crf", "30", "-cpu-used", "6"]),
    p("jxl", "JPEG XL", "Next-gen · sharp", "Modern", "jxl", &["-frames:v", "1", "-c:v", "libjxl", "-distance", "1"]),
    p("tiff", "TIFF", "Print · archiving", "Other", "tiff", &["-frames:v", "1"]),
    p("bmp", "BMP", "Uncompressed", "Other", "bmp", &["-frames:v", "1"]),
    p("gif", "GIF", "256 colours", "Other", "gif", &["-frames:v", "1"]),
];

fn ext_of(path: &Path) -> String {
    let ext = path.extension().unwrap_or_default().to_string_lossy().to_lowercase();
    match ext.as_str() {
        "jpeg" => "jpg".into(),
        "tif" => "tiff".into(),
        _ => ext,
    }
}

/// "audio" / "video" / "image" and the presets that apply to that kind of file.
fn kind_of(path: &Path) -> Option<(&'static str, &'static [Preset])> {
    let ext = ext_of(path);
    let ext = ext.as_str();
    // ext_of normalised these, so match both spellings in the input lists.
    let is = |list: &[&str]| list.contains(&ext) || (ext == "jpg" && list.contains(&"jpeg")) || (ext == "tiff" && list.contains(&"tif"));
    if is(AUDIO_IN) {
        Some(("audio", AUDIO))
    } else if is(VIDEO_IN) {
        Some(("video", VIDEO))
    } else if is(IMAGE_IN) {
        Some(("image", IMAGE))
    } else {
        None
    }
}

#[derive(Serialize)]
pub struct FileInfo {
    pub kind: Option<&'static str>,
    pub size: u64,
    pub duration: Option<f64>,
    pub presets: Vec<&'static Preset>,
}

pub fn inspect(input: &Path) -> Result<FileInfo, String> {
    let size = input.metadata().map_err(|e| format!("can't read {}: {e}", input.display()))?.len();
    let ext = ext_of(input);
    let (kind, presets) = kind_of(input).map_or((None, Vec::new()), |(kind, presets)| {
        // Same format in and out is pointless, except presets that change something else (720p, HEVC...).
        (Some(kind), presets.iter().filter(|p| p.id != ext).collect())
    });
    let duration = if kind.is_some_and(|k| k != "image") { duration(input) } else { None };
    Ok(FileInfo { kind, size, duration, presets })
}

/// Creates and returns `dir/name.to`, or `dir/name (1).to`, `(2)`... The file is created
/// exclusively, so the name can't be taken by anyone else between choosing it and writing it,
/// and on failure we only ever delete a file we made.
pub fn reserve_output(input: &Path, to: &str) -> Result<PathBuf, String> {
    let dir = input.parent().unwrap_or(Path::new("."));
    let stem = input.file_stem().unwrap_or_default().to_string_lossy();
    for n in 0.. {
        let out = if n == 0 { dir.join(format!("{stem}.{to}")) } else { dir.join(format!("{stem} ({n}).{to}")) };
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&out) {
            Ok(_) => return Ok(out),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("can't write to {}: {e}", dir.display())),
        }
    }
    unreachable!()
}

pub(crate) fn command(program: &str) -> Command {
    // FFmpeg installed with winget after the island started isn't on its PATH yet, but winget's
    // link for it already exists.
    let winget = std::env::var_os("LOCALAPPDATA")
        .map(|d| Path::new(&d).join(r"Microsoft\WinGet\Links").join(format!("{program}.exe")))
        .filter(|p| ["ffmpeg", "ffprobe"].contains(&program) && p.is_file());
    let mut cmd = match winget {
        Some(link) => Command::new(link),
        None => Command::new(program),
    };
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Duration in seconds, or None for still images / unknown.
fn duration(input: &Path) -> Option<f64> {
    let out = command("ffprobe")
        .args(["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0"])
        .arg(input)
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout).trim().parse().ok().filter(|d: &f64| *d > 0.0)
}

/// Convert `input` with preset `id`, calling `on_progress` with 0..=1 when the length is known.
/// Returns the output path.
pub fn convert(input: &Path, id: &str, mut on_progress: impl FnMut(f64)) -> Result<PathBuf, String> {
    // The id comes from the webview: it must be a preset for this kind of file.
    let preset = kind_of(input)
        .and_then(|(_, presets)| presets.iter().find(|p| p.id == id))
        .ok_or_else(|| format!("can't convert {} with preset {id}", input.display()))?;
    if !input.is_file() {
        return Err(format!("not a file: {}", input.display()));
    }
    let total = match (duration(input), preset.max_seconds) {
        (Some(d), Some(max)) => Some(d.min(max)),
        (d, _) => d,
    };
    let output = reserve_output(input, preset.ext)?;

    // -y only overwrites the empty file reserve_output just created for us.
    let spawned = command("ffmpeg")
        .args(["-hide_banner", "-nostdin", "-nostats", "-y", "-i"])
        .arg(input)
        .args(preset.args)
        .args(["-progress", "pipe:1"])
        .arg(&output)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();
    let mut child = match spawned {
        Ok(child) => child,
        Err(e) => {
            let _ = std::fs::remove_file(&output);
            return Err(if e.kind() == std::io::ErrorKind::NotFound {
                "Converting needs FFmpeg. Install it with `winget install Gyan.FFmpeg`, then try again.".to_string()
            } else {
                format!("couldn't start ffmpeg ({e})")
            });
        }
    };

    // Drain stderr on its own thread so a full pipe can't stall ffmpeg.
    let mut stderr = child.stderr.take().expect("stderr is piped");
    let errors = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s);
        s
    });

    for line in BufReader::new(child.stdout.take().expect("stdout is piped")).lines().map_while(Result::ok) {
        if let (Some(total), Some(us)) = (total, line.strip_prefix("out_time_us=")) {
            if let Ok(us) = us.parse::<f64>() {
                on_progress((us / 1e6 / total).clamp(0.0, 1.0));
            }
        }
    }

    let status = child.wait().map_err(|e| e.to_string())?;
    let errors = errors.join().unwrap_or_default();
    if status.success() {
        Ok(output)
    } else {
        // A half-written output file is useless; the input is never touched.
        let _ = std::fs::remove_file(&output);
        Err(errors.lines().last().unwrap_or("ffmpeg failed").to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("island-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn have_ffmpeg() -> bool {
        command("ffmpeg").arg("-version").output().is_ok()
    }

    fn generate(path: &Path, lavfi: &str, extra: &[&str]) {
        let ok = command("ffmpeg").args(["-v", "error", "-f", "lavfi", "-i", lavfi]).args(extra).arg(path).status().unwrap();
        assert!(ok.success(), "couldn't generate {}", path.display());
    }

    #[test]
    fn reserve_output_never_reuses_an_existing_name() {
        let dir = tmp_dir("unique");
        let input = dir.join("clip.mov");
        std::fs::write(dir.join("clip.mp4"), "keep me").unwrap();
        assert_eq!(reserve_output(&input, "mp4").unwrap(), dir.join("clip (1).mp4"));
        assert_eq!(reserve_output(&input, "mp4").unwrap(), dir.join("clip (2).mp4"));
        assert_eq!(std::fs::read_to_string(dir.join("clip.mp4")).unwrap(), "keep me");
    }

    #[test]
    fn failed_conversion_removes_only_its_own_output() {
        if !have_ffmpeg() {
            return;
        }
        let dir = tmp_dir("fail");
        let input = dir.join("broken.wav");
        std::fs::write(&input, "not really audio").unwrap();
        std::fs::write(dir.join("broken.mp3"), "keep me").unwrap();
        assert!(convert(&input, "mp3", |_| {}).is_err());
        assert_eq!(std::fs::read_to_string(&input).unwrap(), "not really audio");
        assert_eq!(std::fs::read_to_string(dir.join("broken.mp3")).unwrap(), "keep me");
        assert!(!dir.join("broken (1).mp3").exists(), "failed output left behind");
    }

    #[test]
    fn rejects_presets_from_another_kind_and_unknown_files() {
        assert!(convert(Path::new("song.mp3"), "hevc", |_| {}).is_err());
        assert!(convert(Path::new("setup.exe"), "mp3", |_| {}).is_err());
    }

    #[test]
    fn hides_same_format_but_keeps_presets_that_change_something() {
        let dir = tmp_dir("inspect");
        let input = dir.join("a.jpeg");
        std::fs::write(&input, "").unwrap();
        let ids: Vec<_> = inspect(&input).unwrap().presets.iter().map(|p| p.id).collect();
        assert!(!ids.contains(&"jpg") && ids.contains(&"png"));
        let input = dir.join("a.mp4");
        std::fs::write(&input, "").unwrap();
        let ids: Vec<_> = inspect(&input).unwrap().presets.iter().map(|p| p.id).collect();
        assert!(!ids.contains(&"mp4") && ids.contains(&"small") && ids.contains(&"hevc"));
    }

    /// Stream types in a file, e.g. ["audio"] or ["audio", "video"] (sorted, cover art counts as video).
    fn streams(path: &Path) -> Vec<String> {
        let out = command("ffprobe")
            .args(["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0"])
            .arg(path)
            .output()
            .unwrap();
        let mut types: Vec<String> = String::from_utf8_lossy(&out.stdout).lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect();
        types.sort();
        types
    }

    /// Fully decodes the file; any decoder error means the output is broken even if ffmpeg "succeeded".
    fn decode_errors(path: &Path) -> String {
        let out = command("ffmpeg").args(["-v", "error", "-i"]).arg(path).args(["-f", "null", "-"]).output().unwrap();
        let errors = String::from_utf8_lossy(&out.stderr).trim().to_string();
        if out.status.success() { errors } else { format!("exit {}: {errors}", out.status) }
    }

    /// Every preset runs through real ffmpeg on realistic inputs (odd sizes, cover art, transparency),
    /// and every output is decoded end to end and checked for the right streams and length.
    #[test]
    fn every_preset_converts() {
        if !have_ffmpeg() {
            eprintln!("skipped: ffmpeg not on PATH");
            return;
        }
        let dir = tmp_dir("all");
        let audio = dir.join("tone.wav");
        generate(&audio, "sine=duration=2", &[]);
        let video = dir.join("clip.mov");
        generate(&video, "testsrc=duration=2:size=321x241:rate=15", &["-f", "lavfi", "-i", "sine=duration=2", "-shortest"]);
        let image = dir.join("pic.png");
        generate(&image, "testsrc=size=321x241", &["-frames:v", "1"]);
        let alpha = dir.join("alpha.png");
        generate(&alpha, "color=c=red@0.4:size=321x241,format=rgba", &["-frames:v", "1"]);
        // Like most downloaded songs: an MP3 with album art embedded as a picture stream.
        let cover = dir.join("song.mp3");
        let ok = command("ffmpeg")
            .args(["-v", "error", "-f", "lavfi", "-i", "sine=duration=2", "-i"]).arg(&image)
            .args(["-map", "0", "-map", "1", "-c:a", "libmp3lame", "-c:v", "png", "-disposition:v", "attached_pic"])
            .arg(&cover).status().unwrap();
        assert!(ok.success() && streams(&cover) == ["audio", "video"], "couldn't make an mp3 with cover art");

        let inputs = [(&audio, AUDIO), (&cover, AUDIO), (&video, VIDEO), (&image, IMAGE), (&alpha, IMAGE)];
        let mut checked = 0;
        for (input, presets) in inputs {
            for preset in presets {
                let name = format!("{} -> {}", input.file_name().unwrap().to_string_lossy(), preset.id);
                let mut last = 0.0;
                let out = convert(input, preset.id, |p| last = p).unwrap_or_else(|e| panic!("{name}: {e}"));
                assert!(out.metadata().unwrap().len() > 0, "{name}: empty file");
                let errors = decode_errors(&out);
                assert!(errors.is_empty(), "{name}: output doesn't decode cleanly: {errors}");

                let expected: &[&str] = match (presets.as_ptr() == IMAGE.as_ptr(), preset.id, preset.group) {
                    (true, _, _) | (_, "gif", _) => &["video"],
                    (_, _, "Audio only") => &["audio"],
                    _ if presets.as_ptr() == AUDIO.as_ptr() => &["audio"],
                    _ => &["audio", "video"],
                };
                assert_eq!(streams(&out), expected, "{name}: wrong streams");

                if presets.as_ptr() != IMAGE.as_ptr() {
                    assert!(last > 0.9, "{name}: progress stopped at {last}");
                    let length = duration(&out).unwrap_or(0.0);
                    assert!((length - 2.0).abs() < 0.3, "{name}: output is {length:.2}s, input is 2s");
                }
                checked += 1;
            }
        }
        assert_eq!(checked, 2 * AUDIO.len() + VIDEO.len() + 2 * IMAGE.len());
        // mp4, hevc and 720p already wrote clip.mp4, clip (1).mp4, clip (2).mp4; nothing gets overwritten.
        assert_eq!(convert(&video, "mp4", |_| {}).unwrap(), dir.join("clip (3).mp4"));
    }
}
