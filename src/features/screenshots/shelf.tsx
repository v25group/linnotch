// The screenshot shelf (src-tauri/src/screenshots.rs): new screenshots pop up in the notch, and
// the shelf keeps the recent ones to drag into any app, copy, open or find in their folder.
import { useEffect, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { startDrag } from "@crabnebula/tauri-plugin-drag";
import { motion } from "motion/react";
import { Icon, type IconName } from "../../components/icons";
import { ago, useNow } from "../../island/system";
import { useTip } from "../../components/tooltip";
import { Kit } from "../../island/kit";

export type Shot = { path: string; at: number };

/** True while we're dragging a file out of the island, so our own drop target ignores it. */
export const draggingOut = { current: false };

export function dragOut(path: string) {
  draggingOut.current = true;
  const done = () => (draggingOut.current = false);
  startDrag({ item: [path], icon: path }, done).catch(done);
}

/** Starts a drag once the pointer has moved a few px with the button held; a plain click calls onClick. */
function useDragOrClick(path: string, onClick?: () => void) {
  const start = useRef<{ x: number; y: number } | null>(null);
  return {
    onPointerDown: (e: React.PointerEvent) => (start.current = { x: e.clientX, y: e.clientY }),
    onPointerMove: (e: React.PointerEvent) => {
      if (start.current && Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > 5) {
        start.current = null;
        dragOut(path);
      }
    },
    onPointerUp: () => {
      if (start.current) onClick?.();
      start.current = null;
    },
    onPointerLeave: () => (start.current = null),
    draggable: false,
  };
}

export function useShelf(onNew: (shot: Shot) => void) {
  const [shots, setShots] = useState<Shot[]>([]);
  const announce = useRef(onNew);
  announce.current = onNew;
  useEffect(() => {
    invoke<Shot[]>("screenshots").then(setShots).catch(() => {});
    const off = listen<Shot>("screenshot", (e) => {
      setShots((list) => [e.payload, ...list.filter((s) => s.path !== e.payload.path)].slice(0, 24));
      announce.current(e.payload);
    });
    return () => void off.then((f) => f());
  }, []);
  return shots;
}

const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;
// The file can be re-saved under the same name; the timestamp keeps the preview fresh.
const src = (s: Shot) => `${convertFileSrc(s.path)}?t=${s.at}`;

function ShotButton({ icon, tip, onClick }: { icon: IconName; tip: string; onClick: () => void }) {
  return (
    <button aria-label={tip} {...useTip(tip)}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="grid size-7 place-items-center rounded-full bg-black/60 text-white/85 backdrop-blur-sm hover:bg-black/80 hover:text-white">
      <Icon name={icon} size={13} />
    </button>
  );
}

const copyShot = (s: Shot) => invoke("screenshot_copy", { path: s.path });
const openShot = (s: Shot) => invoke("screenshot_open", { path: s.path });
const revealShot = (s: Shot) => invoke("reveal", { path: s.path });

function Thumb({ shot, now }: { shot: Shot; now: number }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="group relative w-32 shrink-0">
      <div {...useDragOrClick(shot.path, () => openShot(shot))}
        className="h-20 w-32 cursor-grab overflow-hidden rounded-xl bg-white/5 active:cursor-grabbing"
        style={{ boxShadow: "inset 0 0 0 1px rgb(255 255 255 / 0.08)" }}>
        <img src={src(shot)} alt="" className="size-full object-cover transition-transform duration-300 group-hover:scale-105" draggable={false} />
      </div>
      <div className="pointer-events-none absolute inset-x-0 top-0 flex h-20 items-end justify-center gap-1 pb-1.5 opacity-0 transition-opacity group-hover:opacity-100">
        <span className="pointer-events-auto flex gap-1">
          <ShotButton icon={copied ? "check" : "copy"} tip="Copy image"
            onClick={() => copyShot(shot).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1400);
            })} />
          <ShotButton icon="external" tip="Open" onClick={() => openShot(shot)} />
          <ShotButton icon="folder" tip="Show in folder" onClick={() => revealShot(shot)} />
        </span>
      </div>
      <div className="mt-1 truncate px-0.5 text-[10.5px] text-white/40">{ago(shot.at, now)}</div>
    </div>
  );
}

export function ShelfView({ shots }: { shots: Shot[] }) {
  const now = useNow(30_000);
  const row = useRef<HTMLDivElement>(null);
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2 px-1">
        <span className="text-white/50"><Icon name="shelf" size={16} /></span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold">Screenshots</div>
          <div className="text-[11px] text-white/40">Drag one into any app · click to open</div>
        </div>
        {shots[0] && (
          <button onClick={() => revealShot(shots[0])}
            className="flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-white/10 px-3 text-[12px] font-medium hover:bg-white/18">
            <Icon name="folder" size={13} />Folder
          </button>
        )}
      </div>
      {shots.length === 0 ? (
        <div className="flex h-24 flex-col items-center justify-center gap-1 text-center text-[12.5px] text-white/50">
          <Kit mood="idle" size={26} />
          <div>No screenshots yet.</div>
          <div className="text-[11.5px] text-white/35">Press Win+Shift+S or Win+PrtScn and they land here.</div>
        </div>
      ) : (
        <div ref={row} className="no-scrollbar -mx-1 flex gap-2 overflow-x-auto px-1"
          onWheel={(e) => row.current && (row.current.scrollLeft += e.deltaY + e.deltaX)}>
          {shots.map((s) => <Thumb key={s.path + s.at} shot={s} now={now} />)}
        </div>
      )}
    </div>
  );
}

/** The pop-up for a new screenshot. */
export function ShotFlash({ shot }: { shot: Shot }) {
  return (
    <div className="flex h-16 items-center gap-3 px-3">
      <motion.img src={src(shot)} alt="" className="h-11 w-18 shrink-0 rounded-lg object-cover" draggable={false}
        initial={{ scale: 1.6, opacity: 0, rotate: -4 }} animate={{ scale: 1, opacity: 1, rotate: 0 }} transition={{ type: "spring", stiffness: 300, damping: 22 }} />
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-semibold">Screenshot saved</div>
        <div className="truncate text-[12px] text-white/55">Hover to copy, open or drag it out</div>
      </div>
    </div>
  );
}

/** Hovering the screenshot pop-up: a bigger, draggable preview with its actions. */
export function ShotCard({ shot }: { shot: Shot }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-3 p-3.5">
      <div {...useDragOrClick(shot.path, () => openShot(shot))}
        className="cursor-grab overflow-hidden rounded-2xl bg-white/5 active:cursor-grabbing" style={{ boxShadow: "inset 0 0 0 1px rgb(255 255 255 / 0.08)" }}>
        <img src={src(shot)} alt="" className="max-h-44 w-full object-contain" draggable={false} />
      </div>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12.5px] font-medium">{fileName(shot.path)}</div>
          <div className="text-[11px] text-white/40">Drag the picture into any app</div>
        </div>
        <button onClick={() => copyShot(shot).then(() => setCopied(true))}
          className="flex h-8 items-center gap-1.5 rounded-full bg-white px-3.5 text-[12.5px] font-semibold text-black hover:brightness-90">
          <Icon name={copied ? "check" : "copy"} size={14} />{copied ? "Copied" : "Copy"}
        </button>
        <button onClick={() => openShot(shot)} className="flex h-8 items-center rounded-full bg-white/10 px-3.5 text-[12.5px] font-medium hover:bg-white/18">Open</button>
        <button onClick={() => revealShot(shot)} aria-label="Show in folder" {...useTip("Show in folder")}
          className="grid size-8 place-items-center rounded-full bg-white/10 hover:bg-white/18">
          <Icon name="folder" size={14} />
        </button>
      </div>
    </div>
  );
}
