// Everything the island shows without being opened: battery, volume, brightness, mic/camera use,
// Bluetooth devices, the next calendar event, notifications, and the timer/stopwatch.
// Rust (src-tauri/src/system.rs, platform.rs) sends the readings as events.
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AnimatePresence, motion } from "motion/react";
import { Icon, type IconName } from "../components/icons";
import type { DevFlash } from "../features/developer/dev";
import { ToolChip, type Tools } from "../features/timer/timer";

export type Battery = { percent: number; plugged: boolean };
type Volume = { percent: number; muted: boolean };
type Privacy = { mic: string[]; camera: string[] };
type Device = { name: string; battery: number | null };
type CalEvent = { title: string; start: number; location: string };
/** A notification from another app (src-tauri/src/system.rs). */
export type Note = { id: number; app: string; aumid: string; icon: string | null; title: string; body: string };

/** A short-lived view that opens the notch for a moment, e.g. after the volume changes. */
export type Flash =
  | { kind: "power"; battery: Battery; low: boolean }
  | { kind: "volume"; volume: Volume }
  | { kind: "brightness"; percent: number }
  | { kind: "bluetooth"; device: Device; connected: boolean }
  | { kind: "privacy"; what: "mic" | "camera"; app: string }
  | { kind: "notification"; note: Note }
  | { kind: "event"; event: CalEvent }
  | { kind: "timer"; title: string; subtitle: string } // a timer, Pomodoro phase or alarm ended (src/features/timer/timer.tsx)
  | { kind: "track" } // drawn by src/features/music/media.tsx
  | { kind: "opened"; app: string; error?: string }
  | { kind: "screenshot"; path: string; at: number } // drawn by src/features/screenshots/shelf.tsx
  | { kind: "download"; path: string; name: string; size: number } // drawn by src/features/downloads/downloads.tsx
  | { kind: "dev"; dev: DevFlash } // drawn by src/features/developer/dev.tsx
  | { kind: "update"; version: string }; // drawn by src/features/about/about.tsx

const FLASH_MS: Record<Flash["kind"], number> = {
  power: 2600, volume: 1500, brightness: 1500, bluetooth: 3000, privacy: 3000, notification: 5000, event: 6000, timer: 8000, track: 3000, opened: 2200, screenshot: 5000, download: 5000, dev: 6000, update: 6000,
};

export const COLOR = {
  charge: "#4fd18b", low: "#ff6b6b", mic: "#ff9f0a", camera: "#30d158", tool: "#ffb340",
  event: "#bf8bff", bluetooth: "#5ab8ff", brightness: "#ffd60a", white: "#ffffff",
};

export const batteryColor = (b: Battery) => (b.plugged ? COLOR.charge : b.percent <= 20 ? COLOR.low : COLOR.white);

export function flashColor(f: Flash) {
  switch (f.kind) {
    case "power": return f.low ? COLOR.low : batteryColor(f.battery);
    case "brightness": return COLOR.brightness;
    case "bluetooth": return COLOR.bluetooth;
    case "privacy": return COLOR[f.what];
    case "event": return COLOR.event;
    case "timer": return COLOR.tool;
    case "dev": return f.dev.color;
    case "update": return COLOR.charge;
    default: return COLOR.white;
  }
}

/** "just now", "5 min ago", "2 h ago", "yesterday", then the date. */
export function ago(at: number, now = Date.now()) {
  const min = Math.floor((now - at) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  return h < 48 ? "yesterday" : new Date(at).toLocaleDateString([], { day: "numeric", month: "short" });
}

const NOTE_HISTORY = 60;

/** Date.now(), refreshed every `ms` while `ms` isn't null. */
export function useNow(ms: number | null) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (ms === null) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

export function useSystem() {
  const [battery, setBattery] = useState<Battery | null>(null);
  const [privacy, setPrivacy] = useState<Privacy>({ mic: [], camera: [] });
  const [event, setEvent] = useState<CalEvent | null>(null);
  const [flash, setFlash] = useState<Flash | null>(null);
  // Every notification this session (newest first), for the notifications tab. Not saved to disk.
  const [notes, setNotes] = useState<(Note & { at: number })[]>([]);
  const [unread, setUnread] = useState(0);
  const timeout = useRef<number | undefined>(undefined);
  const show = useCallback((f: Flash) => {
    clearTimeout(timeout.current);
    setFlash(f);
    timeout.current = setTimeout(() => setFlash(null), FLASH_MS[f.kind]);
  }, []);

  // The previous reading of each kind. The first reading is only a baseline and never flashes.
  const last = useRef<{ battery?: Battery; volume?: Volume; brightness?: number; privacy?: Privacy; devices?: Device[] }>({});

  useEffect(() => {
    const on = <T,>(name: string, f: (value: T) => void) => listen<T>(name, (e) => f(e.payload));
    const unlisten = [
      on<Battery | null>("battery", (b) => {
        setBattery(b);
        const prev = last.current.battery;
        if (!b) return;
        last.current.battery = b;
        if (!prev) return;
        if (prev.plugged !== b.plugged) show({ kind: "power", battery: b, low: false });
        else if (!b.plugged && [20, 10, 5].some((t) => prev.percent > t && b.percent <= t)) show({ kind: "power", battery: b, low: true });
      }),
      on<Volume>("volume", (v) => {
        const prev = last.current.volume;
        last.current.volume = v;
        if (prev && (prev.percent !== v.percent || prev.muted !== v.muted)) show({ kind: "volume", volume: v });
      }),
      on<number>("brightness", (percent) => {
        const prev = last.current.brightness;
        last.current.brightness = percent;
        if (prev !== undefined && prev !== percent) show({ kind: "brightness", percent });
      }),
      on<Privacy>("privacy", (p) => {
        setPrivacy(p);
        const prev = last.current.privacy;
        last.current.privacy = p;
        if (!prev) return;
        const started = (["camera", "mic"] as const).flatMap((what) => p[what].filter((app) => !prev[what].includes(app)).map((app) => ({ what, app })));
        if (started[0]) show({ kind: "privacy", ...started[0] });
      }),
      on<Device[]>("bluetooth", (d) => {
        const prev = last.current.devices;
        last.current.devices = d;
        if (!prev) return;
        const added = d.find((x) => !prev.some((p) => p.name === x.name));
        const removed = prev.find((p) => !d.some((x) => x.name === p.name));
        if (added) show({ kind: "bluetooth", device: added, connected: true });
        else if (removed) show({ kind: "bluetooth", device: removed, connected: false });
      }),
      on<CalEvent | null>("event", setEvent),
      on<Note>("notification", (note) => {
        show({ kind: "notification", note });
        setNotes((list) => [{ ...note, at: Date.now() }, ...list].slice(0, NOTE_HISTORY));
        setUnread((n) => n + 1);
      }),
    ];
    return () => unlisten.forEach((p) => p.then((off) => off()));
  }, [show]);

  // A heads-up once per event, 5 minutes before it starts.
  const now = useNow(event ? 15_000 : null);
  const warned = useRef("");
  useEffect(() => {
    if (!event) return;
    const left = event.start - Date.now();
    const key = event.title + event.start;
    if (left > 0 && left <= 5 * 60_000 && warned.current !== key) {
      warned.current = key;
      show({ kind: "event", event });
    }
  }, [event, now, show]);

  const removeNote = useCallback((id: number) => {
    setNotes((list) => list.filter((n) => n.id !== id));
    invoke("dismiss_notification", { id }).catch(() => {});
  }, []);
  const clearNotes = useCallback(() => {
    setNotes((list) => {
      list.forEach((n) => invoke("dismiss_notification", { id: n.id }).catch(() => {}));
      return [];
    });
  }, []);
  const markRead = useCallback(() => setUnread(0), []);

  return { battery, privacy, event, flash, show, notes, unread, removeNote, clearNotes, markRead };
}

/** Three soft beeps when a timer ends. */
export function chime() {
  const ctx = new AudioContext();
  [0, 0.25, 0.5].forEach((at) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime + at);
    gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + 0.2);
    osc.connect(gain).connect(ctx.destination);
    osc.start(ctx.currentTime + at);
    osc.stop(ctx.currentTime + at + 0.22);
  });
  setTimeout(() => ctx.close(), 1000);
}

/** m:ss, or h:mm:ss from an hour up. A countdown rounds up so it reads 0:01 until it's done. */
export function clockText(ms: number, countdown = false) {
  const s = countdown ? Math.ceil(ms / 1000) : Math.floor(ms / 1000);
  const [h, m, sec] = [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60];
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

function untilText(start: number, now = Date.now()) {
  const min = Math.round((start - now) / 60_000);
  if (min < 1) return "now";
  return min < 60 ? `in ${min} min` : `in ${Math.floor(min / 60)} h ${min % 60} min`;
}

/** A battery outline whose fill follows the level, with a bolt while plugged in. */
export function BatteryGauge({ battery, width = 24, height = 12 }: { battery: Battery; width?: number; height?: number }) {
  const color = batteryColor(battery);
  return (
    <div className="flex items-center" style={{ width, height }}>
      <div className="relative h-full flex-1 rounded-sm p-0.5" style={{ boxShadow: "inset 0 0 0 1px rgb(255 255 255 / 0.35)" }}>
        <motion.div className="h-full rounded-xs" style={{ background: color }} initial={false}
          animate={{ width: `${Math.max(battery.percent, 4)}%` }} transition={{ type: "spring", stiffness: 120, damping: 20 }} />
        <AnimatePresence>
          {battery.plugged && (
            <motion.div key="bolt" className="absolute inset-0 grid place-items-center text-black"
              initial={{ scale: 0, rotate: -30 }} animate={{ scale: 1, rotate: 0 }} exit={{ scale: 0 }}
              transition={{ type: "spring", stiffness: 500, damping: 18 }}>
              <Icon name="bolt" size={height - 2} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <div className="ml-px h-1/3 w-0.5 rounded-r-full bg-white/35" />
    </div>
  );
}

export function Ring({ progress, color, size = 16 }: { progress: number; color: string; size?: number }) {
  const r = (size - 3) / 2;
  const c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} className="shrink-0 -rotate-90">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgb(255 255 255 / 0.15)" strokeWidth={2.5} />
      <motion.circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={2.5} strokeLinecap="round"
        strokeDasharray={c} initial={false} animate={{ strokeDashoffset: c * (1 - Math.min(Math.max(progress, 0), 1)) }} />
    </svg>
  );
}

function Bar({ percent, color }: { percent: number; color: string }) {
  return (
    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/15">
      <motion.div className="h-full rounded-full" style={{ background: color }} initial={false}
        animate={{ width: `${percent}%` }} transition={{ type: "spring", stiffness: 400, damping: 35 }} />
    </div>
  );
}

function Dot({ color }: { color: string }) {
  return (
    <motion.span className="size-1.5 rounded-full" style={{ background: color, boxShadow: `0 0 6px ${color}` }}
      initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }} />
  );
}

const pop = { initial: { opacity: 0, scale: 0.6 }, animate: { opacity: 1, scale: 1 }, exit: { opacity: 0, scale: 0.6 } };

/** The resting notch: time and running tools on the left, status on the right. */
export function Collapsed({ time, date, battery, privacy, event, tools, conversion, music, bars, extras, dev }: {
  time: string; date: string; battery: Battery | null; privacy: Privacy; event: CalEvent | null; tools: Tools;
  conversion: { progress: number | null; color: string } | null;
  /** While music plays: the track on the left (taking whatever room is left); bars, time and battery on the right, no date. */
  music?: React.ReactNode; bars?: React.ReactNode;
  /** Weather (and sunrise/sunset when it's close), shown when no music plays. */
  extras?: React.ReactNode;
  /** A running `notch` task or an agent waiting for you (src/features/developer/dev.tsx). */
  dev?: React.ReactNode;
}) {
  const now = Date.now();
  const soon = event && event.start - now <= 60 * 60_000 ? event : null;
  return (
    <div className="flex h-8.5 items-center justify-between gap-3 px-4 text-[12.5px] font-medium tabular-nums">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        {music ?? (
          <span className="flex shrink-0 items-center gap-2.5">
            <span className="font-semibold">{time}</span>
            <span className="h-3 w-px bg-white/25" />
            <span className="font-semibold tracking-wide">{date}</span>
          </span>
        )}
        <ToolChip tools={tools} />
        <AnimatePresence>
          {conversion && (
            <motion.span key="conversion" {...pop} className="flex items-center gap-1.5" style={{ color: conversion.color }}>
              <Ring progress={conversion.progress ?? 0} color={conversion.color} size={14} />
              {conversion.progress === null ? "…" : `${Math.round(conversion.progress * 100)}%`}
            </motion.span>
          )}
        </AnimatePresence>
        {dev}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <AnimatePresence>
          {(privacy.camera.length > 0 || privacy.mic.length > 0) && (
            <motion.span key="privacy" {...pop} className="flex items-center gap-1">
              {privacy.camera.length > 0 && <Dot color={COLOR.camera} />}
              {privacy.mic.length > 0 && <Dot color={COLOR.mic} />}
            </motion.span>
          )}
          {soon && (
            <motion.span key="event" {...pop} className="flex min-w-0 items-center gap-1.5" style={{ color: COLOR.event }}>
              <Icon name="calendar" size={14} />
              <span className="truncate">{untilText(soon.start, now)}</span>
            </motion.span>
          )}
        </AnimatePresence>
        {bars}
        {music && <span className="shrink-0">{time}</span>}
        {!music && extras}
        {battery && (
          <div className="flex items-center gap-1.5">
            <BatteryGauge battery={battery} />
            <span style={{ color: battery.plugged || battery.percent <= 20 ? batteryColor(battery) : undefined }}>{battery.percent}%</span>
          </div>
        )}
      </div>
    </div>
  );
}

function FlashTile({ icon, color, pulse }: { icon: IconName; color: string; pulse?: boolean }) {
  return (
    <motion.div className="grid size-9 shrink-0 place-items-center" style={{ color }}
      initial={pulse ? false : { scale: 0.4, opacity: 0 }}
      animate={pulse ? { scale: [1, 1.12, 1] } : { scale: [0.4, 1.15, 1], opacity: 1 }}
      transition={pulse ? { repeat: Infinity, duration: 1 } : { duration: 0.45 }}>
      <Icon name={icon} size={24} />
    </motion.div>
  );
}

export function FlashRow({ icon, color, title, subtitle, right, pulse }: {
  icon: IconName; color: string; title: string; subtitle?: string; right?: React.ReactNode; pulse?: boolean;
}) {
  return (
    <div className="flex h-14 items-center gap-3 px-3.5">
      <FlashTile icon={icon} color={color} pulse={pulse} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px] font-medium">{title}</div>
        {subtitle && <div className="truncate text-[12px] text-white/55">{subtitle}</div>}
      </div>
      {right}
    </div>
  );
}

export function FlashView({ flash }: { flash: Flash }) {
  const color = flashColor(flash);
  switch (flash.kind) {
    case "power": {
      const b = flash.battery;
      return (
        <FlashRow icon={flash.low ? "batteryLow" : "bolt"} color={color} pulse={flash.low}
          title={flash.low ? "Low battery" : b.plugged ? "Charging" : "On battery"}
          subtitle={flash.low ? "Plug in your charger" : undefined}
          right={
            <div className="flex items-center gap-2.5 pr-1.5">
              <span className="text-[20px] font-semibold tabular-nums" style={{ color }}>{b.percent}%</span>
              <BatteryGauge battery={b} width={38} height={18} />
            </div>
          } />
      );
    }
    case "volume":
    case "brightness": {
      const percent = flash.kind === "volume" ? (flash.volume.muted ? 0 : flash.volume.percent) : flash.percent;
      const icon: IconName = flash.kind === "brightness" ? "sun" : percent === 0 ? "volumeOff" : percent < 50 ? "volumeLow" : "volumeHigh";
      return (
        <div className="flex h-10 items-center gap-3 px-4">
          <span style={{ color }}><Icon name={icon} size={18} /></span>
          <Bar percent={percent} color={color} />
          <span className="w-10 text-right text-[13px] font-semibold tabular-nums">
            {flash.kind === "volume" && flash.volume.muted ? "Muted" : percent}
          </span>
        </div>
      );
    }
    case "bluetooth":
      return (
        <FlashRow icon="headphones" color={flash.connected ? color : "#a1a1aa"} title={flash.device.name}
          subtitle={flash.connected ? "Connected" : "Disconnected"}
          right={flash.connected && flash.device.battery !== null && (
            <span className="pr-1.5 text-[18px] font-semibold tabular-nums" style={{ color }}>{flash.device.battery}%</span>
          )} />
      );
    case "privacy":
      return <FlashRow icon={flash.what} color={color} title={flash.app} subtitle={`is using your ${flash.what === "mic" ? "microphone" : "camera"}`} />;
    case "notification":
      return <NoteFlash note={flash.note} />;
    case "event":
      return (
        <FlashRow icon="calendar" color={color} title={flash.event.title}
          subtitle={[untilText(flash.event.start), flash.event.location].filter(Boolean).join(" · ")} />
      );
    case "timer":
      return <FlashRow icon="timer" color={color} pulse title={flash.title} subtitle={flash.subtitle} />;
    case "track":
    case "screenshot":
    case "download":
    case "dev":
    case "update":
      return null;
    case "opened":
      return flash.error
        ? <FlashRow icon="alert" color={COLOR.low} title={`Couldn't open in ${flash.app}`} subtitle={flash.error} />
        : <FlashRow icon="check" color={COLOR.charge} title={`Opened in ${flash.app}`} />;
  }
}

/** `tip` shows the island tooltip; give it to buttons whose icon alone doesn't say what they do. */
export function AppLogo({ note, size }: { note: Note; size: number }) {
  return note.icon ? (
    <motion.img src={note.icon} alt="" className="shrink-0 object-contain" style={{ width: size, height: size }}
      initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: [0.4, 1.12, 1], opacity: 1 }} transition={{ duration: 0.45 }} />
  ) : (
    <span className="grid shrink-0 place-items-center text-white/80" style={{ width: size, height: size }}><Icon name="bell" size={size * 0.65} /></span>
  );
}

/** The pop-up for a new notification: the app's own logo, who it's from, and the message. */
function NoteFlash({ note }: { note: Note }) {
  return (
    <div className="flex h-15 items-center gap-3 px-3.5">
      <AppLogo note={note} size={36} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-[14px] font-semibold">{note.title || note.app}</span>
          {note.title && <span className="shrink-0 text-[11px] text-white/40">{note.app}</span>}
        </div>
        {note.body && <div className="truncate text-[12.5px] text-white/70">{note.body.replace(/\n+/g, " · ")}</div>}
      </div>
    </div>
  );
}

/** Hovering a notification pop-up keeps it open, with the whole message and what to do next.
    Windows doesn't let other apps answer a notification, so "Reply" opens the app at it. */
export function NoteCard({ note, onOpen, onDismiss }: { note: Note; onOpen: () => void; onDismiss: () => void }) {
  return (
    <div className="flex flex-col gap-3 p-3.5">
      <div className="flex items-start gap-3">
        <AppLogo note={note} size={40} />
        <div className="min-w-0 flex-1">
          <div className="text-[11px] text-white/40">{note.app}</div>
          <div className="truncate text-[14.5px] font-semibold">{note.title || note.app}</div>
          {note.body && <div className="mt-0.5 line-clamp-4 text-[13px] whitespace-pre-line text-white/80">{note.body}</div>}
        </div>
      </div>
      <div className="flex gap-2">
        <button onClick={onOpen}
          className="flex h-8 flex-1 items-center justify-center rounded-full bg-white text-[12.5px] font-semibold text-black transition-[filter] hover:brightness-90 active:scale-[0.98]">
          Reply in {note.app || "app"}
        </button>
        <button onClick={onDismiss}
          className="flex h-8 items-center rounded-full bg-white/10 px-4 text-[12.5px] font-medium transition-colors hover:bg-white/18">
          Dismiss
        </button>
      </div>
    </div>
  );
}
