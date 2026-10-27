// Bookshelf tab: apps, folders and files pinned to open in one click, without searching
// (src-tauri/src/pins.rs). Pinned with Add or by Ctrl+dropping onto the island; kept in localStorage.
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { motion } from "motion/react";
import { Icon, type IconName } from "../../components/icons";
import { useTip } from "../../components/tooltip";
import { load, save } from "../../lib/storage";
import { Kit } from "../../island/kit";

export type Pin = { path: string; name: string; kind: "app" | "folder" | "file"; icon?: string | null };

const KEY = "island.pins";
const FALLBACK: Record<Pin["kind"], IconName> = { app: "bolt", folder: "folder", file: "file" };

function stored(): Pin[] {
  try {
    return JSON.parse(load(KEY) ?? "[]");
  } catch {
    return [];
  }
}

export function usePins() {
  const [pins, setPins] = useState<Pin[]>(stored);
  const keep = (list: Pin[]) => (save(KEY, JSON.stringify(list)), setPins(list));
  /** Pins the paths not pinned yet; resolves to how many were added. */
  const add = useCallback(async (paths: string[]) => {
    const found = await Promise.all(paths.map((path) => invoke<Pin>("pin_info", { path }).catch(() => null)));
    const list = stored();
    const fresh = found.filter((p): p is Pin => !!p && !list.some((q) => q.path.toLowerCase() === p.path.toLowerCase()));
    keep([...list, ...fresh]);
    return fresh.length;
  }, []);
  const remove = useCallback((path: string) => keep(stored().filter((p) => p.path !== path)), []);
  // Once per start, fresh pictures: a photo or song changed, or pinned before previews existed.
  useEffect(() => {
    Promise.all(stored().map((p) => invoke<Pin>("pin_info", { path: p.path }).catch(() => p)))
      .then((fresh) => keep(stored().map((p) => ({ ...p, icon: fresh.find((f) => f.path === p.path)?.icon ?? p.icon }))));
  }, []);
  return { pins, add, remove };
}
export type Pins = ReturnType<typeof usePins>;

/** "Z:\Users\me\Pictures\Works\a.jpg" -> "…\Pictures\Works": the last two folders say enough. */
function folderOf(path: string) {
  const parts = path.split(/[\\/]/).slice(0, -1);
  return parts.length > 3 ? `…\\${parts.slice(-2).join("\\")}` : parts.join("\\") || path;
}

function Tile({ pin, onRemove, onError }: { pin: Pin; onRemove: () => void; onError: (e: string) => void }) {
  return (
    <div className="group relative">
      <button onClick={() => invoke("pin_open", { path: pin.path }).catch((e) => onError(`${pin.name}: ${e}`))}
        {...useTip(`${pin.name}\nin ${folderOf(pin.path)}`)}
        className="flex w-full flex-col items-center gap-1.5 rounded-2xl px-1 pt-2.5 pb-2 transition-colors hover:bg-white/8 active:scale-[0.97]">
        {pin.icon && pin.kind === "file" ? <img src={pin.icon} alt="" className="size-10 rounded-lg object-cover" draggable={false} />
          : pin.icon ? <img src={pin.icon} alt="" className="size-8" draggable={false} />
          : <span className="grid size-8 place-items-center text-white/70"><Icon name={FALLBACK[pin.kind]} size={24} /></span>}
        <span className="w-full truncate text-center text-[11.5px] text-white/80">{pin.name}</span>
      </button>
      <button onClick={() => invoke("reveal", { path: pin.path }).catch((e) => onError(`${pin.name}: ${e}`))} aria-label={`Show ${pin.name} in its folder`}
        {...useTip("Show in folder")}
        className="absolute top-0.5 left-0.5 grid size-5 place-items-center rounded-full bg-white/15 text-white/70 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-white/25 hover:text-white">
        <Icon name="folder" size={10} />
      </button>
      <button onClick={onRemove} aria-label={`Unpin ${pin.name}`} {...useTip("Unpin")}
        className="absolute top-0.5 right-0.5 grid size-5 place-items-center rounded-full bg-white/15 text-white/70 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-white/25 hover:text-white">
        <Icon name="close" size={10} />
      </button>
    </div>
  );
}

function AddButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className="flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-white/10 px-3 text-[12px] font-medium hover:bg-white/18">
      {children}
    </button>
  );
}

export function PinsView({ pins }: { pins: Pins }) {
  const [error, setError] = useState<string | null>(null);
  const pick = async (directory: boolean) => {
    const picked = await open({ directory, multiple: true, title: directory ? "Pin folders" : "Pin apps or files" }).catch(() => null);
    const paths = picked === null ? [] : Array.isArray(picked) ? picked : [picked];
    if (paths.length) await pins.add(paths);
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 px-1">
        <span className="text-white/50"><Icon name="bookshelf" size={16} /></span>
        <div className="min-w-0 flex-1 text-[13px] font-semibold">Bookshelf</div>
        <AddButton onClick={() => pick(false)}><Icon name="plus" size={13} />App or file</AddButton>
        <AddButton onClick={() => pick(true)}><Icon name="plus" size={13} />Folder</AddButton>
      </div>
      {pins.pins.length === 0 ? (
        <div className="flex h-24 flex-col items-center justify-center gap-1 text-center text-[12.5px] text-white/50">
          <Kit mood="idle" size={26} />
          <div>Nothing pinned yet.</div>
          <div className="text-[11.5px] text-white/35">Hold Ctrl and drag an app, folder or file onto the island, or use Add.</div>
        </div>
      ) : (
        <div className="no-scrollbar grid max-h-56 grid-cols-5 gap-1 overflow-y-auto" onWheel={(e) => e.stopPropagation()}>
          {pins.pins.map((p) => <Tile key={p.path} pin={p} onRemove={() => pins.remove(p.path)} onError={setError} />)}
        </div>
      )}
      {error && <div className="truncate px-1 text-[11px] text-[#ff6b6b]">{error}</div>}
    </div>
  );
}

/** While something is Ctrl+dragged over the island. */
export function PinDropView({ count }: { count: number }) {
  return (
    <div className="flex h-24 flex-col items-center justify-center gap-1.5 text-center">
      <motion.span className="text-white/85" initial={{ y: -8, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ type: "spring", stiffness: 400, damping: 18 }}>
        <Icon name="pin" size={26} />
      </motion.span>
      <div className="text-[13.5px] font-semibold">Drop to pin {count > 1 ? `these ${count}` : "it"} to the Bookshelf</div>
      <div className="text-[11.5px] text-white/45">Then open it from the Bookshelf tab in one click</div>
    </div>
  );
}
