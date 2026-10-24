# Changelog

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
