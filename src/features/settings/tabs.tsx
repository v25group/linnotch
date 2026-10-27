// Which tabs the dock shows (Settings → Tabs). Hidden tabs still open from that list, and from their
// shortcuts. Settings always stays (the list lives in it), and at least MIN_TABS stay in the dock.
// The Developer tab's switch is useDevEnabled (src/features/developer/dev.tsx), which also stops
// its background work.
import { useState } from "react";
import { motion } from "motion/react";
import { Icon, type IconName } from "../../components/icons";
import { load, save } from "../../lib/storage";

export type HoverTab = "today" | "music" | "library" | "radio" | "timer" | "clipboard" | "notifications" | "shelf" | "notes" | "pins" | "dev" | "settings";

export const DOCK: { id: HoverTab; icon: IconName; label: string }[] = [
  { id: "today", icon: "controls", label: "Today" },
  { id: "music", icon: "audio", label: "Now playing" },
  { id: "library", icon: "library", label: "Library" },
  { id: "radio", icon: "radio", label: "Radio" },
  { id: "timer", icon: "timer", label: "Timer" },
  { id: "clipboard", icon: "clipboard", label: "Clipboard" },
  { id: "notes", icon: "note", label: "Quick note" },
  { id: "notifications", icon: "bell", label: "Notifications" },
  { id: "shelf", icon: "shelf", label: "Screenshots" },
  { id: "pins", icon: "bookshelf", label: "Bookshelf" },
  { id: "dev", icon: "code", label: "Developer" },
  { id: "settings", icon: "settings", label: "Settings" },
];

const KEY = "island.hiddenTabs"; // hidden rather than shown, so tabs added later appear by themselves
const HIDDEN_AT_FIRST: HoverTab[] = ["pins"];
export const MIN_TABS = 4;

export function useDockTabs(dev: { on: boolean; toggle: () => void }) {
  const [hidden, setHidden] = useState<HoverTab[]>(() => {
    try {
      return JSON.parse(load(KEY) ?? "null") ?? HIDDEN_AT_FIRST;
    } catch {
      return HIDDEN_AT_FIRST;
    }
  });
  const shown = (id: HoverTab) => (id === "dev" ? dev.on : !hidden.includes(id));
  const count = DOCK.filter((t) => shown(t.id)).length;
  /** Whether its switch can be flipped: Settings can't go, and the dock keeps MIN_TABS. */
  const canToggle = (id: HoverTab) => id !== "settings" && (!shown(id) || count > MIN_TABS);
  const toggle = (id: HoverTab) => {
    if (!canToggle(id)) return;
    if (id === "dev") return dev.toggle();
    const next = shown(id) ? [...hidden, id] : hidden.filter((h) => h !== id);
    save(KEY, JSON.stringify(next));
    setHidden(next);
  };
  return { shown, count, canToggle, toggle };
}
export type DockTabs = ReturnType<typeof useDockTabs>;

export function Switch({ on, disabled, onClick, label }: { on: boolean; disabled: boolean; onClick: () => void; label: string }) {
  return (
    <button role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={onClick}
      className={`relative h-4.5 w-8 shrink-0 rounded-full transition-colors disabled:opacity-35 ${on ? "bg-[#4fd18b]" : "bg-white/15"}`}>
      <motion.span className="absolute top-0.5 size-3.5 rounded-full bg-white" animate={{ left: on ? 16 : 2 }} transition={{ type: "spring", stiffness: 500, damping: 34 }} />
    </button>
  );
}

/** Every tab: its name opens it (hidden or not), its switch puts it in or out of the dock. */
export function TabsPanel({ tabs, onOpen }: { tabs: DockTabs; onOpen: (id: HoverTab) => void }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="grid grid-cols-2 gap-1">
        {DOCK.map((t) => (
          <div key={t.id} className="flex h-9 items-center gap-1 rounded-xl bg-white/5 pr-2.5">
            <button onClick={() => onOpen(t.id)} className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-xl pl-2.5 text-left hover:bg-white/6">
              <span className={tabs.shown(t.id) ? "text-white/85" : "text-white/40"}><Icon name={t.icon} size={15} /></span>
              <span className={`truncate text-[12px] ${tabs.shown(t.id) ? "text-white/85" : "text-white/45"}`}>{t.label}</span>
            </button>
            <Switch on={tabs.shown(t.id)} disabled={!tabs.canToggle(t.id)} onClick={() => tabs.toggle(t.id)}
              label={`${t.label} in the dock`} />
          </div>
        ))}
      </div>
      <div className="px-1 text-[11px] text-white/40">
        Tap a name to open it, even if it's hidden. At least {MIN_TABS} tabs stay in the dock.
      </div>
    </div>
  );
}
