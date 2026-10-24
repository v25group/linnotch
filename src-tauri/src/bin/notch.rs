//! `notch`: reports to the linnotch island from any terminal.
//!
//!   notch <command...>   runs the command as usual; the island shows it running, then ✓ or ✗,
//!                        how long it took and the last error line. Exits with the command's code.
//!   notch report ...     what the shell integration calls after a long command (title in NOTCH_TITLE):
//!                        notch report --code 1 --ms 42000 --cwd C:\work\shop
//!   notch hook           for Claude Code hooks: reads the hook's JSON on stdin.
//!
//! When the island isn't running, commands still run; there's just nothing to report to.

use std::collections::VecDeque;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const USAGE: &str = "usage: notch <command...>   run a command and see it on the island\n       notch hook           (for Claude Code hooks)";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        None | Some("-h" | "--help") => {
            eprintln!("{USAGE}");
            std::process::exit(2);
        }
        Some("hook") => hook(),
        Some("report") => report(&args[1..]),
        _ => std::process::exit(run(&args)),
    }
}

/// The island's port and token, from the file it writes at startup (src/dev.rs).
fn endpoint() -> Option<(u16, String)> {
    let file = std::path::PathBuf::from(std::env::var_os("APPDATA")?).join("linnotch").join("endpoint.json");
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(file).ok()?).ok()?;
    Some((v["port"].as_u64()? as u16, v["token"].as_str()?.to_string()))
}

/// POSTs to the island and returns the reply's body (None if the island isn't there).
fn send(path: &str, event: serde_json::Value, wait: Duration) -> Option<String> {
    let (port, token) = endpoint()?;
    let mut s = TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_millis(300)).ok()?;
    let body = event.to_string();
    s.set_read_timeout(Some(wait)).ok()?;
    write!(s, "POST {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Linnotch-Token: {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len()).ok()?;
    // Read the whole reply, so the report is in before this process exits.
    let mut reply = String::new();
    let _ = s.read_to_string(&mut reply);
    reply.split_once("\r\n\r\n").map(|(_, body)| body.trim().to_string())
}

fn post(event: serde_json::Value) {
    send("/event", event, Duration::from_secs(1));
}

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis())
}

/// The window this command was typed into: the nearest ancestor process (Windows Terminal,
/// VS Code, the console host...) that owns a visible top-level window.
#[cfg(windows)]
fn own_window() -> Option<i64> {
    use std::collections::HashMap;
    use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM};
    use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS};
    use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, GW_OWNER, GetWindow, GetWindowThreadProcessId, IsWindowVisible};
    use windows::core::BOOL;

    let parents: HashMap<u32, u32> = unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).ok()?;
        let mut e = PROCESSENTRY32W { dwSize: size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut map = HashMap::new();
        let mut more = Process32FirstW(snap, &mut e).is_ok();
        while more {
            map.insert(e.th32ProcessID, e.th32ParentProcessID);
            more = Process32NextW(snap, &mut e).is_ok();
        }
        let _ = CloseHandle(snap);
        map
    };
    let mut chain = vec![];
    let mut pid = std::process::id();
    while let Some(&parent) = parents.get(&pid) {
        if parent == 0 || chain.contains(&parent) || chain.len() > 32 {
            break;
        }
        chain.push(parent);
        pid = parent;
    }
    struct Search {
        chain: Vec<u32>,
        best: Option<(usize, isize)>,
    }
    unsafe extern "system" fn each(hwnd: HWND, data: LPARAM) -> BOOL {
        let search = unsafe { &mut *(data.0 as *mut Search) };
        let owned = unsafe { GetWindow(hwnd, GW_OWNER) }.is_ok_and(|o| !o.0.is_null());
        if unsafe { IsWindowVisible(hwnd) }.as_bool() && !owned {
            let mut pid = 0;
            unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
            if let Some(i) = search.chain.iter().position(|p| *p == pid) {
                if search.best.is_none_or(|(b, _)| i < b) {
                    search.best = Some((i, hwnd.0 as isize));
                }
            }
        }
        true.into()
    }
    let mut search = Search { chain, best: None };
    unsafe {
        let _ = EnumWindows(Some(each), LPARAM(&mut search as *mut Search as isize));
    }
    search.best.map(|(_, h)| h as i64)
}

#[cfg(not(windows))]
fn own_window() -> Option<i64> {
    None
}

/// Whether that window is the one in front right now (you're looking at it).
fn at_own_window() -> bool {
    #[cfg(windows)]
    {
        let front = unsafe { windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow() }.0 as isize as i64;
        return own_window() == Some(front);
    }
    #[allow(unreachable_code)]
    false
}

/// Everything after the program's own name in the raw command line, quoting untouched, so
/// `notch npm run "build all"` hands cmd exactly `npm run "build all"`.
fn rest_of_command_line(line: &str) -> &str {
    let line = line.trim_start();
    let end = if let Some(quoted) = line.strip_prefix('"') {
        quoted.find('"').map_or(line.len(), |i| i + 2)
    } else {
        line.find(char::is_whitespace).unwrap_or(line.len())
    };
    line[end..].trim_start()
}

/// Text without terminal colour codes, and only what's left after the last carriage return
/// (progress bars redraw a line with \r).
fn plain(line: &str) -> String {
    let line = line.rsplit('\r').find(|s| !s.trim().is_empty()).unwrap_or("");
    let mut out = String::new();
    let mut chars = line.chars();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            // ESC [ ... final letter
            if chars.next() == Some('[') {
                for c in chars.by_ref() {
                    if c.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
        } else {
            out.push(c);
        }
    }
    out.trim().to_string()
}

/// The port a failed command couldn't get, from the usual "already in use" errors of Node, Vite,
/// Python, Rust, .NET and Windows itself. When the error doesn't name it (Python on Windows
/// doesn't), the port given in the command: `--port 3000`, `:8000`, `runserver 8000`.
fn busy_port(lines: &[String], command: &str) -> Option<u16> {
    const ERRORS: &[&str] = &["eaddrinuse", "already in use", "only one usage of each socket address", "port is already allocated"];
    let text = lines.join("\n").to_lowercase();
    if !ERRORS.iter().any(|p| text.contains(p)) {
        return None;
    }
    let digits = |s: &str| s.trim_start().chars().take_while(char::is_ascii_digit).collect::<String>().parse::<u16>().ok().filter(|p| *p > 0);
    // Only the error lines themselves and `port: 8766` lines; stack traces are full of other numbers.
    for line in text.lines().rev().filter(|l| ERRORS.iter().any(|e| l.contains(e)) || ["port ", "port:", "port="].iter().any(|k| l.contains(k))) {
        // "port 3000", "Port 5173 is in use", "port: 8766"
        for key in ["port ", "port:", "port="] {
            if let Some(p) = line.find(key).and_then(|i| digits(&line[i + key.len()..])) {
                return Some(p);
            }
        }
        // "host:port", or Python's ('127.0.0.1', 8000)
        let mut seps: Vec<_> = line.match_indices(':').chain(line.match_indices("', ")).collect();
        seps.sort();
        for (i, sep) in seps.into_iter().rev() {
            if let Some(p) = digits(&line[i + sep.len()..]) {
                return Some(p);
            }
        }
    }
    command
        .split(|c: char| c.is_whitespace() || c == ':' || c == '=')
        .filter_map(|w| w.parse::<u16>().ok())
        .rfind(|p| *p >= 80)
}

const TAIL: usize = 40;

/// Copies a child's output through to ours as it comes, keeping the last lines for the report.
fn forward(mut from: impl Read + Send + 'static, mut to: impl Write + Send + 'static, last: Arc<Mutex<String>>, tail: Arc<Mutex<VecDeque<String>>>) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut pending = Vec::new();
        let keep = |text: &str| {
            for line in text.lines().map(plain).filter(|l| !l.is_empty()) {
                *last.lock().unwrap() = line.clone();
                let mut tail = tail.lock().unwrap();
                tail.push_back(line);
                if tail.len() > TAIL {
                    tail.pop_front();
                }
            }
        };
        while let Ok(n) = from.read(&mut buf) {
            if n == 0 {
                break;
            }
            let _ = to.write_all(&buf[..n]);
            let _ = to.flush();
            pending.extend_from_slice(&buf[..n]);
            if let Some(i) = pending.iter().rposition(|b| *b == b'\n') {
                keep(&String::from_utf8_lossy(&pending[..i]));
                pending.drain(..=i);
            }
        }
        keep(&String::from_utf8_lossy(&pending));
    })
}

fn short_title(title: &str) -> String {
    let title = title.trim();
    if title.chars().count() > 60 { title.chars().take(59).collect::<String>() + "…" } else { title.to_string() }
}

fn run(args: &[String]) -> i32 {
    #[cfg(windows)]
    let line = {
        let raw = unsafe { windows::Win32::System::Environment::GetCommandLineW() };
        rest_of_command_line(&unsafe { raw.to_string() }.unwrap_or_default()).to_string()
    };
    #[cfg(not(windows))]
    let line = args.join(" ");
    let title = short_title(&args.join(" "));
    let id = format!("task-{}-{}", std::process::id(), now_ms());
    let cwd = std::env::current_dir().ok().map(|d| d.display().to_string());
    let hwnd = own_window();
    let report = |state: &str, detail: Option<String>, code: Option<i32>, ms: Option<u128>, port: Option<u16>| {
        post(serde_json::json!({ "id": id, "kind": "task", "title": title, "state": state, "detail": detail, "cwd": cwd, "hwnd": hwnd, "code": code, "ms": ms, "port": port }));
    };

    // Ctrl+C stops the command (it shares this console) but not us, so the island hears it stopped.
    // A handler, not SetConsoleCtrlHandler(None, true): that "ignore Ctrl+C" flag is inherited, so
    // the command itself (npm run dev...) couldn't be stopped. Handlers aren't inherited.
    #[cfg(windows)]
    unsafe {
        use windows::Win32::System::Console::{CTRL_BREAK_EVENT, CTRL_C_EVENT, SetConsoleCtrlHandler};
        unsafe extern "system" fn outlive_ctrl_c(kind: u32) -> windows::core::BOOL {
            (kind == CTRL_C_EVENT || kind == CTRL_BREAK_EVENT).into()
        }
        // Clear an "ignore" flag we inherited ourselves (some launchers set it) so the command gets Ctrl+C too.
        let _ = SetConsoleCtrlHandler(None, false);
        let _ = SetConsoleCtrlHandler(Some(outlive_ctrl_c), true);
    }
    let started = Instant::now();
    report("running", None, None, None, None);
    let mut cmd = if cfg!(windows) { Command::new(std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into())) } else { Command::new("sh") };
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.arg("/C").raw_arg(&line);
    }
    #[cfg(not(windows))]
    cmd.args(["-c", &line]);
    // Output is piped (to read the last lines), so ask tools to keep their colours anyway.
    // shortcut: piped output makes some tools skip interactive prompts; add a pseudo-console (ConPTY) if that bites
    for (key, value) in [("FORCE_COLOR", "1"), ("CLICOLOR_FORCE", "1"), ("CARGO_TERM_COLOR", "always")] {
        if std::env::var_os(key).is_none() {
            cmd.env(key, value);
        }
    }
    let mut child = match cmd.stdin(Stdio::inherit()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn() {
        Ok(child) => child,
        Err(e) => {
            eprintln!("notch: couldn't start the command: {e}");
            report("failed", Some(e.to_string()), Some(127), Some(0), None);
            return 127;
        }
    };
    let (out_last, err_last) = (Arc::new(Mutex::new(String::new())), Arc::new(Mutex::new(String::new())));
    let tail = Arc::new(Mutex::new(VecDeque::new()));
    let threads = [
        forward(child.stdout.take().unwrap(), std::io::stdout(), out_last.clone(), tail.clone()),
        forward(child.stderr.take().unwrap(), std::io::stderr(), err_last.clone(), tail.clone()),
    ];
    let code = child.wait().map(|s| s.code().unwrap_or(1)).unwrap_or(1);
    for t in threads {
        let _ = t.join();
    }
    let ms = started.elapsed().as_millis();
    let (out, err) = (out_last.lock().unwrap().clone(), err_last.lock().unwrap().clone());
    // A failure's reason is usually on stderr; fall back to the last thing it printed at all.
    let detail = if code == 0 || err.is_empty() { out } else { err };
    let port = if code == 0 { None } else { busy_port(&tail.lock().unwrap().iter().cloned().collect::<Vec<_>>(), &line) };
    report(if code == 0 { "done" } else { "failed" }, Some(detail).filter(|d| !d.is_empty()), Some(code), Some(ms), port);
    code
}

/// From the shell integration (src-tauri/src/dev.rs writes it into PowerShell and Git Bash):
/// a command typed without `notch` that took a while has just finished.
fn report(args: &[String]) {
    let value = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1));
    let code: i32 = value("--code").and_then(|v| v.parse().ok()).unwrap_or(0);
    let ms: u64 = value("--ms").and_then(|v| v.parse().ok()).unwrap_or(0);
    let title = short_title(&std::env::var("NOTCH_TITLE").unwrap_or_else(|_| "Command".into()));
    post(serde_json::json!({
        "id": format!("auto-{}-{}", std::process::id(), now_ms()), "kind": "task", "title": title,
        "state": if code == 0 { "done" } else { "failed" }, "detail": if code == 0 { None } else { Some(format!("Exit code {code}")) },
        "cwd": value("--cwd"), "hwnd": own_window(), "code": code, "ms": ms,
    }));
}

/// What a tool call wants to do, in one line: the command, the file, the address.
fn describe(tool: &str, input: &serde_json::Value) -> String {
    let field = ["command", "file_path", "notebook_path", "url", "query", "pattern", "path"].iter().find_map(|k| input[*k].as_str());
    match field {
        Some(text) => format!("{tool}: {text}"),
        None => format!("{tool}: {}", input),
    }
}

/// Claude Code hook: tells the island when a session starts working, needs you, or finishes, and
/// lets you allow or deny a tool from the island. Prints nothing except a permission decision
/// (UserPromptSubmit output would be added to the conversation) and always exits 0, so it can
/// never get in Claude's way. Claude Code runs it as `notch-hook.exe` (src/bin/notch-hook.rs).
pub fn hook() {
    let mut input = String::new();
    let _ = std::io::stdin().take(1 << 20).read_to_string(&mut input);
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&input) else { return };
    let folder = v["cwd"].as_str().and_then(|c| c.rsplit(['\\', '/']).find(|s| !s.is_empty())).unwrap_or("Claude");
    let session = v["session_id"].as_str().unwrap_or("default");
    let event = |state: &str, detail: String, hwnd: Option<i64>| {
        serde_json::json!({
            "id": format!("claude-{session}"), "kind": "agent", "title": format!("Claude · {folder}"),
            "state": state, "detail": detail, "cwd": v["cwd"], "hwnd": hwnd,
        })
    };
    match v["hook_event_name"].as_str().unwrap_or("") {
        "UserPromptSubmit" => post(event("running", "Working…".into(), own_window())),
        "Notification" => post(event("waiting", v["message"].as_str().unwrap_or("Needs your input").into(), None)),
        "Stop" => post(event("done", "Finished".into(), None)),
        "PermissionRequest" => {
            // You're looking at the terminal: Claude's own prompt is quicker than the island.
            if at_own_window() {
                return;
            }
            let what = describe(v["tool_name"].as_str().unwrap_or("Tool"), &v["tool_input"]);
            // The island waits up to 55 s for a click; no answer means Claude asks in the terminal as usual.
            let answer = send("/ask", event("waiting", what, own_window()), Duration::from_secs(58));
            let decision = match answer.as_deref() {
                Some("allow") => serde_json::json!({ "behavior": "allow" }),
                Some("deny") => serde_json::json!({ "behavior": "deny", "message": "Denied from the linnotch island." }),
                _ => return,
            };
            println!("{}", serde_json::json!({ "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": decision } }));
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_command_is_passed_on_exactly() {
        assert_eq!(rest_of_command_line(r#""C:\a b\notch.exe" npm run "build all""#), r#"npm run "build all""#);
        assert_eq!(rest_of_command_line("notch  cargo test -- --nocapture"), "cargo test -- --nocapture");
        assert_eq!(rest_of_command_line("notch"), "");
    }

    #[test]
    fn the_last_line_is_plain_text() {
        assert_eq!(plain("\x1b[31merror\x1b[0m: build failed  "), "error: build failed");
        assert_eq!(plain("downloading 10%\rdownloading 100%"), "downloading 100%");
    }

    #[test]
    fn a_busy_port_is_found_in_the_error() {
        let lines = |s: &str| s.lines().map(String::from).collect::<Vec<_>>();
        assert_eq!(busy_port(&lines("Error: listen EADDRINUSE: address already in use :::3000\n    at Server.setupListenHandle"), ""), Some(3000));
        assert_eq!(busy_port(&lines("error when starting dev server:\nError: Port 5173 is already in use"), ""), Some(5173));
        assert_eq!(busy_port(&lines("Error: [Errno 10048] error while attempting to bind on address ('127.0.0.1', 8000): only one usage of each socket address"), ""), Some(8000));
        assert_eq!(busy_port(&lines("thread 'main' panicked: Address already in use (os error 10048) binding 0.0.0.0:8080"), ""), Some(8080));
        assert_eq!(busy_port(&lines("test failed: expected 3000 got 3001"), "npm test"), None);
        // Node's real output: the stack trace has "executeUserEntryPoint ... run_main:154:5" in it.
        let node = "Error: listen EADDRINUSE: address already in use :::8766\n    at Server.setupListenHandle [as _listen2] (node:net:2008:16)\n    at Object.<anonymous> (C:\\Users\\me\\server.js:1:53)\n    at Module.executeUserEntryPoint [as runMain] (node:internal/modules/run_main:154:5)\n  code: 'EADDRINUSE',\n  address: '::',\n  port: 8766\n}";
        assert_eq!(busy_port(&lines(node), "node server.js"), Some(8766));
        let windows_python = lines("OSError: [WinError 10048] Only one usage of each socket address (protocol/network address/port) is normally permitted");
        assert_eq!(busy_port(&windows_python, "python manage.py runserver 0.0.0.0:8000"), Some(8000));
        assert_eq!(busy_port(&windows_python, "python -m http.server 8766"), Some(8766));
    }
}
