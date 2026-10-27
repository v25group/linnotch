// The Settings tab: About (what linnotch is, its look, updates from src-tauri/src/update.rs), the
// keyboard shortcuts, and which tabs the dock shows.
// Updates install on their own by default, but only while the island is idle; the new version
// says "Update completed" when it starts.
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { motion } from "motion/react";
import { Icon, type IconName } from "../../components/icons";
import { useTip } from "../../components/tooltip";
import { load, save } from "../../lib/storage";
import { ShortcutsView } from "./shortcuts";
import { Switch, TabsPanel, type DockTabs, type HoverTab } from "./tabs";
import logo from "../../assets/linnotch.png";
import { Fox, Kit, KitEyes, type Skin, type useSkin } from "../../island/kit";

type Update = { version: string; notes: string; size: number };
type Status =
  | { kind: "idle" } | { kind: "checking" } | { kind: "latest" } | { kind: "error"; message: string }
  | { kind: "available"; update: Update } | { kind: "downloading"; update: Update; progress: number } | { kind: "installing" };

const AUTO_KEY = "island.autoUpdate";
const VERSION_KEY = "island.lastVersion";
const FIRST_CHECK_MS = 20_000;
const CHECK_EVERY_MS = 6 * 60 * 60_000;

const link = (url: string) => () => invoke("open_url", { url }).catch(() => {});

/** `idle` says whether now is a good moment to restart (island closed, nothing playing). */
export function useUpdater(idle: () => boolean, onUpdated: (version: string) => void) {
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [auto, setAuto] = useState(() => load(AUTO_KEY) !== "0");
  const ready = useRef({ idle, auto });
  ready.current = { idle, auto };

  // A version different from last run's means an update just landed (by us or by hand).
  useEffect(() => {
    const last = load(VERSION_KEY);
    save(VERSION_KEY, __APP_VERSION__);
    if (last && last !== __APP_VERSION__) onUpdated(__APP_VERSION__);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const check = useCallback(async () => {
    setStatus((s) => (s.kind === "downloading" || s.kind === "installing" ? s : { kind: "checking" }));
    try {
      const update = await invoke<Update | null>("update_check");
      setStatus((s) => (s.kind === "downloading" || s.kind === "installing" ? s : update ? { kind: "available", update } : { kind: "latest" }));
    } catch (e) {
      setStatus({ kind: "error", message: String(e) });
    }
  }, []);

  const install = useCallback(async (update: Update) => {
    setStatus({ kind: "downloading", update, progress: 0 });
    const off = await listen<number>("update-progress", (e) => setStatus({ kind: "downloading", update, progress: e.payload }));
    try {
      await invoke("update_install");
      setStatus({ kind: "installing" }); // the installer closes the island from here
    } catch (e) {
      setStatus({ kind: "error", message: String(e) });
    } finally {
      off();
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(check, FIRST_CHECK_MS);
    const every = setInterval(check, CHECK_EVERY_MS);
    return () => { clearTimeout(first); clearInterval(every); };
  }, [check]);

  // Automatic installs wait for a quiet moment, checked once a minute.
  const pending = status.kind === "available" ? status.update : null;
  useEffect(() => {
    if (!pending) return;
    const tryNow = () => ready.current.auto && ready.current.idle() && install(pending);
    tryNow();
    const id = setInterval(tryNow, 60_000);
    return () => clearInterval(id);
  }, [pending, install]);

  const toggleAuto = () => setAuto((on) => {
    save(AUTO_KEY, on ? "0" : "1");
    return !on;
  });
  return { status, auto, toggleAuto, check, install };
}
export type Updater = ReturnType<typeof useUpdater>;

/** "Update completed": centred like the download pop-up, with Kit happy beside the title. */
export function UpdateFlash({ version }: { version: string }) {
  return (
    <div className="flex h-15 flex-col items-center justify-center gap-0.5 px-5 text-center">
      <div className="flex items-center gap-1.5 text-[13.5px] font-semibold">
        <Kit mood="happy" size={18} />
        Update completed
      </div>
      <div className="max-w-full truncate text-[11.5px] text-white/55">linnotch {version} is ready</div>
    </div>
  );
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function UpdateCard({ updater }: { updater: Updater }) {
  const { status: s, auto, toggleAuto, check, install } = updater;
  const busy = s.kind === "checking" || s.kind === "downloading" || s.kind === "installing";
  const [icon, color, title, hint]: [IconName, string, string, string] =
    s.kind === "available" ? ["download", "#4fd18b", `linnotch ${s.update.version} is available`, `${mb(s.update.size)} · signed by V25Group`]
    : s.kind === "downloading" ? ["download", "#4fd18b", `Downloading ${s.update.version}…`, `${Math.round(s.progress * 100)}% of ${mb(s.update.size)}`]
    : s.kind === "installing" ? ["loading", "#4fd18b", "Installing…", "linnotch restarts in a moment"]
    : s.kind === "checking" ? ["loading", "rgb(255 255 255 / 0.6)", "Checking for updates…", "Looking at GitHub releases"]
    : s.kind === "latest" ? ["check", "#4fd18b", "You're up to date", `linnotch ${__APP_VERSION__} is the newest version`]
    : s.kind === "error" ? ["alert", "#ff6b6b", "Couldn't update", s.message]
    : ["refresh", "rgb(255 255 255 / 0.6)", "Updates", auto ? "Checked every few hours, installed when you're idle" : "Check whenever you like"];

  return (
    <div className="flex flex-col gap-2.5 rounded-2xl bg-white/5 p-2.5">
      <div className="flex items-center gap-2.5 px-1">
        <motion.span className="grid size-8 shrink-0 place-items-center rounded-full bg-white/8" style={{ color }}
          animate={busy && s.kind !== "downloading" ? { rotate: 360 } : { rotate: 0 }}
          transition={busy && s.kind !== "downloading" ? { repeat: Infinity, duration: 1, ease: "linear" } : { duration: 0 }}>
          <Icon name={icon} size={16} />
        </motion.span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12.5px] font-medium">{title}</div>
          <div className="truncate text-[11px] text-white/40">{hint}</div>
        </div>
        {s.kind === "available" ? (
          <button onClick={() => install(s.update)} className="flex h-7 shrink-0 items-center rounded-full bg-white px-3 text-[12px] font-semibold text-black hover:brightness-90">
            Install now
          </button>
        ) : !busy && (
          <button onClick={check} className="flex h-7 shrink-0 items-center rounded-full bg-white/10 px-3 text-[12px] font-medium hover:bg-white/18">
            Check
          </button>
        )}
      </div>
      {s.kind === "downloading" && (
        <div className="mx-1 h-1 overflow-hidden rounded-full bg-white/10">
          <motion.div className="h-full rounded-full bg-[#4fd18b]" animate={{ width: `${s.progress * 100}%` }} transition={{ duration: 0.2 }} />
        </div>
      )}
      <button role="switch" aria-checked={auto} onClick={toggleAuto} className="flex items-center gap-2.5 px-1 text-left">
        <span className="min-w-0 flex-1 text-[11.5px] text-white/60">Install updates automatically</span>
        <span className={`relative h-4.5 w-8 shrink-0 rounded-full transition-colors ${auto ? "bg-[#4fd18b]" : "bg-white/15"}`}>
          <motion.span className="absolute top-0.5 size-3.5 rounded-full bg-white" animate={{ left: auto ? 16 : 2 }} transition={{ type: "spring", stiffness: 500, damping: 34 }} />
        </span>
      </button>
    </div>
  );
}

const SKINS: { id: Skin; label: string; hint: string }[] = [
  { id: "kit", label: "Kit", hint: "The fox, linnotch's own" },
  { id: "eyes", label: "Eyes", hint: "Just Kit's eyes, following your mouse" },
];

/** Start with Windows: the same setting as the tray menu's check (src-tauri/src/lib.rs keeps them in step). */
function StartupRow() {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => void invoke<boolean>("startup_get").then(setOn).catch(() => {}), []);
  const flip = () => invoke<boolean>("startup_set", { on: !on }).then(setOn).catch(() => {});
  return (
    <div className="flex items-center gap-2.5 rounded-2xl bg-white/5 px-3.5 py-2">
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] font-medium">Start with Windows</div>
        <div className="truncate text-[11px] text-white/40">Open linnotch by itself when you sign in</div>
      </div>
      <Switch on={!!on} disabled={on === null} onClick={flip} label="Start with Windows" />
    </div>
  );
}

/** Who lives in the resting notch. Each choice is a live preview. */
function LookOption({ skin, option }: { skin: ReturnType<typeof useSkin>; option: (typeof SKINS)[number] }) {
  const on = skin.skin === option.id;
  return (
    <button onClick={() => skin.choose(option.id)} aria-pressed={on} {...useTip(option.hint)}
      className={`flex items-center gap-2 rounded-xl py-1 pr-3 pl-1 transition-colors ${on ? "bg-white/12 ring-1 ring-white/30" : "bg-white/4 hover:bg-white/8"}`}>
      <span className="grid h-7 w-11 shrink-0 place-items-center rounded-lg bg-black">
        {option.id === "kit" ? <Fox mood="idle" size={20} /> : <KitEyes mood="idle" />}
      </span>
      <span className="text-[12px] font-medium">{option.label}</span>
    </button>
  );
}

/** Who lives in the resting notch, in one row. Each choice is a live preview. */
function LookCard({ skin }: { skin: ReturnType<typeof useSkin> }) {
  return (
    <div className="flex items-center gap-2 rounded-2xl bg-white/5 py-1.5 pr-1.5 pl-3.5">
      <div className="min-w-0 flex-1 text-[12.5px] font-medium">Look</div>
      {SKINS.map((s) => <LookOption key={s.id} skin={skin} option={s} />)}
    </div>
  );
}

function AboutPane({ updater, skin }: { updater: Updater; skin: ReturnType<typeof useSkin> }) {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-3 px-1">
        <img src={logo} alt="" className="size-11 shrink-0 rounded-xl" draggable={false} />
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-semibold">linnotch</div>
          <div className="truncate text-[11.5px] text-white/45">A Dynamic Island for Windows · version {__APP_VERSION__}</div>
        </div>
      </div>
      <UpdateCard updater={updater} />
      <StartupRow />
      <LookCard skin={skin} />
      {/* Who makes it, where to report things, and the credit Open-Meteo asks for. */}
      <div className="flex items-center gap-1.5 px-1 text-[10.5px] text-white/35">
        <span>by</span>
        <button onClick={link("https://www.v25group.com/")} className="hover:text-white/75">V25Group</button>
        <span>·</span>
        <button onClick={link("https://github.com/v25group/linnotch")} className="hover:text-white/75">GitHub</button>
        <span>·</span>
        <button onClick={link("https://github.com/v25group/linnotch/issues")} className="hover:text-white/75">Report an issue</button>
        <span className="flex-1" />
        <span>MIT · Weather by Open-Meteo</span>
      </div>
    </div>
  );
}

type Pane = "about" | "shortcuts" | "tabs";
const PANES: { id: Pane; label: string }[] = [{ id: "about", label: "About" }, { id: "shortcuts", label: "Shortcuts" }, { id: "tabs", label: "Tabs" }];

export function SettingsView({ updater, skin, tabs, onOpenTab }: {
  updater: Updater; skin: ReturnType<typeof useSkin>; tabs: DockTabs; onOpenTab: (id: HoverTab) => void;
}) {
  const [pane, setPane] = useState<Pane>("about");
  const ready = updater.status.kind === "available";
  return (
    <div className="flex flex-col gap-2.5">
      {/* The same pills as the Developer tab. */}
      <div className="flex gap-1 px-1">
        {PANES.map((p) => (
          <button key={p.id} onClick={() => setPane(p.id)}
            className={`relative flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium transition-colors ${pane === p.id ? "text-black" : "bg-white/8 text-white/70 hover:bg-white/14"}`}>
            {pane === p.id && <motion.span layoutId="about-pane" className="absolute inset-0 rounded-full bg-white" transition={{ type: "spring", stiffness: 500, damping: 36 }} />}
            <span className="relative">{p.label}</span>
            {p.id === "about" && ready && <span className="relative size-1.5 rounded-full bg-[#4fd18b]" />}
          </button>
        ))}
      </div>
      {pane === "about" ? <AboutPane updater={updater} skin={skin} /> : pane === "shortcuts" ? <ShortcutsView /> : <TabsPanel tabs={tabs} onOpen={onOpenTab} />}
    </div>
  );
}
