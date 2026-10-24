// "Open with": drag a file or folder onto the island and drop it on an app. With Shift held the
// same row shows the formats the file converts to instead.
// Rust (src-tauri/src/openwith.rs) lists the apps with their icons and launches the chosen one.
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { motion } from "motion/react";
import { Icon, type IconName } from "../../components/icons";
import appIcon from "../../assets/linnotch.png";

export type App = { id: string; name: string; icon: string | null };

/** The apps for `path`, cached per path for the session (icons take a moment to extract). */
export function useOpenWith(path: string | null) {
  const [apps, setApps] = useState<App[] | null>(null);
  const cache = useRef(new Map<string, App[]>());
  useEffect(() => {
    if (!path) return;
    const cached = cache.current.get(path);
    if (cached) return setApps(cached);
    setApps(null);
    let live = true;
    invoke<App[]>("apps_for", { path })
      .then((found) => {
        cache.current.set(path, found);
        if (live) setApps(found);
      })
      .catch(() => live && setApps([]));
    return () => {
      live = false;
    };
  }, [path]);
  return apps;
}

/** The app tile under a point (CSS px), from its data-app attribute. */
export function appAt(x: number, y: number) {
  return document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-app]")?.dataset.app ?? null;
}

// Same list as PLAYABLE in src-tauri/src/library.rs.
const PLAYABLE = /\.(mp3|m4a|aac|wav|flac|ogg|opus|oga|webm)$/i;
export const ISLAND_PLAYER = "island:play";
// Same list as TEXT in src-tauri/src/notes.rs.
const TEXT = /(\.(txt|md|markdown|log|json|jsonc|csv|tsv|ini|cfg|conf|ya?ml|toml|xml|env|gitignore|sql|srt)|[\\/]\.(env|gitignore))$/i;
export const ISLAND_NOTES = "island:notes";

/** Songs get the island's own player as the first choice, text files its notes. */
export function withIslandPlayer(apps: App[] | null, paths: string[]) {
  if (!apps) return apps;
  if (paths.some((p) => PLAYABLE.test(p))) return [{ id: ISLAND_PLAYER, name: "linnotch", icon: appIcon }, ...apps];
  if (paths.length === 1 && TEXT.test(paths[0])) return [{ id: ISLAND_NOTES, name: "linnotch notes", icon: appIcon }, ...apps];
  return apps;
}

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

function AppIcon({ app }: { app: App }) {
  if (app.icon) return <img src={app.icon} alt="" className="size-10 object-contain" draggable={false} />;
  return (
    <span className="grid size-10 place-items-center rounded-xl bg-white/10 text-white/70">
      {app.name === "Terminal" ? <Icon name="terminal" size={22} /> : <span className="text-[16px] font-semibold">{app.name[0]}</span>}
    </span>
  );
}

const EDGE = 64; // px from either end of the row where a held file scrolls it
const EDGE_SPEED = 10; // px per frame at the very edge

/** A format the dragged file can be converted to; dropping on it starts the conversion. */
export type Format = { id: string; label: string; note: string };
export const CONVERT = "convert:"; // drop-target ids of format tiles start with this

/** One row of drop targets (elements with data-app). While a file is held over it, nearing the
    left or right end scrolls the row that way (faster closer to the edge); the wheel scrolls it too. */
function DropRow({ point, count, children }: {
  point: { x: number; y: number } | null; count: number; children: (hot: string | null) => React.ReactNode;
}) {
  const row = useRef<HTMLDivElement>(null);
  const at = useRef(point);
  at.current = point;
  const [hot, setHot] = useState<string | null>(null);
  const [fade, setFade] = useState({ left: false, right: false });

  // Which tile is under the cursor and which ends have more tiles; both change with scrolling too.
  const refresh = useCallback(() => {
    const el = row.current;
    if (el) {
      const next = { left: el.scrollLeft > 1, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1 };
      // Same values -> same object, so React skips the re-render (refresh runs every scroll frame).
      setFade((f) => (f.left === next.left && f.right === next.right ? f : next));
    }
    setHot(at.current ? appAt(at.current.x, at.current.y) : null);
  }, []);
  // The point and item arrays are new on every render; depend on plain values so this can't loop.
  useEffect(refresh, [point?.x, point?.y, count, refresh]);

  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const el = row.current;
      const p = at.current;
      if (el && p) {
        const r = el.getBoundingClientRect();
        // Only the row the file is on scrolls, not its neighbour.
        if (p.y > r.top - 6 && p.y < r.bottom + 6) {
          const push = p.x < r.left + EDGE ? -(r.left + EDGE - p.x) / EDGE : p.x > r.right - EDGE ? (p.x - (r.right - EDGE)) / EDGE : 0;
          if (push) {
            el.scrollLeft += Math.max(-1, Math.min(1, push)) * EDGE_SPEED;
            refresh();
          }
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [refresh]);

  const ghost = "rgb(0 0 0 / 0.2)";
  const mask = `linear-gradient(to right, ${fade.left ? `${ghost}, #000 ${EDGE}px` : "#000"}, ${fade.right ? `#000 calc(100% - ${EDGE}px), ${ghost}` : "#000"})`;
  return (
    <div ref={row} className="no-scrollbar -mx-1 flex gap-1 overflow-x-auto px-1 py-0.5" style={{ maskImage: mask }}
      onScroll={refresh} onWheel={(e) => row.current && (row.current.scrollLeft += e.deltaY + e.deltaX)}>
      {children(hot)}
    </div>
  );
}

/** A drop tile that lifts while the file is over it. */
function Target({ id, hot, index, children }: { id: string; hot: string | null; index: number; children: React.ReactNode }) {
  return (
    <motion.div data-app={id}
      className="flex w-[76px] shrink-0 flex-col items-center gap-1.5 rounded-2xl px-1 pt-2.5 pb-2 transition-colors"
      style={{ background: hot === id ? "rgb(255 255 255 / 0.13)" : undefined }}
      initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: hot === id ? 1.08 : 1 }}
      transition={{ type: "spring", stiffness: 500, damping: 28, delay: hot ? 0 : index * 0.02 }}>
      {children}
    </motion.div>
  );
}

function Header({ icon, before, label, after, accent }: { icon: IconName; before: string; label: string; after: string; accent?: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <span style={{ color: accent ?? "rgb(255 255 255 / 0.55)" }}><Icon name={icon} size={18} /></span>
      <div className="min-w-0 flex-1 truncate text-[13px]">
        <span className="text-white/50">{before}</span>
        <span className="font-semibold">{label}</span>
        <span className="text-white/50">{after}</span>
      </div>
    </div>
  );
}

const Empty = ({ children }: { children: React.ReactNode }) => (
  <div className="flex h-[86px] items-center justify-center gap-2 text-[12.5px] text-white/50">{children}</div>
);

const Finding = ({ what }: { what: string }) => (
  <Empty>
    <motion.span animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1, ease: "linear" }} className="grid">
      <Icon name="loading" size={16} />
    </motion.span>
    Finding {what}…
  </Empty>
);

export const looksLikeFile = (p = "") => /\.[^\\/.]+$/.test(p);

/** The apps the dragged item can open in: drop on a tile to open it there. */
export function OpenWithView({ paths, apps, point }: { paths: string[]; apps: App[] | null; point: { x: number; y: number } | null }) {
  const first = paths[0] ?? "";
  const label = paths.length > 1 ? `${baseName(first)} + ${paths.length - 1} more` : baseName(first);
  return (
    <div className="flex flex-col gap-3 p-3.5">
      <div className="flex items-center gap-2.5">
        <div className="min-w-0 flex-1"><Header icon={looksLikeFile(first) ? "file" : "folder"} before="Open " label={label} after=" with" /></div>
        {looksLikeFile(first) && <span className="shrink-0 rounded-full bg-white/8 px-2 py-0.5 text-[10.5px] text-white/45">Hold Shift to convert</span>}
      </div>
      {apps === null ? <Finding what="apps" /> : apps.length === 0 ? <Empty>No apps found for this item.</Empty> : (
        <DropRow point={point} count={apps.length}>
          {(hot) => apps.map((app, i) => (
            <Target key={app.id} id={app.id} hot={hot} index={i}>
              <AppIcon app={app} />
              <span className={`w-full truncate text-center text-[11px] ${hot === app.id ? "text-white" : "text-white/65"}`}>{app.name}</span>
            </Target>
          ))}
        </DropRow>
      )}
    </div>
  );
}

/** Shift held: the formats the dragged file converts to, as the same kind of row; drop on one to convert. */
export function ConvertView({ paths, formats, point, accent, busy }: {
  paths: string[]; formats: Format[] | null; point: { x: number; y: number } | null; accent: string; busy: boolean;
}) {
  const first = paths[0] ?? "";
  return (
    <div className="flex flex-col gap-3 p-3.5">
      <Header icon="convert" accent={accent} before="Convert " label={baseName(first)} after=" to" />
      {busy ? <Empty>Wait for the current conversion to finish.</Empty>
        : paths.length > 1 ? <Empty>Drop one file at a time to convert it.</Empty>
        : formats === null ? <Finding what="formats" />
        : formats.length === 0 ? <Empty>This file type can't be converted yet.</Empty> : (
        <DropRow point={point} count={formats.length}>
          {(hot) => formats.map((f, i) => {
            const id = CONVERT + f.id;
            return (
              <Target key={id} id={id} hot={hot} index={i}>
                <span className="grid h-10 w-full place-items-center rounded-xl text-[12.5px] font-bold"
                  style={{ color: accent, background: `color-mix(in srgb, ${accent} 14%, transparent)` }}>
                  {f.label}
                </span>
                <span className={`w-full truncate text-center text-[10.5px] ${hot === id ? "text-white" : "text-white/50"}`}>{f.note}</span>
              </Target>
            );
          })}
        </DropRow>
      )}
    </div>
  );
}
