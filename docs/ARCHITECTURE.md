# How linnotch is built

linnotch is a [Tauri 2](https://tauri.app/) app: a **React** page (the island you see) running in a transparent **WebView2** window, plus a **Rust** side that talks to Windows. The page asks Rust for things with `invoke("command")`; Rust tells the page about changes with events (`listen("event")`).

## Folders

```
linnotch/
├── src/                      The island's UI (React + TypeScript + Tailwind)
│   ├── main.tsx              Entry point
│   ├── App.tsx               The island itself: views, dock, drag and drop, file conversion
│   ├── index.css             Tailwind and the few keyframe animations
│   ├── assets/               The linnotch icon used inside the UI
│   ├── components/           Shared pieces: icons (Hugeicons), tooltips
│   ├── lib/                  Small helpers: storage (localStorage that never throws)
│   ├── island/               The resting notch and its pop-ups (battery, volume, notifications…)
│   └── features/             One folder per tab or feature
│       ├── music/            Now playing, local library + player, radio
│       ├── today/            Weather, quick toggles
│       ├── timer/            Timer, Pomodoro, stopwatch, alarms (+ the text parsers)
│       ├── clipboard/        Clipboard history (+ the smart JSON/JWT/… detector)
│       ├── notes/            Notes
│       ├── notifications/    Notification history
│       ├── screenshots/      Screenshot shelf
│       ├── downloads/        "Download finished" pop-up
│       ├── files/            Drag a file in: Open with / Convert
│       ├── developer/        Developer tab: tasks, Claude Code, ports, GitHub, tools
│       └── shortcuts/        Keyboard shortcuts + about line
├── src-tauri/                The Rust side
│   ├── src/lib.rs            Startup, the window watch loop, global shortcuts, tray, commands list
│   ├── src/platform.rs       Every Win32 window trick (click-through, always on top, foreground…)
│   ├── src/system.rs         Battery, volume, brightness, mic/camera use, Bluetooth, notifications
│   ├── src/media.rs          Now playing (Windows media controls)
│   ├── src/library.rs        Music folder scan, tags, cover art
│   ├── src/radio.rs          Song-on-air titles from radio streams
│   ├── src/convert.rs        File conversion through FFmpeg
│   ├── src/openwith.rs       Apps that can open a file, and launching them
│   ├── src/clipboard.rs      Clipboard history and the secret guard
│   ├── src/screenshots.rs    New screenshots
│   ├── src/downloads.rs      Finished downloads
│   ├── src/toggles.rs        Wi-Fi, Bluetooth, dark mode, mic mute
│   ├── src/notes.rs          Notes files
│   ├── src/dev.rs            Developer tab: local endpoint, ports, Docker, GitHub, setup and cleanup
│   ├── src/bin/notch.rs      The `notch` command (a separate small console program)
│   ├── capabilities/         What the page may call (Tauri permissions)
│   └── tauri.conf.json       Window, bundle and app settings
├── scripts/                  Self-checks for the pure TypeScript parts (`npm test`)
├── installer/                Inno Setup script and build.ps1 → installer/Output/
└── .github/                  Issue forms, and the workflow that closes pull requests
```

Each front-end feature folder usually has a `useSomething()` hook (state, events from Rust) and a `SomethingView` (the tab). Files are named after what they show, and the Rust file with the same name is its other half (`features/notes/notes.tsx` ↔ `src-tauri/src/notes.rs`).

## Checks

```powershell
npm test                              # TypeScript, the parser self-checks and the Rust tests
```

## Rules learned the hard way (don't undo these)

1. **The window must be created visible** (`tauri.conf.json`). If it's created hidden and shown later, WebView2 registers its own drop target over Tauri's, and every file drop is silently rejected.
2. **Don't set `focusable: false`.** WebView2 then ignores clicks.
3. **Never use `outer_position()` for hit-testing.** It jumps by the hidden frame size whenever click-through toggles; use the position set at startup.
4. **Change window styles only in `platform.rs`,** never through Tauri setters at runtime. Tauri rewrites every style from its own flags whenever one changes (which is also why `set_ignore_cursor_events` isn't used).
5. **The hit area is the size the UI reports through `set_pill`.** Rust doesn't know the layout, so React measures it and tells Rust. "Pinned" only keeps the island open; click-through still follows the cursor, so the transparent part of the window never blocks clicks underneath.
6. **Conversion outputs are reserved with `create_new`** before FFmpeg runs. A failed run deletes only the file it reserved, and inputs are never written or deleted.
7. **The cursor is polled at about 30 Hz,** because a click-through window gets no mouse events.
8. **`ELECTRON_RUN_AS_NODE` and `VSCODE_*` are removed from the environment at startup.** When it's started from VS Code, the island would otherwise pass them on, and every Electron app it opens (VS Code, Cursor…) starts as plain Node and exits at once.
9. **Always-on-top is re-asserted** on every foreground change and once a second (not during fullscreen apps). `alwaysOnTop` alone lets newly opened apps end up above the island.
10. **Only one linnotch runs at a time** (the named mutex `Local\linnotch.island`). A dev build and an installed copy can't run together; quit one from the tray first.
