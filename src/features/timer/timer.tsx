// Timer tab: a countdown (presets or any length you type, with a label), Pomodoro, a focus session
// (only the apps you pick may be in front, src-tauri/src/focus.rs), a stopwatch with laps, and
// alarms at a time of day. Everything runs on wall-clock timestamps and is kept in
// localStorage, so it survives the island restarting.
import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { Icon, type IconName } from "../../components/icons";
import { load, save } from "../../lib/storage";
import { COLOR, Ring, clockText, useNow } from "../../island/system";
import { useTip } from "../../components/tooltip";
import { MIN, parseAlarm, parseDuration } from "./timeparse";
import { Kit } from "../../island/kit";

type Countdown = { total: number; end: number; left: number | null }; // `left` is set while paused
export type Tool =
  | ({ mode: "timer"; label: string } & Countdown)
  | ({ mode: "pomodoro"; phase: "focus" | "break" | "long"; round: number } & Countdown)
  | ({ mode: "focus"; apps: FocusApp[] } & Countdown)
  | { mode: "stopwatch"; start: number; elapsed: number | null; laps: number[] }; // `elapsed` while paused; laps: total ms at each lap
export type Alarm = { id: number; at: number; label: string };
/** What the island says when something ends. `ring`: a timer or alarm, which pauses the music while
    it rings (a Pomodoro moving on doesn't). */
export type Ding = { title: string; subtitle: string; alarm?: boolean; ring?: boolean };
type FocusApp = { exe: string; name: string; icon?: string | null };

const TOOL_KEY = "island.timer";
const ALARMS_KEY = "island.alarms";
export const POMODORO = { focus: 25 * MIN, break: 5 * MIN, long: 15 * MIN, rounds: 4 };

function stored<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(load(key) ?? "") ?? fallback;
  } catch {
    return fallback;
  }
}

const countdown = (total: number): Countdown => ({ total, end: Date.now() + total, left: null });

/** 5000 -> "5 s", 1500000 -> "25 min", 4800000 -> "1 h 20 min". */
const lengthText = (ms: number) => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const [h, m, rest] = [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60];
  return [h && `${h} h`, m && `${m} min`, rest && `${rest} s`].filter(Boolean).join(" ");
};
const atText = (at: number) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).toUpperCase();
const lapText = (ms: number) => `${clockText(ms)}.${Math.floor((ms % 1000) / 100)}`;

/** The running timer/Pomodoro/focus/stopwatch and the alarms. `onDing` fires when one ends,
    `onBlocked` with an app's name when a focus session minimised it. */
export function useTools(onDing: (d: Ding) => void, onBlocked: (app: string) => void) {
  const [tool, setTool] = useState<Tool | null>(() => {
    const t = stored<Tool | null>(TOOL_KEY, null);
    // A countdown that ran out while the island was closed is simply gone.
    return t && t.mode !== "stopwatch" && t.left === null && t.end < Date.now() ? null : t;
  });
  const [alarms, setAlarms] = useState<Alarm[]>(() => stored<Alarm[]>(ALARMS_KEY, []).filter((a) => a.at > Date.now()));
  const now = useNow(tool || alarms.length ? 250 : null);
  const ding = useRef(onDing);
  ding.current = onDing;
  const blocked = useRef(onBlocked);
  blocked.current = onBlocked;

  useEffect(() => save(TOOL_KEY, JSON.stringify(tool)), [tool]);
  useEffect(() => save(ALARMS_KEY, JSON.stringify(alarms)), [alarms]);

  const isCountdown = tool?.mode === "timer" || tool?.mode === "pomodoro" || tool?.mode === "focus";
  const paused = !tool ? false : tool.mode === "stopwatch" ? tool.elapsed !== null : tool.left !== null;
  const ms = !tool ? 0 : tool.mode === "stopwatch" ? (tool.elapsed ?? now - tool.start) : (tool.left ?? Math.max(tool.end - now, 0));

  // Countdowns ending; a Pomodoro moves on to its next phase by itself.
  useEffect(() => {
    if (!tool || tool.mode === "stopwatch" || tool.left !== null || tool.end > now) return;
    if (tool.mode === "timer") {
      setTool(null);
      ding.current({ title: tool.label ? `${tool.label} · time's up` : "Time's up", subtitle: `Your ${lengthText(tool.total)} timer has finished`, ring: true });
      return;
    }
    if (tool.mode === "focus") {
      setTool(null);
      ding.current({ title: "Focus done", subtitle: `${lengthText(tool.total)} of focus · every app is back` });
      return;
    }
    const next = tool.phase !== "focus" ? "focus" : tool.round % POMODORO.rounds === 0 ? "long" : "break";
    const round = tool.phase === "long" ? 1 : tool.phase === "focus" ? tool.round : tool.round + 1;
    setTool({ mode: "pomodoro", phase: next, round, ...countdown(POMODORO[next]) });
    ding.current(next === "focus"
      ? { title: "Back to focus", subtitle: `Round ${round} of ${POMODORO.rounds} · 25 minutes` }
      : { title: next === "long" ? "Long break" : "Take a break", subtitle: `${next === "long" ? 15 : 5} minutes · round ${tool.round} done` });
  }, [tool, now]);

  useEffect(() => {
    const due = alarms.filter((a) => a.at <= now);
    if (!due.length) return;
    setAlarms((list) => list.filter((a) => a.at > now));
    due.forEach((a) => ding.current({ title: a.label || "Alarm", subtitle: `It's ${atText(a.at)}`, alarm: true, ring: true }));
  }, [alarms, now]);

  // A running (not paused) focus session keeps other apps out; the backend does the watching.
  const focusApps = tool?.mode === "focus" && tool.left === null ? tool.apps.map((a) => a.exe).join("|") : "";
  useEffect(() => {
    (focusApps ? invoke("focus_set", { apps: focusApps.split("|") }) : invoke("focus_clear")).catch(() => {});
  }, [focusApps]);
  useEffect(() => {
    const off = listen<string>("focus-blocked", (e) => blocked.current(e.payload));
    return () => void off.then((f) => f());
  }, []);

  const nextAlarm = alarms.length ? alarms.reduce((a, b) => (a.at < b.at ? a : b)) : null;

  return {
    tool, ms, paused, alarms, nextAlarm, now,
    countdown: isCountdown,
    progress: tool && tool.mode !== "stopwatch" ? ms / tool.total : null,
    /** What it is, for the notch and the card: "Tea", "Focus 2/4", "Stopwatch". */
    label: !tool ? "" : tool.mode === "timer" ? tool.label || "Timer" : tool.mode === "stopwatch" ? "Stopwatch"
      : tool.mode === "focus" ? `Focus · ${tool.apps.map((a) => a.name).join(", ")}`
      : tool.phase === "focus" ? `Focus ${tool.round}/${POMODORO.rounds}` : tool.phase === "long" ? "Long break" : "Break",
    timer: (total: number, label = "") => setTool({ mode: "timer", label: label.trim().slice(0, 40), ...countdown(total) }),
    pomodoro: () => setTool({ mode: "pomodoro", phase: "focus", round: 1, ...countdown(POMODORO.focus) }),
    focus: (total: number, apps: FocusApp[]) => setTool({ mode: "focus", apps: apps.map(({ exe, name }) => ({ exe, name })), ...countdown(total) }),
    stopwatch: () => setTool({ mode: "stopwatch", start: Date.now(), elapsed: null, laps: [] }),
    toggle: () =>
      setTool((t) => {
        if (!t) return t;
        if (t.mode === "stopwatch") return t.elapsed === null ? { ...t, elapsed: Date.now() - t.start } : { ...t, start: Date.now() - t.elapsed, elapsed: null };
        return t.left === null ? { ...t, left: Math.max(t.end - Date.now(), 0) } : { ...t, end: Date.now() + t.left, left: null };
      }),
    addMinute: () =>
      setTool((t) => (!t || t.mode === "stopwatch" ? t : { ...t, total: t.total + MIN, ...(t.left === null ? { end: t.end + MIN } : { left: t.left + MIN }) })),
    /** Pomodoro: end this phase now and go to the next. */
    skip: () => setTool((t) => (t?.mode === "pomodoro" ? { ...t, end: Date.now() - 1, left: null } : t)),
    lap: () => setTool((t) => (t?.mode === "stopwatch" && t.elapsed === null ? { ...t, laps: [...t.laps, Date.now() - t.start] } : t)),
    stop: () => setTool(null),
    addAlarm: (at: number, label: string) => setAlarms((list) => [...list, { id: Date.now(), at, label: label.trim().slice(0, 40) }].sort((a, b) => a.at - b.at)),
    removeAlarm: (id: number) => setAlarms((list) => list.filter((a) => a.id !== id)),
  };
}

export type Tools = ReturnType<typeof useTools>;

/** For the resting notch: the running one, else an alarm less than an hour away. */
export function ToolChip({ tools }: { tools: Tools }) {
  const { tool, nextAlarm, now } = tools;
  const soon = !tool && nextAlarm && nextAlarm.at - now < 60 * MIN ? nextAlarm : null;
  return (
    <AnimatePresence>
      {(tool || soon) && (
        <motion.span key={tool ? "tool" : "alarm"} initial={{ opacity: 0, scale: 0.6 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.6 }}
          className="flex shrink-0 items-center gap-1.5 whitespace-nowrap" style={{ color: tool?.mode === "pomodoro" && tool.phase !== "focus" ? COLOR.charge : COLOR.tool }}>
          {tool ? (
            <>
              {tools.progress !== null ? <Ring progress={tools.progress} color="currentColor" size={14} /> : <Icon name="stopwatch" size={14} />}
              <span className={tools.paused ? "opacity-50" : undefined}>{clockText(tools.ms, tools.countdown)}</span>
            </>
          ) : soon && (
            <>
              <Icon name="bell" size={14} />
              <span>{atText(soon.at)}</span>
            </>
          )}
        </motion.span>
      )}
    </AnimatePresence>
  );
}

function Chip({ onClick, children, tip, active }: { onClick: () => void; children: React.ReactNode; tip?: string; active?: boolean }) {
  return (
    <button onClick={onClick} aria-label={tip} {...useTip(tip)}
      className={`flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium transition-colors active:scale-[0.96] ${active ? "bg-white text-black" : "bg-white/10 hover:bg-white/18"}`}>
      {children}
    </button>
  );
}

function Field({ value, onChange, onEnter, placeholder, className = "" }: {
  value: string; onChange: (v: string) => void; onEnter: () => void; placeholder: string; className?: string;
}) {
  return (
    <input value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => e.key === "Enter" && onEnter()} placeholder={placeholder}
      className={`h-8 min-w-0 rounded-full bg-white/8 px-3 text-[12.5px] text-white outline-none placeholder:text-white/35 focus:bg-white/12 ${className}`} />
  );
}

/** The running one, big, with its controls. */
function Running({ tools }: { tools: Tools }) {
  const tool = tools.tool!;
  const color = tool.mode === "pomodoro" && tool.phase !== "focus" ? COLOR.charge : COLOR.tool;
  const lapsRef = useRef<HTMLDivElement>(null);
  const laps = tool.mode === "stopwatch" ? tool.laps : [];
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3 rounded-2xl bg-white/5 px-3 py-2.5">
        {tools.progress !== null ? <Ring progress={tools.progress} color={color} size={34} /> : <span style={{ color }}><Icon name="stopwatch" size={30} /></span>}
        <div className="min-w-0 flex-1">
          <div className="text-[24px] leading-none font-semibold tabular-nums" style={{ color }}>
            {tool.mode === "stopwatch" ? lapText(tools.ms) : clockText(tools.ms, true)}
          </div>
          <div className="mt-1 truncate text-[12px] text-white/50">{tools.label}{tools.paused ? " · paused" : ""}</div>
        </div>
        {tool.mode !== "stopwatch" && <Chip onClick={tools.addMinute} tip="Add a minute"><Icon name="plus" size={13} />1m</Chip>}
        {tool.mode === "pomodoro" && <Chip onClick={tools.skip} tip="Skip to the next phase"><Icon name="next" size={13} /></Chip>}
        {tool.mode === "stopwatch" && !tools.paused && <Chip onClick={tools.lap}>Lap</Chip>}
        <Chip onClick={tools.toggle} tip={tools.paused ? "Resume" : "Pause"}><Icon name={tools.paused ? "play" : "pause"} size={13} /></Chip>
        <Chip onClick={tools.stop} tip="Stop"><Icon name="stop" size={13} /></Chip>
      </div>
      {laps.length > 0 && (
        <div ref={lapsRef} className="no-scrollbar max-h-24 overflow-y-auto px-1" onWheel={(e) => e.stopPropagation()}>
          {[...laps].reverse().map((total, i) => {
            const n = laps.length - i;
            const split = total - (laps[n - 2] ?? 0);
            return (
              <div key={n} className="flex h-6 items-center text-[12px] tabular-nums">
                <span className="w-14 text-white/45">Lap {n}</span>
                <span className="flex-1 font-medium">{lapText(split)}</span>
                <span className="text-white/40">{lapText(total)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

type Mode = "timer" | "pomodoro" | "focus" | "stopwatch" | "alarms";
const MODES: { id: Mode; label: string; icon: IconName }[] = [
  { id: "timer", label: "Timer", icon: "timer" }, { id: "pomodoro", label: "Pomodoro", icon: "passed" }, { id: "focus", label: "Focus", icon: "dnd" },
  { id: "stopwatch", label: "Stopwatch", icon: "stopwatch" }, { id: "alarms", label: "Alarms", icon: "bell" },
];
const PRESETS = [1, 3, 5, 10, 15, 25, 30, 45, 60];

export function TimerView({ tools }: { tools: Tools }) {
  const [mode, setMode] = useState<Mode>(() => (tools.tool?.mode as Mode) ?? "timer");
  const [length, setLength] = useState("");
  const [label, setLabel] = useState("");
  const [time, setTime] = useState("");
  const [alarmLabel, setAlarmLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const presetsRef = useRef<HTMLDivElement>(null);

  const startCustom = useCallback(() => {
    const ms = parseDuration(length);
    if (!ms) return setError("Try 7, 1:30, 90s or 1h20");
    setError(null);
    tools.timer(ms, label);
    setLength("");
    setLabel("");
  }, [length, label, tools]);
  const addAlarm = useCallback(() => {
    const at = parseAlarm(time);
    if (!at) return setError("Try 7:30, 7:30pm or 19:05");
    setError(null);
    tools.addAlarm(at, alarmLabel);
    setTime("");
    setAlarmLabel("");
  }, [time, alarmLabel, tools]);

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex gap-1">
        {MODES.map((m) => (
          <button key={m.id} onClick={() => { setMode(m.id); setError(null); }}
            className={`relative flex h-7 items-center gap-1.5 rounded-full px-3 text-[12px] font-medium transition-colors ${mode === m.id ? "text-black" : "bg-white/8 text-white/70 hover:bg-white/14"}`}>
            {mode === m.id && <motion.span layoutId="timer-mode" className="absolute inset-0 rounded-full bg-white" transition={{ type: "spring", stiffness: 500, damping: 36 }} />}
            <span className="relative">{m.label}</span>
            {m.id === "alarms" && tools.alarms.length > 0 && <span className="relative text-[10.5px] opacity-60">{tools.alarms.length}</span>}
          </button>
        ))}
      </div>

      {tools.tool && mode !== "alarms" && <Running tools={tools} />}

      {mode === "timer" && !tools.tool && (
        <>
          <div ref={presetsRef} className="no-scrollbar -mx-0.5 flex gap-1.5 overflow-x-auto px-0.5"
            onWheel={(e) => presetsRef.current && (presetsRef.current.scrollLeft += e.deltaY + e.deltaX)}>
            {PRESETS.map((m) => <Chip key={m} onClick={() => tools.timer(m * MIN, label)} tip={`${m} minute timer`}>{m < 60 ? `${m}m` : "1h"}</Chip>)}
          </div>
          <div className="flex gap-1.5">
            <Field value={length} onChange={setLength} onEnter={startCustom} placeholder="Any length: 7, 1:30, 1h20" className="w-40" />
            <Field value={label} onChange={setLabel} onEnter={startCustom} placeholder="Label (optional): Tea, Laundry…" className="flex-1" />
            <Chip onClick={startCustom} active>Start</Chip>
          </div>
        </>
      )}

      {mode === "pomodoro" && !tools.tool && (
        <div className="flex items-center gap-3 rounded-2xl bg-white/5 px-3 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium">Focus in rounds</div>
            <div className="text-[11.5px] text-white/45">25 min focus, 5 min break; a 15 min break after every 4th round. It moves on by itself.</div>
          </div>
          <Chip onClick={tools.pomodoro} active>Start</Chip>
        </div>
      )}

      {mode === "focus" && !tools.tool && <FocusSetup tools={tools} />}

      {mode === "stopwatch" && !tools.tool && (
        <div className="flex items-center gap-3 rounded-2xl bg-white/5 px-3 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium">Stopwatch</div>
            <div className="text-[11.5px] text-white/45">Count up, with laps.</div>
          </div>
          <Chip onClick={tools.stopwatch} active>Start</Chip>
        </div>
      )}

      {tools.tool && mode !== "alarms" && tools.tool.mode !== mode && (
        <div className="px-1 text-[11px] text-white/40">Stop the {tools.label.toLowerCase()} to start something else.</div>
      )}

      {mode === "alarms" && (
        <>
          <div className="flex gap-1.5">
            <Field value={time} onChange={setTime} onEnter={addAlarm} placeholder="Time: 7:30, 6pm" className="w-32" />
            <Field value={alarmLabel} onChange={setAlarmLabel} onEnter={addAlarm} placeholder="Label (optional): Stand-up, Pills…" className="flex-1" />
            <Chip onClick={addAlarm} active>Add</Chip>
          </div>
          {tools.alarms.length === 0 ? (
            <div className="px-1 text-[11.5px] text-white/40">The island rings at that time and shows the label. It's in the notch from an hour before.</div>
          ) : (
            <div className="no-scrollbar max-h-28 overflow-y-auto" onWheel={(e) => e.stopPropagation()}>
              {tools.alarms.map((a) => (
                <div key={a.id} className="group flex h-9 items-center gap-2.5 rounded-xl px-2 hover:bg-white/6">
                  <span style={{ color: COLOR.tool }}><Icon name="bell" size={15} /></span>
                  <span className="text-[14px] font-semibold tabular-nums">{atText(a.at)}</span>
                  <span className="min-w-0 flex-1 truncate text-[12px] text-white/55">
                    {[a.label, new Date(a.at).getDate() !== new Date(tools.now).getDate() && "tomorrow"].filter(Boolean).join(" · ")}
                  </span>
                  <button onClick={() => tools.removeAlarm(a.id)} aria-label="Remove alarm"
                    className="grid size-7 place-items-center rounded-full text-white/45 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-white/12 hover:text-white">
                    <Icon name="close" size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      {error && <div className="px-1 text-[11px] text-[#ff6b6b]">{error}</div>}
    </div>
  );
}

/** "Stay focused": centred like the download pop-up, with Kit looking worried beside the title. */
export function FocusFlash({ app }: { app: string }) {
  return (
    <div className="flex h-15 flex-col items-center justify-center gap-0.5 px-5 text-center">
      <div className="flex items-center gap-1.5 text-[13.5px] font-semibold">
        <Kit mood="worried" size={18} />
        Stay focused
      </div>
      <div className="max-w-full truncate text-[11.5px] text-white/55">{app} isn't part of this focus</div>
    </div>
  );
}

const FOCUS_PRESETS = [25, 45, 60, 90, 120];
const FOCUS_ADDED_KEY = "island.focusApps"; // apps added with "Add app", offered every time
const FOCUS_PICKED_KEY = "island.focusPicked"; // last session's apps, picked again
const START_MENU = String.raw`C:\ProgramData\Microsoft\Windows\Start Menu\Programs`;

/** Pick a length and the apps to work in; everything else is minimised until the time is up. */
function FocusSetup({ tools }: { tools: Tools }) {
  const [apps, setApps] = useState<FocusApp[] | null>(null);
  const [added, setAdded] = useState<FocusApp[]>(() => stored(FOCUS_ADDED_KEY, []));
  const [picked, setPicked] = useState<string[]>(() => stored(FOCUS_PICKED_KEY, []));
  const [minutes, setMinutes] = useState(25);
  const [length, setLength] = useState("");
  const [error, setError] = useState<string | null>(null);
  const appsRef = useRef<HTMLDivElement>(null);
  useEffect(() => void invoke<FocusApp[]>("focus_apps").then(setApps).catch(() => setApps([])), []);
  // Added apps first, then the open ones, each app once.
  const all = apps && [...added, ...apps].filter((a, i, list) => list.findIndex((b) => b.exe === a.exe) === i);

  const add = async () => {
    const path = await open({ title: "Add an app to focus with", defaultPath: START_MENU, filters: [{ name: "Apps", extensions: ["exe", "lnk"] }] }).catch(() => null);
    if (typeof path !== "string") return;
    try {
      const app = await invoke<FocusApp>("focus_app", { path });
      // Saved straight away: the island closes while the file dialog is open, taking this panel with it.
      const list = [app, ...stored<FocusApp[]>(FOCUS_ADDED_KEY, []).filter((a) => a.exe !== app.exe)];
      const chosen = [...new Set([...stored<string[]>(FOCUS_PICKED_KEY, []), app.exe])];
      save(FOCUS_ADDED_KEY, JSON.stringify(list));
      save(FOCUS_PICKED_KEY, JSON.stringify(chosen));
      setAdded(list);
      setPicked(chosen);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };
  const pick = (exe: string) => setPicked((p) => (p.includes(exe) ? p.filter((e) => e !== exe) : [...p, exe]));
  const start = () => {
    const ms = length ? parseDuration(length) : minutes * MIN;
    if (!ms) return setError("Try 50, 1:30 or 2h");
    const chosen = (all ?? []).filter((a) => picked.includes(a.exe));
    if (!chosen.length) return setError("Pick at least one app to work in");
    save(FOCUS_PICKED_KEY, JSON.stringify(chosen.map((a) => a.exe)));
    tools.focus(ms, chosen);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="no-scrollbar -mx-0.5 flex gap-1.5 overflow-x-auto px-0.5">
        {FOCUS_PRESETS.map((m) => (
          <Chip key={m} onClick={() => { setMinutes(m); setLength(""); }} active={!length && minutes === m}>{lengthText(m * MIN)}</Chip>
        ))}
        <Field value={length} onChange={setLength} onEnter={start} placeholder="Other: 50, 2h" className="w-28 shrink-0" />
      </div>
      <div ref={appsRef} className="no-scrollbar -mx-0.5 flex gap-1.5 overflow-x-auto px-0.5"
        onWheel={(e) => appsRef.current && (appsRef.current.scrollLeft += e.deltaY + e.deltaX)}>
        {all === null ? <span className="px-1 text-[11.5px] text-white/40">Looking at your open apps…</span>
          : all.map((a) => (
            <button key={a.exe} onClick={() => pick(a.exe)} aria-pressed={picked.includes(a.exe)}
              className={`flex h-8 shrink-0 items-center gap-1.5 rounded-full pr-3 pl-1.5 text-[12px] font-medium transition-colors ${picked.includes(a.exe) ? "bg-white text-black" : "bg-white/8 text-white/75 hover:bg-white/14"}`}>
              {a.icon ? <img src={a.icon} alt="" className="size-5" draggable={false} /> : <Icon name="code" size={16} />}
              <span className="max-w-28 truncate">{a.name}</span>
            </button>
          ))}
        <Chip onClick={add} tip="Add any app, open or not"><Icon name="plus" size={13} />Add app</Chip>
      </div>
      <div className="flex items-center gap-3 rounded-2xl bg-white/5 px-3 py-2.5">
        <div className="min-w-0 flex-1 text-[11.5px] text-white/45">
          {error ?? "Only the apps you pick stay open; others are minimised and Do Not Disturb is on until it ends."}
        </div>
        <Chip onClick={start} active>Start</Chip>
      </div>
    </div>
  );
}
