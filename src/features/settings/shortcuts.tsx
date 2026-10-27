// The global shortcuts, as people see them. Rust registers the same list (SHORTCUTS in
// src-tauri/src/lib.rs) and sends the action name as a "shortcut" event. Shown in Settings → Shortcuts.
import { Icon } from "../../components/icons";

export const SHORTCUTS = [
  { key: "Space", action: "Play / pause" },
  { key: "N", action: "Next song" },
  { key: "B", action: "Previous song" },
  { key: "I", action: "Open / close island" },
  { key: "L", action: "Music library" },
  { key: "F", action: "Radio" },
  { key: "T", action: "Timer" },
  { key: "V", action: "Clipboard history" },
  { key: "S", action: "Screenshots" },
  { key: "D", action: "Developer" },
];

function Key({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <kbd className={`grid h-6 shrink-0 place-items-center rounded-md bg-white/10 font-sans text-[11px] font-semibold text-white/90 ${wide ? "px-2" : "w-6"}`}
      style={{ boxShadow: "inset 0 -1px 0 rgb(255 255 255 / 0.1)" }}>
      {children}
    </kbd>
  );
}

export function ShortcutsView() {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2 px-1">
        <span className="text-white/50"><Icon name="keyboard" size={16} /></span>
        <div className="min-w-0 flex-1 text-[13px] font-semibold">Keyboard shortcuts</div>
        {/* Every shortcut starts with the same two keys, so they're said once. */}
        <span className="flex items-center gap-1 text-[11px] text-white/45">
          Hold <Key wide>Ctrl</Key> + <Key wide>Alt</Key> then
        </span>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        {SHORTCUTS.map((s) => (
          <div key={s.key} className="flex min-w-0 items-center gap-2.5 rounded-xl bg-white/5 px-2 py-1.5">
            <Key wide={s.key.length > 1}>{s.key}</Key>
            <span className="truncate text-[12px] text-white/75">{s.action}</span>
          </div>
        ))}
        <div className="flex min-w-0 items-center gap-2.5 rounded-xl bg-white/5 px-2 py-1.5">
          <Key wide>Shift</Key>
          <span className="truncate text-[12px] text-white/75">+ drag a file: convert</span>
        </div>
        <div className="flex min-w-0 items-center gap-2.5 rounded-xl bg-white/5 px-2 py-1.5">
          <Key wide>Ctrl</Key>
          <span className="truncate text-[12px] text-white/75">+ drag: pin to Bookshelf</span>
        </div>
      </div>
    </div>
  );
}
