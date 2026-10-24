# linnotch

**A Dynamic Island for Windows.** linnotch sits at the top of your screen. It shows what's playing, your notifications, timers and more, and opens into a panel of everyday tools when you hover over it.

> **This is an alpha (0.1.0-alpha.3).** It works well day to day, but expect rough edges. Please [report anything odd](https://github.com/v25group/linnotch/issues).

Made by [V25Group](https://www.v25group.com/) (Venticinque Aeyon Groupe).

---

## What it does

**At a glance.** The resting notch shows the time, date, weather and battery. When something happens it briefly grows: a song change, a notification with the real app icon, a finished download, a screenshot, volume or brightness changes, the mic or camera in use, and timers and alarms going off.

**Hover over it** for a dock of tabs:

| Tab | What's in it |
| --- | --- |
| **Today** | Weather for your city, quick toggles (Wi-Fi, Bluetooth, Focus, dark mode, mute mic, Developer tab on/off). |
| **Now playing** | Controls for Spotify, browsers and any app using Windows media controls: cover art, seek bar, shuffle and repeat. |
| **Library** | Plays a music folder of your choice, with covers. |
| **Radio** | Over 50,000 live stations from Radio Browser, with what's on air, favourites, and India / Tamil / genre filters. |
| **Timer** | Timers of any length with labels, Pomodoro, stopwatch with laps, alarms. |
| **Clipboard** | Your last copies; click one to paste it where you were. Passwords are never kept, and API keys are hidden and forgotten after a minute. |
| **Quick note** | Plain-text notes that save as you type. Ctrl+S saves now, Ctrl+N starts a new note. The same files open in Notepad. |
| **Notifications** | History of your notifications. Hover one to reply in its app or dismiss it. |
| **Screenshots** | Recent screenshots: drag them into any app, copy, or open. |
| **Developer** | See below. Turn it off in Today if you don't need it. |
| **About** | Version, updates (install now, or automatically), and all keyboard shortcuts. |

**Drag a file onto the notch** to open it with any app. Songs can play right in linnotch, and text files open as notes. **Hold Shift while dragging** to convert audio, video or images to another format (needs FFmpeg).

### For developers

- **Watch long commands:** run `notch npm test` (or any command), or turn on automatic watching. The island shows it running, then ✓ or ✗ with the time and the last error line. Click the pop-up to jump back to that terminal.
- **Claude Code:** pop-ups when Claude needs you or finishes, and **Allow / Deny** for its permission requests right from the island.
- **Ports:** your running dev servers (and Docker containers) with open, copy URL and stop. When a command fails with "port already in use", one click frees the port.
- **GitHub:** your pull requests and their checks, reviews waiting for you, assigned issues and workflow runs, with pop-ups when checks finish. Uses the GitHub CLI's own login.
- **Smart clipboard:** recognises JSON, JWTs, Base64, timestamps, UUIDs and colours, and converts them in one click.
- **Tools:** a fresh UUID, timestamp or password, one click to copy.

## Keyboard shortcuts

Hold **Ctrl + Alt**, then:

| Key | Action | Key | Action |
| --- | --- | --- | --- |
| Space | Play / pause | T | Timer |
| N | Next song | V | Clipboard |
| B | Previous song | S | Screenshots |
| I | Open / close the island | D | Developer |
| L | Music library | R | Radio |

If another app already uses one of these, linnotch skips that one and the rest still work.

## Install

1. Download **`linnotch-0.1.0-alpha.3-setup.exe`** from [Releases](https://github.com/v25group/linnotch/releases).
2. Run it. It installs for your user only, with no admin rights needed.
3. **Windows SmartScreen** may say "Windows protected your PC", because this alpha isn't code-signed yet. Click **More info → Run anyway**.

The installer can start linnotch when you sign in, and installs Microsoft Edge WebView2 if your PC doesn't have it (Windows 11 already does).

**Requirements:** Windows 10 (1809 or newer) or Windows 11, 64-bit.

**Optional extras:**

- **FFmpeg**, for converting files: `winget install Gyan.FFmpeg`
- **GitHub CLI**, for the GitHub pane: `winget install GitHub.cli`, then `gh auth login`

**Quit or change settings:** right-click (or click) the linnotch icon in the system tray, where you'll find Start with Windows, Report an issue, and Quit.

**Uninstall:** Settings → Apps → linnotch → Uninstall. This also removes everything the Developer tab set up: the `notch` command, the shell integration and the Claude Code hooks. Your notes in `Documents\linnotch\Notes` are kept.

## Privacy

linnotch runs on your PC and has no account, analytics or tracking. It only goes online for:

- **Weather:** your approximate city from your internet address (geojs.io, ipwho.is), and the forecast from Open-Meteo.
- **Radio:** the station list and streams, from Radio Browser and the stations themselves.
- **GitHub:** only if you use the GitHub pane, through your own GitHub CLI.

Notifications, clipboard history, screenshots, notes and media info never leave your PC. Clipboard history lives only in memory.

## Feedback

This project is **open source but not open to contributions**: pull requests are closed automatically. Your feedback is very welcome:

- **Found a bug?** [Open a bug report](https://github.com/v25group/linnotch/issues/new?template=bug_report.yml).
- **Have an idea?** [Suggest a feature](https://github.com/v25group/linnotch/issues/new?template=feature_request.yml).
- **Security problem?** See [SECURITY.md](SECURITY.md). Please don't post it publicly.

See [CONTRIBUTING.md](CONTRIBUTING.md) for why.

## Build from source

You need [Node.js](https://nodejs.org/) 20+, [Rust](https://rustup.rs/) (stable, MSVC) and, for the installer, [Inno Setup 6](https://jrsoftware.org/isinfo.php).

```powershell
npm install
npm run tauri dev                 # run it while developing
.\installer\build.ps1             # release build + installer -> installer\Output\
npm test                          # TypeScript, the self-checks and the Rust tests
```

**How the code is organised:** `src/` is the island's interface (React), split into `island/` (the notch and its pop-ups) and `features/` (one folder per tab). `src-tauri/` is the Rust side that talks to Windows. The full map, and the rules about Windows and WebView2 that shouldn't be undone, are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Credits

Built with [Tauri](https://tauri.app/), [React](https://react.dev/), [Motion](https://motion.dev/), [Tailwind CSS](https://tailwindcss.com/) and [Hugeicons](https://hugeicons.com/) (free set). Weather data by [Open-Meteo.com](https://open-meteo.com/) (CC BY 4.0). Radio stations from [Radio Browser](https://www.radio-browser.info/). File conversion by [FFmpeg](https://ffmpeg.org/) (installed separately).

## License

[MIT](LICENSE) © 2026 Venticinque Aeyon Groupe (V25Group)
