# Changelog

## 0.1.0-beta.1

linnotch moves from alpha to beta: everyday use is solid, and the island grows into a small home for your day.

- **Focus sessions (Timer → Focus):** pick a length and the apps you're working in. Any other app that comes to the front is minimised, with a "Stay focused" nudge, and Do Not Disturb is on until the time is up. Add any app with **+ Add app** (Start menu shortcuts work); your apps are remembered.
- **Bookshelf:** pin apps, folders and files and open them in one click. **Ctrl + drag** anything onto the island to pin it. Photos, videos and songs show their own preview (album art for songs); hover a pin for **Show in folder** or to unpin. Hidden at first: turn it on in Settings → Tabs.
- **Settings tab** (replaces About), with three panes: **About** (version, updates, **Start with Windows**, Look), **Shortcuts**, and **Tabs**: choose which tabs the dock shows (at least 4), or open a hidden one. The dock never gets wider than the island; extra tabs scroll.
- **Look: Kit or Eyes.** Kit the fox stays linnotch's face; the new **Eyes** look shows just Kit's glowing eyes, which follow your mouse, blink, squint at clicks, wink when you copy, look down while you type, get dizzy when you shake the mouse, and doze off when you're away. The choice applies everywhere Kit appears.
- **Developer tab is off on new installs** (no background GitHub checks for people who don't need them). Existing installs keep it.
- **Alarms and timers:** the chime is now loud and clear (it could be silent before), music pauses while it rings and plays again after, and "9:34" means the next 9:34, morning or evening, instead of always the morning.
- **Fixed:** a terminal window flashed every minute or two while the Developer tab was on (GitHub CLI's telemetry). linnotch now turns that telemetry off for its own checks.
- Pop-ups for timers, alarms, calendar events, mic/camera use and "Opened in…" are centred like the rest. Tooltips stay inside the island instead of running off the edge.

## 0.1.0-alpha.4

- **Meet Kit:** a little fox now lives in the resting notch. The notch shrinks to just Kit plus what matters right now (music bars, a running timer, mic/camera in use, low battery). Kit looks around, wanders, wags and yawns while idle, wears headphones when music plays, sleeps at night and looks worried when the battery is low. Kit also turns up in empty pages and in "Update completed".
- **Developer:** Claude Code pop-ups and cards are centred and use the Claude logo; a running agent shows a "thinking" animation in Tasks.
- **Fixed:** a terminal window flashed for a split second on every Claude Code hook. Hooks now run through a windowless `notch-hook.exe`, and existing hooks move over by themselves.
- **Fixed:** Ctrl+C didn't stop commands started with `notch` (for example `notch npm run dev`).
- **Shortcut:** Radio moved to Ctrl+Alt+F, because Ctrl+Alt+R was often taken by other apps.

## 0.1.0-alpha.3

- **Fixed:** the island still hid on the bare desktop, with the taskbar focused, and for a while after windows came back. Windows' own "fullscreen app" signal reports those as busy, so linnotch now checks for itself: it hides only for a window that really fills the screen (fullscreen video, F11 browser, games) or a presentation.
- Fullscreen on a second monitor no longer hides the island.
- First version delivered by the updater: on alpha.2 it arrives by itself.

## 0.1.0-alpha.2

- **Updates:** linnotch now updates itself. The new About tab checks GitHub for new versions and installs them, by itself by default, only while the island is closed and its player is quiet. You'll see "Update completed" when it's done. Every update is signed and checked before it runs. (Coming from alpha.1, install this version by hand once.)
- **About tab** replaces Shortcuts: version, updates and links, with the shortcuts in their own pane.
- **Fixed:** the island disappeared on the bare desktop (Windows reports the desktop as a fullscreen app).
- **Radio:** no more "Connecting…" stuck on while a station plays. A dropped or frozen station reconnects by itself, and picks up again when your internet comes back.
- **Today:** the quick toggles show exactly five at a time and scroll for the rest; the hover zoom is no longer clipped.
- **Downloads:** a new centred look for the "Download finished" pop-up and card.
- **Security:** a strict Content Security Policy, the music library only exposes the songs it found, and tighter checks on files and the local Developer endpoint.

## 0.1.0-alpha.1 (first alpha)

The first public test version.

- **The island:** the resting notch shows time, date, weather and battery. Pop-ups cover songs, notifications (with the real app icon), downloads, screenshots, volume, brightness, Bluetooth, mic/camera use, timers and alarms.
- **Music:** Now playing for any Windows media app, a local music library with covers, and live radio with what's on air.
- **Everyday tools:** Today (weather, quick toggles), Timer (timers with labels, Pomodoro, stopwatch with laps, alarms), Clipboard history, Quick notes (Ctrl+S, Ctrl+N, opens in Notepad), Notifications history, Screenshots shelf.
- **Drag and drop:** open a file with any app, play songs in linnotch, open text files as notes, Shift+drag to convert media (needs FFmpeg).
- **Developer tab:** watch long commands (`notch`), Claude Code alerts with Allow / Deny, dev servers and Docker containers, a "port already in use" fix, GitHub pull requests, checks, reviews and workflow runs, a smart clipboard, and quick generators.
- **System tray:** start with Windows, report an issue, quit.
- Installer for Windows 10/11 (per user, no admin needed).
