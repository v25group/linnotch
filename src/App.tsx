import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { AnimatePresence, motion } from "motion/react";
import { Icon, type IconName } from "./components/icons";
import { TooltipLayer, useTip } from "./components/tooltip";
import { Bars, NowPlayingLabel, PlayerCard, TrackFlash, useMedia } from "./features/music/media";
import { LibraryView, useLibrary, useLocalPlayer, type Track } from "./features/music/library";
import { ShortcutsView } from "./features/shortcuts/shortcuts";
import { RadioView, useRadio } from "./features/music/radio";
import { CONVERT, ConvertView, ISLAND_NOTES, ISLAND_PLAYER, OpenWithView, appAt, looksLikeFile, useOpenWith, withIslandPlayer } from "./features/files/openwith";
import { COLOR, Collapsed, FlashView, NoteCard, chime, flashColor, useSystem, type Flash } from "./island/system";
import { TimerView, useTools, type Ding } from "./features/timer/timer";
import { ClipboardView, useClipboard } from "./features/clipboard/clipboard";
import { DownloadCard, DownloadFlash, useDownloads, type Download } from "./features/downloads/downloads";
import { TodayView, useDnd } from "./features/today/toggles";
import { WeatherChips, useWeather } from "./features/today/weather";
import { NotificationsView } from "./features/notifications/notifications";
import { DevCard, DevChip, DevFlashView, DevView, useDev, useDevEnabled, useGitHub, useMeters } from "./features/developer/dev";
import { NotesView } from "./features/notes/notes";
import { ShelfView, ShotCard, ShotFlash, draggingOut, useShelf, type Shot } from "./features/screenshots/shelf";

// Rust (src-tauri/src/convert.rs) owns the format list; these mirror what `inspect` returns.
type Kind = "audio" | "video" | "image";
type Preset = { id: string; label: string; note: string; group: string };
type FileInfo = { kind: Kind | null; size: number; duration: number | null; presets: Preset[] };

type Stage =
  | { kind: "idle" }
  | { kind: "ready"; path: string; info: FileInfo }
  | { kind: "converting"; path: string; info: FileInfo; preset: Preset; progress: number | null }
  | { kind: "done"; path: string; info: FileInfo; out: string; size: number }
  | { kind: "error"; message: string; path?: string; info?: FileInfo };

const COLLAPSED = { width: 406, height: 34 };
const TRAY_GAP = 8;
const TRAY_WIDTH = 488; // notch width + the row's 4px side padding
// Panel widths per view; heights come from measuring the content.
// Never narrower than the resting notch, so opening it only ever grows it.
const PLAYER_WIDTH = 440;
const WIDTH = { held: PLAYER_WIDTH, openwith: PLAYER_WIDTH, convert: PLAYER_WIDTH, hint: PLAYER_WIDTH, flash: COLLAPSED.width, ready: 480, converting: COLLAPSED.width, done: 420, error: 420 };

const ACCENT: Record<Kind | "none", string> = { audio: "#ff6b9a", video: "#5ab8ff", image: "#4fd18b", none: "#a1a1aa" };
const ICON: Record<Kind | "none", IconName> = { audio: "audio", video: "video", image: "image", none: "file" };

const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;
const extOf = (path: string) => (fileName(path).includes(".") ? fileName(path).split(".").pop()!.toUpperCase() : "FILE");

function formatSize(bytes: number) {
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) (bytes /= 1024), i++;
  return `${bytes.toFixed(i === 0 || bytes >= 100 ? 0 : 1)} ${units[i]}`;
}

function formatDuration(seconds: number) {
  const s = Math.round(seconds);
  const [h, m, sec] = [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60];
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/** Height of the element the returned ref is attached to, kept up to date. */
function useHeight(): [(el: HTMLElement | null) => void, number] {
  const [height, setHeight] = useState(0);
  const ref = useCallback((el: HTMLElement | null) => {
    if (!el) return;
    // An element leaving the DOM reports 0; ignore it so the outgoing view can't shrink the pill.
    const update = () => el.offsetHeight > 0 && setHeight(el.offsetHeight);
    const observer = new ResizeObserver(update);
    observer.observe(el);
    update();
    return () => observer.disconnect();
  }, []);
  return [ref, height];
}

/** What `inspect` says about the file being dragged (its formats), cached per path for the session. */
function useInspect(path: string | null) {
  const [info, setInfo] = useState<{ path: string; info: FileInfo } | null>(null);
  const cache = useRef(new Map<string, FileInfo>());
  useEffect(() => {
    if (!path) return;
    const cached = cache.current.get(path);
    if (cached) return setInfo({ path, info: cached });
    let live = true;
    invoke<FileInfo>("inspect", { path })
      .then((found) => {
        cache.current.set(path, found);
        if (live) setInfo({ path, info: found });
      })
      // Unreadable file: no formats, rather than "finding" forever.
      .catch(() => live && setInfo({ path, info: { kind: null, size: 0, duration: null, presets: [] } }));
    return () => {
      live = false;
    };
  }, [path]);
  // A result for an earlier file never shows for this one.
  return info && info.path === path ? info.info : null;
}

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return {
    time: now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).toUpperCase(), // "11:32 PM"
    date: now.toLocaleDateString([], { weekday: "long", day: "numeric" }).toUpperCase(), // "SATURDAY 24"
  };
}

function Tile({ icon, color }: { icon: IconName; color: string }) {
  return (
    <div className="grid size-10 shrink-0 place-items-center" style={{ color }}>
      <Icon name={icon} size={26} />
    </div>
  );
}

function Button({ onClick, children, accent }: { onClick: () => void; children: React.ReactNode; accent?: string }) {
  return (
    <button
      onClick={onClick}
      className="rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-[filter,background-color] hover:brightness-110 active:scale-[0.97]"
      style={accent ? { background: accent, color: "#000" } : { background: "rgb(255 255 255 / 0.1)" }}
    >
      {children}
    </button>
  );
}

type HoverTab = "today" | "music" | "library" | "radio" | "timer" | "clipboard" | "notifications" | "shelf" | "notes" | "dev" | "keys";

const DOCK: { id: HoverTab; icon: IconName; label: string }[] = [
  { id: "today", icon: "controls", label: "Today" },
  { id: "music", icon: "audio", label: "Now playing" },
  { id: "library", icon: "library", label: "Library" },
  { id: "radio", icon: "radio", label: "Radio" },
  { id: "timer", icon: "timer", label: "Timer" },
  { id: "clipboard", icon: "clipboard", label: "Clipboard" },
  { id: "notes", icon: "note", label: "Quick note" },
  { id: "notifications", icon: "bell", label: "Notifications" },
  { id: "shelf", icon: "shelf", label: "Screenshots" },
  { id: "dev", icon: "code", label: "Developer" },
  { id: "keys", icon: "keyboard", label: "Shortcuts" },
];

function DockButton({ item, index, active, busy, badge, onClick }: {
  item: (typeof DOCK)[number]; index: number; active: boolean; busy: boolean; badge: number; onClick: () => void;
}) {
  return (
    <motion.button onClick={onClick} aria-label={item.label} {...useTip(item.label)}
      className={`relative grid size-9 place-items-center rounded-[14px] transition-colors ${active ? "text-white" : "text-white/50 hover:text-white/85"}`}
      style={busy && !active ? { color: COLOR.tool } : undefined}
      initial={{ opacity: 0, y: -6, scale: 0.8 }} animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: "spring", stiffness: 500, damping: 30, delay: 0.03 + index * 0.03 }}
      whileTap={{ scale: 0.9 }}>
      {active && <motion.span layoutId="dock" className="absolute inset-0 rounded-[14px] bg-white/14" transition={{ type: "spring", stiffness: 500, damping: 36 }} />}
      <span className="relative grid"><Icon name={item.icon} size={18} /></span>
      <AnimatePresence>
        {badge > 0 && (
          <motion.span key="badge" initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }}
            className="absolute -top-0.5 -right-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-[#ff453a] px-1 text-[9.5px] font-bold text-white tabular-nums">
            {badge > 9 ? "9+" : badge}
          </motion.span>
        )}
      </AnimatePresence>
    </motion.button>
  );
}

/** The floating bar under the open notch that switches what it shows. */
function Dock({ tab, onChange, timerRunning, unread, waiting, devOn }: {
  tab: HoverTab; onChange: (t: HoverTab) => void; timerRunning: boolean; unread: number; waiting: number; devOn: boolean;
}) {
  return (
    <div className="flex items-center gap-1 rounded-[20px] bg-black p-1.5" style={{ boxShadow: "inset 0 0 0 1px rgb(255 255 255 / 0.08)" }}>
      {DOCK.filter((item) => devOn || item.id !== "dev").map((item, i) => (
        <DockButton key={item.id} item={item} index={i} active={tab === item.id} busy={item.id === "timer" && timerRunning}
          badge={item.id === "notifications" ? unread : item.id === "dev" ? waiting : 0} onClick={() => onChange(item.id)} />
      ))}
    </div>
  );
}

function CloseButton({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} aria-label="Close" {...useTip("Close")}
      className="grid size-7 place-items-center rounded-full text-white/60 hover:bg-white/10 hover:text-white">
      <Icon name="close" size={14} />
    </button>
  );
}

function FileHeader({ path, info, onClose }: { path: string; info: FileInfo; onClose?: () => void }) {
  const kind = info.kind ?? "none";
  const meta = [extOf(path), formatSize(info.size), info.duration ? formatDuration(info.duration) : null].filter(Boolean);
  return (
    <div className="flex items-center gap-3">
      <Tile icon={ICON[kind]} color={ACCENT[kind]} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px] font-medium">{fileName(path)}</div>
        <div className="text-[12px] text-white/50">{meta.join(" · ")}</div>
      </div>
      {onClose && <CloseButton onClick={onClose} />}
    </div>
  );
}

/** A row that scrolls sideways (mouse wheel too) when its items don't fit, fading out the cut-off edge. */
function ScrollRow({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState({ left: false, right: false });
  const update = () => {
    const el = ref.current;
    if (el) setFade({ left: el.scrollLeft > 1, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1 });
  };
  useEffect(update, []);
  // Fade to a faint ghost (not fully transparent) so a cut-off box shows there's more to scroll.
  const ghost = "rgb(0 0 0 / 0.25)";
  const mask = `linear-gradient(to right, ${fade.left ? `${ghost}, #000 56px` : "#000"}, ${fade.right ? `#000 calc(100% - 56px), ${ghost}` : "#000"})`;
  return (
    <div
      ref={ref}
      onScroll={update}
      onWheel={(e) => ref.current && (ref.current.scrollLeft += e.deltaY + e.deltaX)}
      // Padding gives the hover lift room inside the scroll area, which clips its overflow.
      className="no-scrollbar flex gap-2 overflow-x-auto px-1 py-1"
      style={{ maskImage: mask }}
    >
      {children}
    </div>
  );
}

/** One row of separate format boxes under the notch; scrolls sideways when they don't fit. */
function FormatRow({ info, onPick }: { info: FileInfo; onPick: (p: Preset) => void }) {
  const accent = ACCENT[info.kind ?? "none"];
  return (
    <ScrollRow>
      {info.presets.map((p, i) => (
        <FormatBox key={p.group + p.id} preset={p} index={i} accent={accent} onPick={onPick} />
      ))}
    </ScrollRow>
  );
}

function FormatBox({ preset: p, index: i, accent, onPick }: { preset: Preset; index: number; accent: string; onPick: (p: Preset) => void }) {
  return (
    // flex-1 fills the width when there are few formats; min-w makes the row scroll when there are many.
    <motion.button
      onClick={() => onPick(p)}
      {...useTip(p.note)}
      className="h-11 min-w-18 flex-1 shrink-0 rounded-2xl bg-black px-3 text-[13px] font-semibold text-white transition-colors hover:text-(--accent)"
      style={{ "--accent": accent, boxShadow: "inset 0 0 0 1px rgb(255 255 255 / 0.1)" } as React.CSSProperties}
      initial={{ opacity: 0, y: -10, scale: 0.9 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: "spring", stiffness: 420, damping: 28, delay: 0.04 + i * 0.03 }}
      whileHover={{ y: -2 }}
      whileTap={{ scale: 0.95 }}
    >
      {p.label}
    </motion.button>
  );
}

const EAR = 10;

/** The concave curve joining the notch to the screen's top edge, outside one top corner. */
function Ear({ side }: { side: "left" | "right" }) {
  const at = side === "left" ? "0 100%" : "100% 100%";
  return (
    <div
      className="pointer-events-none absolute top-0"
      style={{
        [side]: -EAR,
        width: EAR,
        height: EAR,
        background: `radial-gradient(circle at ${at}, transparent ${EAR - 0.5}px, #000 ${EAR}px)`,
      }}
    />
  );
}

function ProgressBar({ progress, color }: { progress: number | null; color: string }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
      {progress === null ? (
        <motion.div className="h-full w-1/3 rounded-full" style={{ background: color }}
          animate={{ x: ["-100%", "300%"] }} transition={{ repeat: Infinity, duration: 1.2, ease: "easeInOut" }} />
      ) : (
        <motion.div className="h-full rounded-full" style={{ background: color, boxShadow: `0 0 12px ${color}` }}
          animate={{ width: `${Math.max(progress * 100, 2)}%` }} transition={{ ease: "easeOut" }} />
      )}
    </div>
  );
}

export default function App() {
  const [hovered, setHovered] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [dragPaths, setDragPaths] = useState<string[]>([]);
  const [dragPoint, setDragPoint] = useState<{ x: number; y: number } | null>(null);
  const [shift, setShift] = useState(false);
  const dragInfo = useInspect(dragging && shift && dragPaths.length === 1 ? dragPaths[0] : null);
  const foundApps = useOpenWith(dragPaths[0] ?? null);
  const openWithApps = useMemo(() => withIslandPlayer(foundApps, dragPaths), [foundApps, dragPaths]);
  // Drag positions arrive in physical pixels; the page works in CSS pixels.
  const dragAt = dragging && dragPoint ? { x: dragPoint.x / devicePixelRatio, y: dragPoint.y / devicePixelRatio } : null;
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const { battery, privacy, event, flash: rawFlash, show, notes, unread, removeNote, clearNotes, markRead } = useSystem();
  // Do Not Disturb hides notification pop-ups; they still collect in the Notifications tab.
  const { dnd, toggle: toggleDnd } = useDnd();
  const flash = dnd && rawFlash?.kind === "notification" ? null : rawFlash;
  const weather = useWeather();
  useDownloads(useCallback((d: Download) => show({ kind: "download", ...d }), [show]));
  const clips = useClipboard();
  const devTab = useDevEnabled();
  const dev = useDev(show, devTab.on);
  const github = useGitHub(show, devTab.on);
  const shots = useShelf(useCallback((shot: Shot) => show({ kind: "screenshot", ...shot }), [show]));
  const onTimerDone = useCallback((d: Ding) => {
    show({ kind: "timer", ...d });
    chime();
  }, [show]);
  const tools = useTools(onTimerDone);
  const onTrackChange = useCallback(() => show({ kind: "track" }), [show]);
  const system = useMedia(onTrackChange);
  // Starting the island's own player pauses whatever else is playing, like any music app would.
  const systemRef = useRef(system);
  systemRef.current = system;
  const pauseSystem = useCallback(() => {
    if (systemRef.current.media?.playing) systemRef.current.control("toggle");
  }, []);
  const local = useLocalPlayer(onTrackChange, pauseSystem);
  const library = useLibrary();
  const radio = useRadio();
  // The island's own player wins while it plays, or when nothing else is playing.
  const player = local.media && (local.media.playing || !system.media?.playing) ? local : system;
  const playing = player.media?.playing ? player.media : null;

  // Hover opens on the player when there's music, otherwise on the timer.
  const defaultTab: HoverTab = player.media ? "music" : "today";
  const [tab, setTab] = useState<HoverTab>(defaultTab);
  // A shortcut can open the island without the cursor. It closes once the cursor has visited
  // and left, or after a few seconds if the cursor never comes.
  const [forced, setForced] = useState(false);
  // A text file dropped on the notes tile, for the Notes tab to open.
  const [noteToOpen, setNoteToOpen] = useState<{ path: string; nonce: number } | null>(null);
  const [over, setOver] = useState(false);
  // Hovering a notification or screenshot pop-up holds it open as a card with its actions.
  const [held, setHeld] = useState<Flash | null>(null);
  // Only the cursor itself does this: a shortcut opening the island goes to its tab instead.
  useEffect(() => {
    if (!over) setHeld(null);
    else if (flash?.kind === "notification" || flash?.kind === "screenshot" || flash?.kind === "download" || flash?.kind === "dev") setHeld(flash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [over]);
  const visited = useRef(false);
  // Pick the tab when the island opens, from what's playing right then (a song -> Now playing).
  // Deciding on close went stale when the player briefly reported nothing between songs.
  // A shortcut picks its own tab, so it's left alone.
  useEffect(() => {
    if (hovered && !forced) setTab(defaultTab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hovered]);
  useEffect(() => {
    if (tab === "notifications" && hovered) markRead();
  }, [tab, hovered, unread, markRead]);
  useEffect(() => {
    if (!forced) return void (visited.current = false);
    if (over) return void (visited.current = true);
    if (visited.current) return setForced(false);
    const id = setTimeout(() => setForced(false), 6000);
    return () => clearTimeout(id);
  }, [forced, over]);

  const onShortcut = useRef((_: string) => {});
  onShortcut.current = (action) => {
    // The same shortcut again closes what it opened.
    const open = (t: HoverTab) => {
      if (forced && tab === t) return setForced(false);
      setTab(t);
      setForced(true);
    };
    if (action === "toggle" || action === "next" || action === "previous") {
      if (player.media) player.control(action);
    } else if (action === "open") {
      if (forced) setForced(false);
      else open(defaultTab);
    } else if (action === "library") open("library");
    else if (action === "timer") open("timer");
    else if (action === "radio") open("radio");
    else if (action === "clipboard") open("clipboard");
    else if (action === "shelf") open("shelf");
    else if (action === "dev" && devTab.on) open("dev");
  };
  // CPU/RAM only while you're looking at them or something heavy is running.
  // Turning the Developer tab off while it's open goes back to Today.
  useEffect(() => {
    if (!devTab.on && tab === "dev") setTab("today");
  }, [devTab.on, tab]);
  const meters = useMeters((hovered && tab === "dev") || dev.running.length > 0);
  const [contentRef, contentHeight] = useHeight();
  const [trayRef, trayHeight] = useHeight();
  const clock = useClock();

  useEffect(() => {
    const unlisten = [
      listen<boolean>("hover", (e) => setHovered(e.payload)),
      listen<boolean>("over", (e) => setOver(e.payload)),
      listen<string>("shortcut", (e) => onShortcut.current(e.payload)),
      listen<boolean>("hidden", (e) => setHidden(e.payload)),
      listen<number>("progress", (e) => setStage((s) => (s.kind === "converting" ? { ...s, progress: e.payload } : s))),
      listen<boolean>("shift", (e) => setShift(e.payload)),
      getCurrentWebview().onDragDropEvent(({ payload }) => {
        // A screenshot being dragged out of the shelf passes over the island first; that's not a drop for us.
        if (draggingOut.current) return;
        setDragging(payload.type === "enter" || payload.type === "over");
        if (payload.type === "enter") setDragPaths(payload.paths);
        if (payload.type === "enter" || payload.type === "over") setDragPoint(payload.position);
        if (payload.type === "drop") onDrop.current(payload.paths, payload.position);
      }),
    ];
    return () => unlisten.forEach((p) => p.then((off) => off()));
  }, []);

  async function start(path: string, info: FileInfo, preset: Preset) {
    setStage({ kind: "converting", path, info, preset, progress: null });
    try {
      const { out, size } = await invoke<{ out: string; size: number }>("convert_file", { path, preset: preset.id });
      setStage({ kind: "done", path, info, out, size });
    } catch (e) {
      setStage({ kind: "error", message: String(e), path, info });
    }
  }

  // A drop opens the item in the app tile under the cursor; with Shift, converts it to the format tile's format.
  const onDrop = useRef((_paths: string[], _at: { x: number; y: number }) => {});
  onDrop.current = (paths, at) => {
    const path = paths[0];
    if (!path) return;
    const id = appAt(at.x / devicePixelRatio, at.y / devicePixelRatio);
    if (shift) {
      const preset = id?.startsWith(CONVERT) && dragInfo?.presets.find((p) => CONVERT + p.id === id);
      if (preset && dragInfo && stage.kind !== "converting") start(path, dragInfo, preset);
      return;
    }
    const app = openWithApps?.find((a) => a.id === id);
    if (!app) return;
    if (app.id === ISLAND_NOTES) {
      setNoteToOpen({ path, nonce: Date.now() });
      setTab("notes");
      setForced(true);
      return;
    }
    if (app.id === ISLAND_PLAYER) {
      invoke<Track[]>("read_tracks", { paths })
        .then((tracks) => tracks.length && local.playList(tracks, 0))
        .catch((e) => show({ kind: "opened", app: app.name, error: String(e) }));
      return;
    }
    invoke("open_with", { path, id: app.id })
      .then(() => show({ kind: "opened", app: app.name }))
      .catch((e) => show({ kind: "opened", app: app.name, error: String(e) }));
  };

  const close = () => setStage({ kind: "idle" });
  // A running conversion doesn't hold the island open: it shrinks to a progress ring in the notch.
  const converting = stage.kind === "converting" ? stage : null;
  const stagePinned = stage.kind !== "idle" && !converting;
  const showHeld = !!held && stage.kind === "idle" && !dragging;
  const pinned = stagePinned || forced;
  const resting = (stage.kind === "idle" || converting) && !hovered && !dragging;
  const openWith = dragging && !shift;
  const view = resting ? (flash ? "flash" : "collapsed") : openWith ? "openwith" : dragging ? "convert" : showHeld ? "held" : stage.kind === "idle" ? "hint" : stage.kind;
  const size =
    view === "collapsed"
      ? COLLAPSED
      : { width: WIDTH[view], height: contentHeight || COLLAPSED.height };
  const kind = "info" in stage && stage.info?.kind ? stage.info.kind : "none";
  const accent =
    view === "flash" && flash ? (flash.kind === "track" ? player.color : flashColor(flash)) : view === "hint" && player.media ? player.color : ACCENT[kind];
  // The format list opens as a separate card under the notch.
  const tray = stage.kind === "ready" && stage.info.presets.length > 0 ? stage : null;
  // The open hover view gets the floating dock underneath instead.
  const dock = view === "hint" && !dragging;
  const hitHeight = size.height + ((tray || dock) && trayHeight ? TRAY_GAP + trayHeight : 0);
  const hitWidth = tray ? Math.max(size.width, TRAY_WIDTH) : size.width;
  // While the cursor is on the open island, the area that catches it never shrinks: switching to
  // a shorter tab would otherwise pull the dock out from under the cursor and close the island.
  const peak = useRef({ width: 0, height: 0 });
  peak.current = hovered && !stagePinned
    ? { width: Math.max(peak.current.width, hitWidth), height: Math.max(peak.current.height, hitHeight) }
    : { width: hitWidth, height: hitHeight };
  const { width: reportWidth, height: reportHeight } = peak.current;

  // Rust hit-tests the cursor against this box (notch + tray/dock), and keeps the island open while pinned.
  useEffect(() => {
    invoke("set_pill", { width: reportWidth, height: reportHeight, pinned });
  }, [reportWidth, reportHeight, pinned]);

  const radius = view === "collapsed" ? 14 : view === "flash" && flash?.kind !== "volume" && flash?.kind !== "brightness" ? 22 : 26;
  const spring = { type: "spring", stiffness: 380, damping: 32 } as const;
  const conversion = converting ? { progress: converting.progress, color: accent } : null;

  return (
    <TooltipLayer active={over}>
    <div className="flex flex-col items-center" style={{ gap: TRAY_GAP }}>
      {/* The notch hangs from the top edge of the screen: square top, rounded bottom, curved ears. */}
      <motion.div className="relative" initial={false} animate={{ opacity: hidden ? 0 : 1 }}>
        <Ear side="left" />
        <Ear side="right" />
      <motion.div
        className="relative overflow-hidden bg-black text-white"
        initial={false}
        animate={{ ...size, borderBottomLeftRadius: radius, borderBottomRightRadius: radius }}
        transition={spring}
      >
        {/* Soft glow in the colour of what's shown. It rises from the bottom so the top edge stays
            pure black and joins the ears seamlessly. */}
        <motion.div className="pointer-events-none absolute inset-0"
          animate={{ opacity: view === "flash" ? 1 : view === "hint" ? (tab === "music" && player.media ? 1 : 0) : view === "collapsed" || kind === "none" ? 0 : 1 }}
          style={{ background: `radial-gradient(90% 80% at 0% 100%, ${accent}2e, transparent 70%)` }} />

        <AnimatePresence initial={false}>
          <motion.div
            key={view === "flash" && flash ? `flash-${flash.kind}` : view}
            ref={view === "collapsed" ? undefined : contentRef}
            className="absolute left-1/2 top-0 -translate-x-1/2"
            style={{ width: size.width }}
            initial={{ opacity: 0, filter: "blur(6px)", scale: 0.97 }}
            animate={{ opacity: 1, filter: "blur(0px)", scale: 1, transition: { delay: 0.06, duration: 0.22 } }}
            exit={{ opacity: 0, filter: "blur(6px)", transition: { duration: 0.12 } }}
          >
            {view === "collapsed" && (
              <Collapsed time={clock.time} date={clock.date} battery={battery} privacy={privacy} event={event} tools={tools} conversion={conversion}
                music={playing ? <NowPlayingLabel player={player} /> : undefined}
                bars={playing ? <Bars playing color={player.color} /> : undefined}
                // A running task or Claude waiting takes the weather's place, so the notch never overflows.
                extras={dev.running.length || dev.waiting.length ? undefined : <WeatherChips weather={weather} now={Date.now()} />}
                dev={<DevChip dev={dev} meters={meters} />} />
            )}

            {view === "held" && held?.kind === "notification" && (
              <NoteCard note={held.note}
                onOpen={() => {
                  invoke("open_app", { aumid: held.note.aumid }).catch(() => {});
                  setHeld(null);
                }}
                onDismiss={() => {
                  removeNote(held.note.id);
                  setHeld(null);
                }} />
            )}
            {view === "held" && held?.kind === "screenshot" && <ShotCard shot={held} />}
            {view === "held" && held?.kind === "download" && <DownloadCard download={held} onDone={() => setHeld(null)} />}
            {view === "held" && held?.kind === "dev" && <DevCard flash={held.dev} onDone={() => setHeld(null)} />}

            {view === "openwith" && (
              <OpenWithView paths={dragPaths} apps={openWithApps} point={dragAt} />
            )}
            {view === "convert" && (
              <ConvertView paths={dragPaths} point={dragAt} accent={ACCENT[dragInfo?.kind ?? "none"]}
                busy={!!converting} formats={dragInfo?.presets ?? (looksLikeFile(dragPaths[0]) ? null : [])} />
            )}

            {view === "flash" && flash && (
              flash.kind === "track" ? <TrackFlash player={player} /> : flash.kind === "screenshot" ? <ShotFlash shot={flash} /> : flash.kind === "download" ? <DownloadFlash download={flash} /> : flash.kind === "dev" ? <DevFlashView flash={flash.dev} /> : <FlashView flash={flash} />
            )}

            {view === "hint" && !dragging && (
              <div className="flex flex-col gap-3 p-3">
                <AnimatePresence mode="popLayout" initial={false}>
                  <motion.div key={tab} initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.98 }} transition={{ duration: 0.16 }}>
                    {tab === "music" && (player.media ? (
                      <PlayerCard player={player} />
                    ) : (
                      <div className="flex flex-col items-center gap-2 py-5 text-center">
                        <span className="text-white/40"><Icon name="audio" size={28} /></span>
                        <div className="text-[13px] font-medium">Nothing playing</div>
                        <div className="text-[11.5px] text-white/45">Play something in Spotify, a browser, your library or the radio.</div>
                        <button onClick={() => setTab("library")}
                          className="mt-1 flex h-7 items-center gap-1.5 rounded-full bg-white/10 px-3 text-[12px] font-medium hover:bg-white/18">
                          <Icon name="library" size={13} />Open library
                        </button>
                      </div>
                    ))}
                    {tab === "library" && <LibraryView library={library} local={local} />}
                    {tab === "radio" && <RadioView radio={radio} local={local} />}
                    {tab === "timer" && <TimerView tools={tools} />}
                    {tab === "today" && <TodayView weather={weather} dnd={dnd} onDnd={toggleDnd} devOn={devTab.on} onDev={devTab.toggle} />}
                    {tab === "clipboard" && <ClipboardView clips={clips} />}
                    {tab === "notifications" && <NotificationsView notes={notes} onRemove={removeNote} onClear={clearNotes} />}
                    {tab === "shelf" && <ShelfView shots={shots} />}
                    {tab === "notes" && <NotesView open={noteToOpen} onOpened={() => setNoteToOpen(null)} />}
                    {tab === "dev" && <DevView dev={dev} github={github} meters={meters} />}
                    {tab === "keys" && <ShortcutsView />}
                  </motion.div>
                </AnimatePresence>
              </div>
            )}

            {stage.kind === "ready" && view === "ready" && (
              <div className="flex flex-col gap-3.5 p-4">
                <FileHeader path={stage.path} info={stage.info} onClose={close} />
                {stage.info.presets.length === 0 && (
                  <p className="text-[13px] text-white/60">This file type can't be converted yet.</p>
                )}
              </div>
            )}

            {stage.kind === "converting" && view === "converting" && (
              <div className="flex flex-col gap-3 p-4">
                <div className="flex items-center gap-3">
                  <Tile icon={ICON[kind]} color={accent} />
                  <div className="min-w-0 flex-1">
                    <div className="text-[14px] font-medium">Converting to {stage.preset.label}</div>
                    <div className="truncate text-[12px] text-white/50">{fileName(stage.path)}</div>
                  </div>
                  <span className="text-[20px] font-semibold tabular-nums" style={{ color: accent }}>
                    {stage.progress === null ? "" : `${Math.round(stage.progress * 100)}%`}
                  </span>
                </div>
                <ProgressBar progress={stage.progress} color={accent} />
              </div>
            )}

            {stage.kind === "done" && view === "done" && (
              <div className="flex flex-col gap-3.5 p-4">
                <div className="flex items-center gap-3">
                  <Tile icon="check" color={accent} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[14px] font-medium">Saved {fileName(stage.out)}</div>
                    <div className="text-[12px] text-white/50">
                      {formatSize(stage.info.size)} → {formatSize(stage.size)}
                      {stage.info.size > 0 && (
                        <span style={{ color: stage.size <= stage.info.size ? accent : undefined }}>
                          {" · "}
                          {stage.size <= stage.info.size ? "−" : "+"}
                          {Math.abs(Math.round((1 - stage.size / stage.info.size) * 100))}%
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button accent={accent} onClick={() => invoke("reveal", { path: stage.out })}>Show in folder</Button>
                  <Button onClick={() => setStage({ kind: "ready", path: stage.path, info: stage.info })}>Another format</Button>
                  <div className="flex-1" />
                  <Button onClick={close}>Done</Button>
                </div>
              </div>
            )}

            {stage.kind === "error" && view === "error" && (
              <div className="flex flex-col gap-3.5 p-4">
                <div className="flex items-center gap-3">
                  <Tile icon="alert" color="#ff6b6b" />
                  <div className="min-w-0 flex-1">
                    <div className="text-[14px] font-medium">Conversion failed</div>
                    <div className="line-clamp-2 text-[12px] text-white/55">{stage.message}</div>
                  </div>
                </div>
                <div className="flex gap-2">
                  {stage.path && stage.info && (
                    <Button onClick={() => setStage({ kind: "ready", path: stage.path!, info: stage.info! })}>Try another format</Button>
                  )}
                  <div className="flex-1" />
                  <Button onClick={close}>Close</Button>
                </div>
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      </motion.div>
      </motion.div>

      <AnimatePresence>
        {tray && (
          <motion.div
            key="tray"
            ref={trayRef}
            style={{ width: TRAY_WIDTH }}
            animate={{ opacity: hidden ? 0 : 1 }}
            exit={{ opacity: 0, y: -10, filter: "blur(6px)", transition: { duration: 0.15 } }}
          >
            <FormatRow info={tray.info} onPick={(p) => start(tray.path, tray.info, p)} />
          </motion.div>
        )}
        {dock && (
          <motion.div
            key="dock"
            ref={trayRef}
            initial={{ opacity: 0, y: -8, scale: 0.96 }}
            animate={{ opacity: hidden ? 0 : 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.96, filter: "blur(4px)", transition: { duration: 0.14 } }}
            transition={{ type: "spring", stiffness: 420, damping: 30 }}
          >
            <Dock tab={tab} onChange={setTab} timerRunning={!!tools.tool} unread={unread} waiting={dev.waiting.length} devOn={devTab.on} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
    </TooltipLayer>
  );
}
