//! Developer tools: a local endpoint the `notch` command (src/bin/notch.rs) and AI-agent hooks
//! report to, listening ports with the process behind each, CPU/RAM meters, pull requests through
//! the GitHub CLI's own login, and one-click setup of the `notch` command and Claude Code hooks.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::ffi::c_void;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Emitter, WebviewWindow};
use windows::Win32::Foundation::{CloseHandle, FILETIME, HWND, LPARAM, WPARAM};
use windows::Win32::NetworkManagement::IpHelper::{
    GetExtendedTcpTable, MIB_TCP6TABLE_OWNER_PID, MIB_TCPTABLE_OWNER_PID, TCP_TABLE_OWNER_PID_LISTENER,
};
use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
use windows::Win32::System::Threading::{
    GetSystemTimes, OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
    QueryFullProcessImageNameW, TerminateProcess,
};
use windows::Win32::UI::WindowsAndMessaging::{
    HWND_BROADCAST, IsIconic, IsWindow, SMTO_ABORTIFHUNG, SW_RESTORE, SendMessageTimeoutW, SetForegroundWindow,
    ShowWindow, WM_SETTINGCHANGE,
};
use windows::core::{PWSTR, w};

const MAX_BODY: u64 = 64 * 1024;

/// Where the island tells `notch` how to reach it. src/bin/notch.rs reads the same path.
fn endpoint_file() -> PathBuf {
    PathBuf::from(std::env::var_os("APPDATA").unwrap_or_default()).join("linnotch").join("endpoint.json")
}

/// The installed `notch` command, in a folder of its own on the user's PATH.
fn cli_dir() -> PathBuf {
    PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap_or_default()).join("linnotch").join("bin")
}

/// One report from a task or an agent; reports with the same `id` are the same run.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct DevEvent {
    id: String,
    /// "task" (a command run with `notch`) or "agent" (Claude Code and the like).
    kind: String,
    title: String,
    /// "running", "waiting" (an agent needs you), "done" or "failed".
    state: String,
    #[serde(default)]
    detail: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
    /// The terminal (or editor) window it was started from, to jump back to it.
    #[serde(default)]
    hwnd: Option<i64>,
    #[serde(default)]
    code: Option<i32>,
    /// How long it took, for finished tasks.
    #[serde(default)]
    ms: Option<u64>,
    /// A failed task couldn't get this port (something else is using it).
    #[serde(default)]
    port: Option<u16>,
    /// Set by the island (never by the sender): an agent is waiting for Allow / Deny.
    #[serde(default, skip_deserializing)]
    ask: Option<bool>,
}

fn clip(s: &mut String, max: usize) {
    if let Some((i, _)) = s.char_indices().nth(max) {
        s.truncate(i);
        s.push('…');
    }
}

impl DevEvent {
    /// Rejects unknown kinds and states, and trims every text so a chatty script can't flood the UI.
    fn checked(mut self) -> Option<Self> {
        let ok = ["task", "agent"].contains(&self.kind.as_str())
            && ["running", "waiting", "done", "failed"].contains(&self.state.as_str())
            && !self.id.is_empty();
        if !ok {
            return None;
        }
        clip(&mut self.id, 100);
        clip(&mut self.title, 120);
        for text in [&mut self.detail, &mut self.cwd].into_iter().flatten() {
            clip(text, 300);
        }
        Some(self)
    }
}

fn random_token() -> String {
    use std::hash::{BuildHasher, RandomState};
    // RandomState is seeded from the OS's random source; two of them make a 128-bit token.
    (0..2).map(|i| format!("{:016x}", RandomState::new().hash_one(i))).collect()
}

/// Starts the endpoint (127.0.0.1, a random port, a token in a file only this user can read)
/// and the watch for new dev servers.
pub fn spawn(window: WebviewWindow) {
    std::thread::spawn(refresh_cli);
    spawn_port_watch(window.clone());
    let Ok(listener) = TcpListener::bind("127.0.0.1:0") else { return };
    let Ok(port) = listener.local_addr().map(|a| a.port()) else { return };
    let token = random_token();
    let file = endpoint_file();
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if std::fs::write(&file, serde_json::json!({ "port": port, "token": token }).to_string()).is_err() {
        return;
    }
    let token: &'static str = token.leak();
    std::thread::spawn(move || {
        // A thread per connection: an /ask waits for your click while reports keep coming in.
        for stream in listener.incoming().flatten() {
            let window = window.clone();
            std::thread::spawn(move || {
                let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                let (status, body) = match read_event(&stream, token) {
                    Ok((false, event)) => {
                        let _ = window.emit("dev", event);
                        ("204 No Content", String::new())
                    }
                    Ok((true, event)) => ("200 OK", ask(&window, event)),
                    Err(status) => (status, String::new()),
                };
                let reply = format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                let _ = (&stream).write_all(reply.as_bytes());
            });
        }
    });
}

/// Pending "allow this tool?" questions, by agent id, waiting for a click in the island.
static ASKS: Mutex<Option<HashMap<String, std::sync::mpsc::Sender<bool>>>> = Mutex::new(None);

/// Shows the question and waits up to 55 s: "allow", "deny", or "" (no answer, so Claude asks
/// in its terminal as usual). Never answers on its own.
fn ask(window: &WebviewWindow, mut event: DevEvent) -> String {
    let (tx, rx) = std::sync::mpsc::channel();
    {
        let mut asks = ASKS.lock().unwrap();
        let asks = asks.get_or_insert_default();
        // A second question under the same id would replace the first's answer channel; send it to the terminal.
        if asks.contains_key(&event.id) {
            return String::new();
        }
        asks.insert(event.id.clone(), tx);
    }
    let id = event.id.clone();
    event.ask = Some(true);
    let _ = window.emit("dev", event);
    let answer = rx.recv_timeout(Duration::from_secs(55));
    ASKS.lock().unwrap().get_or_insert_default().remove(&id);
    // Either way the buttons go: answered here, or the terminal has the question now.
    let _ = window.emit("ask-done", serde_json::json!({ "id": id, "answered": answer.is_ok() }));
    match answer {
        Ok(true) => "allow".into(),
        Ok(false) => "deny".into(),
        Err(_) => String::new(),
    }
}

/// Your answer to an agent's "allow this tool?" from the island.
#[tauri::command]
pub fn answer_ask(id: String, allow: bool) -> Result<(), String> {
    let tx = ASKS.lock().unwrap().get_or_insert_default().remove(&id).ok_or("That question has already gone to the terminal.")?;
    tx.send(allow).map_err(|_| "That question has already gone to the terminal.".to_string())
}

/// Compares in constant time, so response timing doesn't leak how much of a guess was right.
fn same_token(given: &str, token: &str) -> bool {
    given.len() == token.len() && given.bytes().zip(token.bytes()).fold(0, |acc, (a, b)| acc | (a ^ b)) == 0
}

/// `POST /event` (a report) or `POST /ask` (a question that waits for an answer), with the token
/// in `X-Linnotch-Token` and a DevEvent as JSON. Browsers can't send that header cross-site
/// without a CORS preflight, which this never answers. Returns (is it a question, the event).
fn read_event(stream: impl Read, token: &str) -> Result<(bool, DevEvent), &'static str> {
    const BAD: &str = "400 Bad Request";
    let mut reader = BufReader::new(stream.take(MAX_BODY + 8192));
    let mut line = String::new();
    reader.read_line(&mut line).map_err(|_| BAD)?;
    let is_ask = line.starts_with("POST /ask ");
    if !is_ask && !line.starts_with("POST /event ") {
        return Err("404 Not Found");
    }
    let (mut length, mut authorized) = (0u64, false);
    loop {
        line.clear();
        if reader.read_line(&mut line).map_err(|_| BAD)? == 0 {
            return Err(BAD);
        }
        let header = line.trim_end();
        if header.is_empty() {
            break;
        }
        if let Some((name, value)) = header.split_once(':') {
            match name.trim().to_ascii_lowercase().as_str() {
                "content-length" => length = value.trim().parse().map_err(|_| BAD)?,
                "x-linnotch-token" => authorized = same_token(value.trim(), token),
                _ => {}
            }
        }
    }
    if !authorized {
        return Err("401 Unauthorized");
    }
    if length > MAX_BODY {
        return Err("413 Payload Too Large");
    }
    let mut body = vec![0; length as usize];
    reader.read_exact(&mut body).map_err(|_| BAD)?;
    let event = serde_json::from_slice::<DevEvent>(&body).map_err(|_| BAD)?.checked().ok_or("422 Unprocessable Entity")?;
    // Only agents ask, and they must be waiting for the answer.
    if is_ask && (event.kind != "agent" || event.state != "waiting") {
        return Err("422 Unprocessable Entity");
    }
    Ok((is_ask, event))
}

/// Brings a task's terminal back to the front.
#[tauri::command]
pub fn focus_window(hwnd: i64) -> Result<(), String> {
    let hwnd = HWND(hwnd as isize as *mut c_void);
    unsafe {
        if !IsWindow(Some(hwnd)).as_bool() {
            return Err("That window is closed.".into());
        }
        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        }
        let _ = SetForegroundWindow(hwnd);
    }
    Ok(())
}

// ---- Ports -------------------------------------------------------------------------------------

#[derive(Serialize, Clone, Debug)]
pub struct Port {
    port: u16,
    pid: u32,
    /// "node", "python"...
    name: String,
    /// Listening on every network interface, not just this PC (other devices can reach it).
    public: bool,
    /// The project folder's name, guessed from the command line.
    project: Option<String>,
}

/// Listening TCP ports and their process ids, IPv4 and IPv6 merged: (port, pid, public).
fn listening() -> Vec<(u16, u32, bool)> {
    let mut found: HashMap<(u16, u32), bool> = HashMap::new();
    // u32 buffers: the tables hold u32 fields and must be aligned for them.
    let table = |family: u32| -> Vec<u32> {
        let mut size = 0u32;
        unsafe {
            GetExtendedTcpTable(None, &mut size, false, family, TCP_TABLE_OWNER_PID_LISTENER, 0);
            let mut buf = vec![0u32; size as usize / 4 + 256];
            size = (buf.len() * 4) as u32;
            if GetExtendedTcpTable(Some(buf.as_mut_ptr().cast()), &mut size, false, family, TCP_TABLE_OWNER_PID_LISTENER, 0) != 0 {
                return vec![];
            }
            buf
        }
    };
    // AF_INET = 2, AF_INET6 = 23.
    let v4 = table(2);
    if !v4.is_empty() {
        let t = unsafe { &*(v4.as_ptr() as *const MIB_TCPTABLE_OWNER_PID) };
        for r in unsafe { std::slice::from_raw_parts(t.table.as_ptr(), t.dwNumEntries as usize) } {
            let public = r.dwLocalAddr.to_ne_bytes()[0] != 127;
            *found.entry((u16::from_be(r.dwLocalPort as u16), r.dwOwningPid)).or_default() |= public;
        }
    }
    let v6 = table(23);
    if !v6.is_empty() {
        let t = unsafe { &*(v6.as_ptr() as *const MIB_TCP6TABLE_OWNER_PID) };
        for r in unsafe { std::slice::from_raw_parts(t.table.as_ptr(), t.dwNumEntries as usize) } {
            let loopback = r.ucLocalAddr[..15].iter().all(|b| *b == 0) && r.ucLocalAddr[15] == 1;
            *found.entry((u16::from_be(r.dwLocalPort as u16), r.dwOwningPid)).or_default() |= !loopback;
        }
    }
    let mut list: Vec<_> = found.into_iter().map(|((port, pid), public)| (port, pid, public)).collect();
    list.sort();
    list
}

fn exe_of(pid: u32) -> Option<PathBuf> {
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len);
        let _ = CloseHandle(h);
        ok.ok()?;
        Some(PathBuf::from(String::from_utf16_lossy(&buf[..len as usize])))
    }
}

/// Windows' own services and anything we can't even look at are left out.
fn is_system(pid: u32, exe: Option<&Path>) -> bool {
    let windir = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into()).to_lowercase();
    pid <= 4 || pid == std::process::id() || exe.is_none_or(|e| e.to_string_lossy().to_lowercase().starts_with(&windir))
}

const DEV_NAMES: &[&str] = &[
    "node", "bun", "deno", "python", "pythonw", "python3", "uv", "java", "javaw", "dotnet", "iisexpress", "ruby", "php", "php-cgi",
    "go", "air", "uvicorn", "gunicorn", "hugo", "caddy", "nginx", "httpd", "postgres", "mysqld", "mariadbd", "redis-server",
    "mongod", "memurai", "docker-proxy", "com.docker.backend", "wslrelay", "ngrok", "cloudflared", "mailpit", "minio",
];

/// A dev server: a known runtime or database, or a program built from source (`cargo run`,
/// `go run`, `dotnet run`). Installed apps that happen to listen (Steam, vendor helpers) aren't.
fn is_dev(name: &str, exe: &Path) -> bool {
    let path = exe.to_string_lossy().to_lowercase();
    DEV_NAMES.contains(&name.to_lowercase().as_str())
        || [r"\target\debug\", r"\target\release\", r"\go-build", r"\bin\debug\", r"\bin\release\"].iter().any(|p| path.contains(p))
}

/// The project a dev server belongs to, from its command line:
/// `node C:\work\shop\node_modules\vite\bin\vite.js` -> "shop", `python C:\work\api\main.py` -> "api".
fn project_of(cmd: &str) -> Option<String> {
    let name = |dir: &str| dir.trim_matches('"').rsplit(['\\', '/']).find(|s| !s.is_empty()).map(str::to_string);
    if let Some(i) = cmd.find("node_modules") {
        return name(&cmd[..i]);
    }
    // The first argument after the program that is an absolute path: its folder.
    let mut args = vec![];
    let (mut cur, mut quoted) = (String::new(), false);
    for c in cmd.chars() {
        match c {
            '"' => quoted = !quoted,
            c if c.is_whitespace() && !quoted => args.push(std::mem::take(&mut cur)),
            c => cur.push(c),
        }
    }
    args.push(cur);
    let path = args.iter().skip(1).find(|a| a.get(1..3) == Some(":\\") || a.get(1..3) == Some(":/"))?;
    let path = Path::new(path);
    let dir = if path.extension().is_some() { path.parent()? } else { path };
    dir.file_name().map(|n| n.to_string_lossy().into_owned())
}

#[derive(Deserialize)]
#[serde(rename = "Win32_Process", rename_all = "PascalCase")]
struct WmiProcess {
    process_id: u32,
    command_line: Option<String>,
}

fn command_lines(pids: &[u32]) -> HashMap<u32, String> {
    if pids.is_empty() {
        return HashMap::new();
    }
    let filter = pids.iter().map(|p| format!("ProcessId = {p}")).collect::<Vec<_>>().join(" OR ");
    let query = format!("SELECT ProcessId, CommandLine FROM Win32_Process WHERE {filter}");
    wmi::WMIConnection::new()
        .ok()
        .and_then(|c| c.raw_query::<WmiProcess>(&query).ok())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|p| Some((p.process_id, p.command_line?)))
        .collect()
}

fn ports_now(with_projects: bool) -> Vec<Port> {
    let mut list: Vec<Port> = vec![];
    for (port, pid, public) in listening() {
        let exe = exe_of(pid);
        let Some(exe) = exe.filter(|e| !is_system(pid, Some(e))) else { continue };
        let name = exe.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        if !is_dev(&name, &exe) {
            continue;
        }
        list.push(Port { port, pid, name, public, project: None });
    }
    if with_projects {
        let pids: Vec<u32> = list.iter().map(|p| p.pid).collect::<HashSet<_>>().into_iter().collect();
        let lines = command_lines(&pids);
        for p in &mut list {
            p.project = lines.get(&p.pid).and_then(|c| project_of(c));
        }
    }
    list.sort_by_key(|p| p.port);
    list
}

#[tauri::command]
pub async fn ports() -> Vec<Port> {
    // WMI wants a thread of its own (the main thread's COM mode doesn't suit it).
    tauri::async_runtime::spawn_blocking(|| ports_now(true)).await.unwrap_or_default()
}

/// Stops the process listening on `port`. Only if it still is, and never one of Windows' own.
#[tauri::command]
pub fn stop_port(port: u16, pid: u32) -> Result<(), String> {
    if !listening().iter().any(|(p, id, _)| *p == port && *id == pid) {
        return Err("It's not listening any more.".into());
    }
    if is_system(pid, exe_of(pid).as_deref()) {
        return Err("That's a Windows process; leaving it alone.".into());
    }
    unsafe {
        let h = OpenProcess(PROCESS_TERMINATE, false, pid).map_err(|e| e.message())?;
        let done = TerminateProcess(h, 1);
        let _ = CloseHandle(h);
        done.map_err(|e| e.message())
    }
}

/// "Port 3000 is already in use": stops whatever is listening there (any app, never Windows' own)
/// and says what it was.
#[tauri::command]
pub fn free_port(port: u16) -> Result<String, String> {
    let (_, pid, _) = listening().into_iter().find(|(p, _, _)| *p == port).ok_or("Nothing is using that port now.")?;
    let name = exe_of(pid).and_then(|e| e.file_stem().map(|s| s.to_string_lossy().into_owned())).unwrap_or_else(|| "it".into());
    stop_port(port, pid)?;
    Ok(name)
}

/// Opens a local port, or a GitHub page, in the default browser. Nothing else.
#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    let local = url.strip_prefix("http://localhost:").is_some_and(|rest| rest.split('/').next().is_some_and(|p| p.parse::<u16>().is_ok()));
    if !local && !url.starts_with("https://github.com/") && !url.starts_with("https://www.v25group.com/") {
        return Err("not a link the island opens".into());
    }
    crate::platform::explorer(url)
}

/// Pops up when a dev server starts listening.
fn spawn_port_watch(window: WebviewWindow) {
    std::thread::spawn(move || {
        let mut known: Option<HashSet<u16>> = None;
        loop {
            let now = listening();
            let ports: HashSet<u16> = now.iter().map(|p| p.0).collect();
            if let Some(known) = &known {
                for (port, pid, public) in now.iter().filter(|p| !known.contains(&p.0)) {
                    let Some(exe) = exe_of(*pid) else { continue };
                    let name = exe.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
                    if !is_system(*pid, Some(&exe)) && is_dev(&name, &exe) {
                        let project = command_lines(&[*pid]).get(pid).and_then(|c| project_of(c));
                        let _ = window.emit("port-opened", Port { port: *port, pid: *pid, name, public: *public, project });
                    }
                }
            }
            known = Some(ports);
            std::thread::sleep(Duration::from_secs(3));
        }
    });
}

// ---- Docker ------------------------------------------------------------------------------------

#[derive(Serialize)]
pub struct Container {
    id: String,
    name: String,
    image: String,
    status: String,
    /// "0.0.0.0:5432->5432/tcp"
    ports: String,
}

fn docker_ps() -> Result<Vec<Container>, String> {
    let out = crate::convert::command("docker").args(["ps", "--format", "{{json .}}"]).output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err("Docker isn't running.".into());
    }
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
        .map(|v| {
            let s = |k: &str| v[k].as_str().unwrap_or_default().to_string();
            Container { id: s("ID"), name: s("Names"), image: s("Image"), status: s("Status"), ports: s("Ports") }
        })
        .collect())
}

/// Running containers, or None when Docker isn't installed or isn't running (the list is hidden).
#[tauri::command]
pub async fn containers() -> Option<Vec<Container>> {
    tauri::async_runtime::spawn_blocking(|| docker_ps().ok()).await.ok().flatten()
}

#[tauri::command]
pub async fn stop_container(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        // Only a container that's running right now, by its exact id.
        if !docker_ps()?.iter().any(|c| c.id == id) {
            return Err("That container isn't running.".to_string());
        }
        let out = crate::convert::command("docker").args(["stop", &id]).output().map_err(|e| e.to_string())?;
        if out.status.success() { Ok(()) } else { Err(String::from_utf8_lossy(&out.stderr).trim().to_string()) }
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---- Meters ------------------------------------------------------------------------------------

#[derive(Serialize)]
pub struct Meters {
    /// Percent of all cores since the last call.
    cpu: u32,
    ram: u32,
    ram_used_gb: f64,
    ram_total_gb: f64,
}

static LAST_CPU: Mutex<Option<(u64, u64)>> = Mutex::new(None);

#[tauri::command]
pub fn meters() -> Meters {
    let (mut idle, mut kernel, mut user) = (FILETIME::default(), FILETIME::default(), FILETIME::default());
    unsafe {
        let _ = GetSystemTimes(Some(&mut idle), Some(&mut kernel), Some(&mut user));
    }
    let n = |t: FILETIME| ((t.dwHighDateTime as u64) << 32) | t.dwLowDateTime as u64;
    // Kernel time includes idle time.
    let (idle, total) = (n(idle), n(kernel) + n(user));
    let mut last = LAST_CPU.lock().unwrap();
    let cpu = match *last {
        Some((idle0, total0)) if total > total0 => 100.0 * (1.0 - idle.saturating_sub(idle0) as f64 / (total - total0) as f64),
        _ => 0.0,
    };
    *last = Some((idle, total));
    let mut mem = MEMORYSTATUSEX { dwLength: size_of::<MEMORYSTATUSEX>() as u32, ..Default::default() };
    unsafe {
        let _ = GlobalMemoryStatusEx(&mut mem);
    }
    const GB: f64 = 1024.0 * 1024.0 * 1024.0;
    Meters {
        cpu: cpu.clamp(0.0, 100.0).round() as u32,
        ram: mem.dwMemoryLoad,
        ram_used_gb: (mem.ullTotalPhys - mem.ullAvailPhys) as f64 / GB,
        ram_total_gb: mem.ullTotalPhys as f64 / GB,
    }
}

// ---- GitHub ------------------------------------------------------------------------------------

const GITHUB_QUERY: &str = "query {
  viewer {
    login
    pullRequests(first: 20, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes { number title url isDraft reviewDecision headRefName repository { nameWithOwner }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } }
    }
    repositories(first: 5, orderBy: {field: PUSHED_AT, direction: DESC}, ownerAffiliations: [OWNER, COLLABORATOR]) {
      nodes { nameWithOwner }
    }
  }
  reviews: search(query: \"is:open is:pr review-requested:@me archived:false\", type: ISSUE, first: 20) {
    nodes { ... on PullRequest { number title url repository { nameWithOwner } author { login } } }
  }
  issues: search(query: \"is:open is:issue assignee:@me archived:false\", type: ISSUE, first: 15) {
    nodes { ... on Issue { number title url repository { nameWithOwner } } }
  }
}";

fn gh(args: &[&str]) -> Result<serde_json::Value, String> {
    let out = crate::convert::command("gh")
        .args(args)
        .output()
        .map_err(|e| if e.kind() == std::io::ErrorKind::NotFound { "gh-missing".to_string() } else { e.to_string() })?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).to_string();
        return Err(if err.contains("auth login") || err.contains("not logged") { "gh-auth".into() } else { err.trim().to_string() });
    }
    serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())
}

/// Your open pull requests with their checks, reviews asked of you, issues assigned to you, and
/// your latest workflow runs in the 5 repos you pushed to most recently. Through the GitHub CLI,
/// so its login is used and no token is stored here. Errors: "gh-missing", "gh-auth".
#[tauri::command]
pub async fn github() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let graphql = gh(&["api", "graphql", "-f", &format!("query={GITHUB_QUERY}")])?;
        let login = graphql["data"]["viewer"]["login"].as_str().unwrap_or_default().to_string();
        let repos: Vec<String> = graphql["data"]["viewer"]["repositories"]["nodes"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|r| r["nameWithOwner"].as_str().map(str::to_string))
            .collect();
        // One request per repo, side by side; a repo without Actions just has no runs.
        let runs: Vec<serde_json::Value> = std::thread::scope(|scope| {
            let jobs: Vec<_> = repos
                .iter()
                .map(|repo| {
                    let path = format!("repos/{repo}/actions/runs?actor={login}&per_page=3");
                    scope.spawn(move || {
                        gh(&["api", &path]).ok().map(|v| {
                            v["workflow_runs"].as_array().cloned().unwrap_or_default().into_iter().map(|mut run| {
                                run["repo"] = serde_json::Value::String(repo.clone());
                                run
                            }).collect::<Vec<_>>()
                        })
                    })
                })
                .collect();
            jobs.into_iter().filter_map(|j| j.join().ok().flatten()).flatten().collect()
        });
        Ok(serde_json::json!({ "graphql": graphql, "runs": runs }))
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---- Setup: the `notch` command and Claude Code hooks -------------------------------------------

#[derive(Serialize)]
pub struct Setup {
    /// `notch` is installed and its folder is on the user's PATH.
    cli: bool,
    /// Claude Code is on this PC (~/.claude exists).
    claude_found: bool,
    /// Its hooks report to the island.
    claude: bool,
    /// PowerShell / Git Bash report long commands without `notch` in front.
    shell: bool,
}

fn claude_settings() -> PathBuf {
    PathBuf::from(std::env::var_os("USERPROFILE").unwrap_or_default()).join(".claude").join("settings.json")
}

fn user_path() -> (String, u32) {
    let env = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER).open_subkey("Environment").ok();
    env.and_then(|k| k.get_raw_value("Path").ok())
        .map(|v| {
            let wide: Vec<u16> = v.bytes.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
            (String::from_utf16_lossy(&wide).trim_end_matches('\0').to_string(), v.vtype as u32)
        })
        .unwrap_or_default()
}

fn on_path(path: &str, dir: &Path) -> bool {
    let dir = dir.to_string_lossy().to_lowercase();
    path.split(';').any(|p| p.trim().trim_end_matches('\\').to_lowercase() == dir)
}

/// The command our hook entries run: the windowless twin of `notch hook` (no terminal flashing).
fn hook_command() -> String {
    format!("\"{}\"", cli_dir().join("notch-hook.exe").display())
}

/// The `notch` command's files, copied from next to the island into `cli_dir()`.
const CLI_FILES: &[&str] = &["notch.exe", "notch-hook.exe"];

// PermissionRequest lets you allow or deny a tool from the island; the others report progress.
const HOOK_EVENTS: &[&str] = &["UserPromptSubmit", "Notification", "Stop", "PermissionRequest"];

/// Ours now (notch-hook.exe) or from before it (notch.exe hook), so old entries get replaced.
fn is_ours(entry: &serde_json::Value) -> bool {
    entry["hooks"].as_array().is_some_and(|hooks| hooks.iter().any(|h| h["command"].as_str().is_some_and(|c| c.contains(r"\linnotch\bin\notch"))))
}

#[tauri::command]
pub fn dev_setup() -> Setup {
    let settings = claude_settings();
    let claude = std::fs::read_to_string(&settings)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .is_some_and(|v| HOOK_EVENTS.iter().all(|e| v["hooks"][e].as_array().is_some_and(|l| l.iter().any(is_ours))));
    Setup {
        cli: cli_dir().join("notch.exe").is_file() && on_path(&user_path().0, &cli_dir()),
        claude_found: settings.parent().is_some_and(Path::is_dir),
        claude,
        shell: shell_files().iter().any(|(_, f, _)| std::fs::read_to_string(f).is_ok_and(|t| t.contains(BLOCK_START))),
    }
}

// ---- Shell integration: long commands are reported without typing `notch` ------------------------

const BLOCK_START: &str = "# >>> linnotch >>>";
const BLOCK_END: &str = "# <<< linnotch <<<";

const POWERSHELL: &str = r#"# >>> linnotch >>>
# Added by linnotch: commands that take over 10 seconds pop up on the island when they finish.
if (Get-Command notch.exe -ErrorAction SilentlyContinue) {
  $global:__linnotchPrompt = $function:prompt
  function global:prompt {
    $ok = $?
    $h = Get-History -Count 1
    if ($h -and $h.Id -ne $global:__linnotchId) {
      $global:__linnotchId = $h.Id
      $ms = [long]($h.EndExecutionTime - $h.StartExecutionTime).TotalMilliseconds
      if ($ms -ge 10000 -and $h.CommandLine -notmatch '^\s*notch(\.exe)?\s') {
        $code = if ($ok) { 0 } elseif ($global:LASTEXITCODE) { $global:LASTEXITCODE } else { 1 }
        $env:NOTCH_TITLE = $h.CommandLine
        notch.exe report --code $code --ms $ms --cwd "$PWD" 2>$null | Out-Null
        Remove-Item Env:NOTCH_TITLE -ErrorAction SilentlyContinue
      }
    }
    & $global:__linnotchPrompt
  }
}
# <<< linnotch <<<
"#;

const BASH: &str = r#"# >>> linnotch >>>
# Added by linnotch: commands that take over 10 seconds pop up on the island when they finish.
if command -v notch >/dev/null 2>&1; then
  __linnotch_armed=1
  __linnotch_pre() { [ -n "$__linnotch_armed" ] || return 0; __linnotch_armed=; __linnotch_t=$SECONDS; }
  __linnotch_post() {
    local code=$?
    if [ -n "$__linnotch_t" ] && [ $((SECONDS - __linnotch_t)) -ge 10 ]; then
      local cmd; cmd=$(HISTTIMEFORMAT= history 1 | sed 's/^ *[0-9]* *//')
      case "$cmd" in
        notch\ *) ;;
        *) NOTCH_TITLE="$cmd" notch report --code "$code" --ms $(( (SECONDS - __linnotch_t) * 1000 )) --cwd "$(cygpath -w "$PWD" 2>/dev/null || pwd)" >/dev/null 2>&1 ;;
      esac
    fi
    __linnotch_t=
  }
  __linnotch_arm() { __linnotch_armed=1; }
  if declare -p preexec_functions >/dev/null 2>&1; then
    # bash-preexec is loaded: join it instead of taking over the DEBUG trap.
    preexec_functions+=(__linnotch_pre)
    precmd_functions=(__linnotch_post "${precmd_functions[@]}" __linnotch_arm)
  else
    # Keep a DEBUG trap you already had: it still runs, after ours.
    __linnotch_old=$(trap -p DEBUG)
    __linnotch_old=${__linnotch_old#"trap -- '"}
    __linnotch_old=${__linnotch_old%"' DEBUG"}
    __linnotch_old=${__linnotch_old//"'\\''"/"'"}
    trap '__linnotch_pre; [ -z "$__linnotch_old" ] || eval "$__linnotch_old"' DEBUG
    PROMPT_COMMAND="__linnotch_post${PROMPT_COMMAND:+;$PROMPT_COMMAND};__linnotch_arm"
  fi
fi
# <<< linnotch <<<
"#;

/// `text` without our block, then with `block` appended at the end (so it wraps whatever prompt
/// the rest of the file sets up, oh-my-posh and the like).
fn with_block(text: &str, block: Option<&str>) -> String {
    let mut out = match (text.find(BLOCK_START), text.find(BLOCK_END)) {
        (Some(a), Some(b)) if b > a => {
            let end = text[b..].find('\n').map_or(text.len(), |i| b + i + 1);
            format!("{}{}", &text[..a], &text[end..])
        }
        _ => text.to_string(),
    };
    if let Some(block) = block {
        if !out.is_empty() && !out.ends_with('\n') {
            out.push('\n');
        }
        out.push_str(block);
    }
    out
}

fn installed(program: &str) -> bool {
    crate::convert::command("where.exe").arg(program).output().is_ok_and(|o| o.status.success())
}

/// Whether a PowerShell's execution policy lets it run profile scripts at all.
fn profiles_allowed(shell: &str) -> bool {
    crate::convert::command(shell)
        .args(["-NoProfile", "-NonInteractive", "-Command", "Get-ExecutionPolicy"])
        .output()
        .is_ok_and(|o| !matches!(String::from_utf8_lossy(&o.stdout).trim(), "Restricted" | "AllSigned"))
}

/// The shells on this PC: (name, startup file, the snippet it takes).
fn shell_files() -> Vec<(&'static str, PathBuf, &'static str)> {
    let mut files = vec![];
    if let Some(docs) = crate::platform::documents_dir() {
        if installed("pwsh") {
            files.push(("PowerShell 7", docs.join("PowerShell").join("Microsoft.PowerShell_profile.ps1"), POWERSHELL));
        }
        files.push(("Windows PowerShell", docs.join("WindowsPowerShell").join("Microsoft.PowerShell_profile.ps1"), POWERSHELL));
    }
    let home = PathBuf::from(std::env::var_os("USERPROFILE").unwrap_or_default());
    // Git for Windows brings Git Bash (`where bash` would find WSL's, which doesn't read this file).
    if installed("git") || home.join(".bashrc").is_file() {
        files.push(("Git Bash", home.join(".bashrc"), BASH));
    }
    files
}

/// Adds (or removes) the snippet in each shell's startup file. Returns which shells now report,
/// and a note for any that can't (Windows PowerShell's default policy blocks profile scripts).
#[tauri::command]
pub async fn shell_watch(on: bool) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || set_shell_watch(on)).await.map_err(|e| e.to_string())?
}

fn set_shell_watch(on: bool) -> Result<String, String> {
    {
        if on && !cli_dir().join("notch.exe").is_file() {
            return Err("Set up the notch command first.".to_string());
        }
        let (mut done, mut blocked) = (vec![], vec![]);
        for (name, file, snippet) in shell_files() {
            let text = std::fs::read_to_string(&file).unwrap_or_default();
            if !on {
                if text.contains(BLOCK_START) {
                    std::fs::write(&file, with_block(&text, None)).map_err(|e| format!("{name}: {e}"))?;
                }
                continue;
            }
            let exe = if name == "PowerShell 7" { "pwsh" } else { "powershell" };
            if name != "Git Bash" && !profiles_allowed(exe) {
                blocked.push(name);
                continue;
            }
            if let Some(dir) = file.parent() {
                std::fs::create_dir_all(dir).map_err(|e| format!("{name}: {e}"))?;
            }
            std::fs::write(&file, with_block(&text, Some(snippet))).map_err(|e| format!("{name}: {e}"))?;
            done.push(name);
        }
        if !on {
            return Ok("Long commands aren't watched any more.".into());
        }
        let mut message = if done.is_empty() { "No shell could be set up.".to_string() } else { format!("Watching long commands in {}. Open a new terminal.", done.join(", ")) };
        if !blocked.is_empty() {
            message += &format!(" {} blocks profile scripts; run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` there to include it.", blocked.join(", "));
        }
        if done.is_empty() { Err(message) } else { Ok(message) }
    }
}

/// Writes the user's PATH back, keeping its registry type, and tells open apps it changed.
fn set_user_path(path: &str, kind: u32) -> Result<(), String> {
    let bytes: Vec<u8> = path.encode_utf16().chain([0]).flat_map(u16::to_le_bytes).collect();
    // REG_EXPAND_SZ (2) when it holds %VARIABLES%, which most do.
    let vtype = if kind == 1 { winreg::enums::RegType::REG_SZ } else { winreg::enums::RegType::REG_EXPAND_SZ };
    let (env, _) = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER).create_subkey("Environment").map_err(|e| e.to_string())?;
    env.set_raw_value("Path", &winreg::RegValue { bytes: bytes.into(), vtype }).map_err(|e| e.to_string())?;
    unsafe {
        SendMessageTimeoutW(HWND_BROADCAST, WM_SETTINGCHANGE, WPARAM(0), LPARAM(w!("Environment").as_ptr() as isize), SMTO_ABORTIFHUNG, 500, None);
    }
    Ok(())
}

/// `path` without `dir` in it.
fn without_dir(path: &str, dir: &Path) -> String {
    path.split(';').filter(|p| !p.trim().is_empty() && !on_path(p, dir)).collect::<Vec<_>>().join(";")
}

/// `linnotch.exe --cleanup`, run by the uninstaller: takes out everything Set up, Turn on and
/// Connect added (PATH entry, the notch copy, shell profile blocks, Claude Code hooks), and the
/// endpoint file. Each step is independent; one failing doesn't stop the rest.
pub fn cleanup() {
    let _ = set_shell_watch(false);
    let _ = connect_claude(false);
    let (path, kind) = user_path();
    if on_path(&path, &cli_dir()) {
        let _ = set_user_path(&without_dir(&path, &cli_dir()), kind);
    }
    let _ = std::fs::remove_dir_all(cli_dir());
    let _ = std::fs::remove_file(endpoint_file());
}

/// Copies `notch.exe` and `notch-hook.exe` (built next to the island) into their own folder and
/// puts that on the user's PATH. New terminals pick it up; open ones keep their old PATH.
#[tauri::command]
pub fn install_cli() -> Result<(), String> {
    copy_cli()?;
    let dir = cli_dir();
    let (path, kind) = user_path();
    if !on_path(&path, &dir) {
        let joined = if path.trim().is_empty() { dir.display().to_string() } else { format!("{};{}", path.trim_end_matches(';'), dir.display()) };
        set_user_path(&joined, kind)?;
    }
    Ok(())
}

fn copy_cli() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = cli_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    for name in CLI_FILES {
        let source = exe.with_file_name(name);
        if !source.is_file() {
            return Err(format!("{name} isn't next to linnotch.exe (build it with `cargo build --bin notch --bin notch-hook`)."));
        }
        std::fs::copy(&source, dir.join(name)).map_err(|e| format!("couldn't copy {name}: {e}"))?;
    }
    Ok(())
}

/// After an update: the copied `notch` files are the old version and Claude's hooks may still
/// run the old console notch.exe (which flashed a terminal). Refresh both, if they were set up.
fn refresh_cli() {
    if !cli_dir().join("notch.exe").is_file() {
        return;
    }
    // A `notch` command running right now keeps notch.exe locked; next start tries again.
    let _ = copy_cli();
    if dev_setup().claude {
        let _ = connect_claude(true);
    }
}

/// Adds (or removes) the island's hooks in ~/.claude/settings.json, leaving everything else as it
/// was. The file is backed up once, before the first change.
#[tauri::command]
pub fn connect_claude(on: bool) -> Result<(), String> {
    if on && !cli_dir().join("notch-hook.exe").is_file() {
        return Err("Set up the notch command first.".into());
    }
    let file = claude_settings();
    let text = std::fs::read_to_string(&file).unwrap_or_else(|_| "{}".into());
    let mut settings: serde_json::Value =
        serde_json::from_str(&text).map_err(|_| "~/.claude/settings.json isn't valid JSON, so it was left alone.".to_string())?;
    let changed = set_hooks(&mut settings, on, &hook_command()).ok_or("~/.claude/settings.json has an unexpected shape, so it was left alone.")?;
    if !changed {
        return Ok(());
    }
    let backup = file.with_extension("json.linnotch-backup");
    if file.is_file() && !backup.exists() {
        std::fs::copy(&file, &backup).map_err(|e| format!("couldn't back up settings.json: {e}"))?;
    }
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let pretty = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    std::fs::write(&file, pretty + "\n").map_err(|e| e.to_string())
}

/// Puts our hook under each event (or takes it out). None if the file's shape isn't what Claude
/// Code uses; Some(changed) otherwise.
fn set_hooks(settings: &mut serde_json::Value, on: bool, command: &str) -> Option<bool> {
    let before = settings.clone();
    let root = settings.as_object_mut()?;
    let hooks = root.entry("hooks").or_insert_with(|| serde_json::json!({})).as_object_mut()?;
    for event in HOOK_EVENTS {
        let list = hooks.entry(*event).or_insert_with(|| serde_json::json!([])).as_array_mut()?;
        list.retain(|e| !is_ours(e));
        if on {
            // The island waits 55 s for your click; give the hook a little longer than that.
            let timeout = if *event == "PermissionRequest" { 60 } else { 10 };
            list.push(serde_json::json!({ "hooks": [{ "type": "command", "command": command, "timeout": timeout }] }));
        }
        if list.is_empty() {
            hooks.remove(*event);
        }
    }
    if hooks.is_empty() {
        root.remove("hooks");
    }
    Some(*settings != before)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(token: &str, body: &str) -> String {
        format!("POST /event HTTP/1.1\r\nHost: x\r\nX-Linnotch-Token: {token}\r\nContent-Length: {}\r\n\r\n{body}", body.len())
    }

    #[test]
    fn tokens_and_folders_are_matched_exactly() {
        assert!(same_token("abc", "abc"));
        assert!(!same_token("abd", "abc"));
        assert!(!same_token("ab", "abc"));
        let tmp = std::env::temp_dir();
        assert!(crate::platform::directly_in(&tmp.join("x.txt"), &tmp));
        assert!(!crate::platform::directly_in(&tmp.join("sub").join("..").join("..").join("x.txt"), &tmp));
        let missing = tmp.join("linnotch-no-such-dir");
        assert!(!crate::platform::directly_in(&missing.join("x.txt"), &missing), "both unresolvable is not a match");
    }

    #[test]
    fn the_endpoint_takes_only_good_reports_with_the_token() {
        let body = r#"{"id":"1","kind":"task","title":"npm test","state":"failed","code":1}"#;
        let (asked, ok) = read_event(request("t", body).as_bytes(), "t").unwrap();
        assert!(!asked);
        assert_eq!((ok.title.as_str(), ok.code), ("npm test", Some(1)));
        assert_eq!(read_event(request("wrong", body).as_bytes(), "t").unwrap_err(), "401 Unauthorized");
        assert_eq!(read_event("GET / HTTP/1.1\r\n\r\n".as_bytes(), "t").unwrap_err(), "404 Not Found");
        let odd = r#"{"id":"1","kind":"task","title":"x","state":"exploded"}"#;
        assert_eq!(read_event(request("t", odd).as_bytes(), "t").unwrap_err(), "422 Unprocessable Entity");
        let long = format!(r#"{{"id":"1","kind":"agent","title":"{}","state":"waiting"}}"#, "a".repeat(500));
        assert_eq!(read_event(request("t", &long).as_bytes(), "t").unwrap().1.title.chars().count(), 121);
        let ask = |body: &str| format!("POST /ask HTTP/1.1
X-Linnotch-Token: t
Content-Length: {}

{body}", body.len());
        let question = r#"{"id":"claude-1","kind":"agent","title":"Claude","state":"waiting","detail":"Bash: npm i","ask":true}"#;
        let (asked, q) = read_event(ask(question).as_bytes(), "t").unwrap();
        assert!(asked && q.ask.is_none(), "the sender can't set ask itself");
        assert_eq!(read_event(ask(body).as_bytes(), "t").unwrap_err(), "422 Unprocessable Entity", "a task can't ask");
    }

    #[test]
    fn a_dev_server_is_named_after_its_project() {
        assert_eq!(project_of(r#""C:\Program Files\nodejs\node.exe" "C:\work\shop\node_modules\vite\bin\vite.js" --port 3000"#).as_deref(), Some("shop"));
        assert_eq!(project_of(r"python C:\work\api\main.py").as_deref(), Some("api"));
        assert_eq!(project_of(r"C:\work\blog\target\debug\blog.exe").as_deref(), None);
        assert_eq!(project_of(r#"hugo server --source "D:\sites\notes""#).as_deref(), Some("notes"));
    }

    #[test]
    fn uninstalling_takes_only_our_folder_off_the_path() {
        let ours = Path::new(r"C:\Users\me\AppData\Local\linnotch\bin");
        let path = r"%USERPROFILE%\bin;C:\Users\me\AppData\Local\linnotch\bin\;C:\tools;";
        assert_eq!(without_dir(path, ours), r"%USERPROFILE%\bin;C:\tools");
    }

    #[test]
    fn the_shell_block_is_added_once_and_removed_cleanly() {
        let profile = "oh-my-posh init pwsh | Invoke-Expression";
        let once = with_block(profile, Some(POWERSHELL));
        assert!(once.starts_with(profile) && once.ends_with("# <<< linnotch <<<\n"));
        assert_eq!(with_block(&once, Some(POWERSHELL)), once, "re-adding doesn't duplicate it");
        assert_eq!(with_block(&once, None), format!("{profile}\n"));
        assert_eq!(with_block("", Some(BASH)), BASH);
    }

    #[test]
    fn only_dev_servers_are_listed() {
        assert!(is_dev("node", Path::new(r"C:\Program Files\nodejs\node.exe")));
        assert!(is_dev("api", Path::new(r"C:\work\api\target\debug\api.exe")));
        assert!(is_dev("main", Path::new(r"C:\Users\me\AppData\Local\Temp\go-build123\b001\exe\main.exe")));
        assert!(!is_dev("steam", Path::new(r"C:\Program Files (x86)\Steam\steam.exe")));
        assert!(!is_dev("ArmourySocketServer", Path::new(r"C:\Program Files\ASUS\ArmourySocketServer.exe")));
    }

    #[test]
    fn hooks_are_added_once_and_removed_cleanly() {
        let cmd = r#""C:\Users\me\AppData\Local\linnotch\bin\notch.exe" hook"#;
        let mut s = serde_json::json!({ "model": "opus", "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "say done" }] }] } });
        assert_eq!(set_hooks(&mut s, true, cmd), Some(true));
        assert_eq!(set_hooks(&mut s, true, cmd), Some(false), "already there");
        assert_eq!(s["hooks"]["Stop"].as_array().unwrap().len(), 2, "the user's own hook stays");
        assert_eq!(s.as_object().unwrap().keys().next().unwrap(), "model", "key order kept");
        assert_eq!(set_hooks(&mut s, false, cmd), Some(true));
        assert_eq!(s, serde_json::json!({ "model": "opus", "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "say done" }] }] } }));
        assert_eq!(set_hooks(&mut serde_json::json!([1]), true, cmd), None);
    }

    #[test]
    fn old_console_hooks_are_swapped_for_the_windowless_one() {
        let old = r#""C:\Users\me\AppData\Local\linnotch\bin\notch.exe" hook"#;
        let new = r#""C:\Users\me\AppData\Local\linnotch\bin\notch-hook.exe""#;
        let mut s = serde_json::json!({});
        set_hooks(&mut s, true, old);
        assert_eq!(set_hooks(&mut s, true, new), Some(true));
        for event in HOOK_EVENTS {
            let list = s["hooks"][event].as_array().unwrap();
            assert_eq!(list.len(), 1, "{event}: the old entry is replaced, not kept next to the new one");
            assert_eq!(list[0]["hooks"][0]["command"], new);
        }
    }
}
