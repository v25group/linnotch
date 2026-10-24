// Clipboard history (src-tauri/src/clipboard.rs): click an item to paste it where you were working,
// or copy it back with the small button. Kept in memory only; private copies are never recorded.
import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AnimatePresence, motion } from "motion/react";
import { Icon, type IconName } from "../../components/icons";
import { ago, useNow } from "../../island/system";
import { useTip } from "../../components/tooltip";
import { smart } from "./smart";

export type Clip = {
  id: number; text: string | null; image: string | null; width: number; height: number; at: number;
  /** Looks like an API key or token (src-tauri/src/clipboard.rs): shown masked, gone after a minute. */
  secret: string | null;
};

export function useClipboard() {
  const [clips, setClips] = useState<Clip[]>([]);
  useEffect(() => {
    const off = listen<Clip[]>("clipboard", (e) => setClips(e.payload));
    invoke<Clip[]>("clipboard_list").then(setClips).catch(() => {});
    return () => void off.then((f) => f());
  }, []);
  return clips;
}

const URL_RE = /^https?:\/\/\S+$/i;
const COLOR_RE = /^(#[0-9a-f]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\))$/i;

function kindOf(text: string): { icon: IconName; color?: string } {
  const t = text.trim();
  if (COLOR_RE.test(t)) return { icon: "clipboard", color: t };
  if (URL_RE.test(t)) return { icon: "link" };
  return { icon: "clipboard" };
}

function RowButton({ icon, tip, onClick }: { icon: IconName; tip: string; onClick: () => void }) {
  return (
    <button aria-label={tip} {...useTip(tip)}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="grid size-7 place-items-center rounded-full text-white/55 hover:bg-white/12 hover:text-white">
      <Icon name={icon} size={14} />
    </button>
  );
}

function ClipRow({ clip, now }: { clip: Clip; now: number }) {
  const [state, setState] = useState<null | "pasted" | "copied" | "failed">(null);
  const flash = (s: typeof state) => {
    setState(s);
    setTimeout(() => setState(null), 1400);
  };
  const paste = () => invoke("clipboard_paste", { id: clip.id }).then(() => flash("pasted")).catch(() => flash("failed"));
  const copy = () => invoke("clipboard_copy", { id: clip.id }).then(() => flash("copied")).catch(() => flash("failed"));
  const kind = clip.text ? kindOf(clip.text) : null;
  // JSON, tokens, timestamps...: what it is, and its converted forms one click away.
  const dev = useMemo(() => (clip.text && !clip.secret ? smart(clip.text) : null), [clip.text, clip.secret]);
  const write = (text: string) => invoke("clipboard_write", { text }).then(() => flash("copied")).catch(() => flash("failed"));

  return (
    <motion.div layout initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: 20 }}
      onClick={paste} role="button"
      className="group flex cursor-pointer items-center gap-3 rounded-xl px-2 py-2 transition-colors hover:bg-white/6">
      {clip.image ? (
        <img src={clip.image} alt="" className="h-11 w-16 shrink-0 rounded-lg bg-white/5 object-contain" draggable={false} />
      ) : kind?.color ? (
        <span className="size-7 shrink-0 rounded-lg" style={{ background: kind.color, boxShadow: "inset 0 0 0 1px rgb(255 255 255 / 0.15)" }} />
      ) : (
        <span className="grid size-7 shrink-0 place-items-center text-white/40"><Icon name={kind?.icon ?? "clipboard"} size={16} /></span>
      )}
      <div className="min-w-0 flex-1">
        {clip.secret ? (
          <div className="font-mono text-[12.5px] text-white/85">{"•".repeat(16)}{clip.text?.trim().slice(-4)}</div>
        ) : clip.text ? (
          <div className={`line-clamp-2 text-[12.5px] [overflow-wrap:anywhere] ${kind?.icon === "link" ? "text-[#7cc4ff]" : "text-white/85"}`}>
            {clip.text.replace(/\s+/g, " ").slice(0, 300)}
          </div>
        ) : (
          <div className="text-[12.5px] text-white/85">Image · {clip.width}×{clip.height}</div>
        )}
        {clip.secret ? (
          <div className="text-[10.5px] text-[#ff9f0a]">{clip.secret} · hidden, removed in {Math.max(0, Math.ceil((clip.at + 60_000 - now) / 1000))} s</div>
        ) : dev ? (
          <div className="mt-1 flex flex-wrap items-center gap-1">
            <span className="text-[10.5px] font-semibold text-[#7cc4ff]">{dev.label}</span>
            {dev.note && <span className="min-w-0 truncate text-[10.5px] text-white/40">· {dev.note}</span>}
            {dev.copy.map((c) => (
              <button key={c.label} onClick={(e) => { e.stopPropagation(); write(c.text); }}
                className="h-5 rounded-full bg-white/10 px-2 text-[10.5px] font-medium text-white/80 hover:bg-white/18">
                Copy {c.label}
              </button>
            ))}
          </div>
        ) : (
          <div className="text-[10.5px] text-white/35">{ago(clip.at, now)}</div>
        )}
      </div>
      <AnimatePresence mode="popLayout" initial={false}>
        {state ? (
          <motion.span key="state" initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}
            className={`shrink-0 text-[11.5px] font-medium ${state === "failed" ? "text-[#ff6b6b]" : "text-[#4fd18b]"}`}>
            {state === "pasted" ? "Pasted" : state === "copied" ? "Copied" : "Couldn't paste"}
          </motion.span>
        ) : (
          <motion.span key="actions" className="flex shrink-0 opacity-0 transition-opacity group-hover:opacity-100">
            <RowButton icon="copy" tip="Copy only" onClick={copy} />
            <RowButton icon="trash" tip="Remove" onClick={() => invoke("clipboard_remove", { id: clip.id })} />
          </motion.span>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

export function ClipboardView({ clips }: { clips: Clip[] }) {
  // Tick every second while a secret is counting down to being removed.
  const now = useNow(clips.some((c) => c.secret) ? 1000 : 30_000);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 px-1">
        <span className="text-white/50"><Icon name="clipboard" size={16} /></span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold">Clipboard</div>
          <div className="text-[11px] text-white/40">Click to paste · passwords are never kept</div>
        </div>
        {clips.length > 0 && (
          <button onClick={() => invoke("clipboard_clear")}
            className="flex h-7 shrink-0 items-center rounded-full bg-white/10 px-3 text-[12px] font-medium hover:bg-white/18">
            Clear all
          </button>
        )}
      </div>
      {clips.length === 0 ? (
        <div className="flex h-24 flex-col items-center justify-center gap-1 text-center text-[12.5px] text-white/50">
          <div>Nothing copied yet.</div>
          <div className="text-[11.5px] text-white/35">Copy text or an image and it shows up here.</div>
        </div>
      ) : (
        <div className="no-scrollbar -mx-1 max-h-60 overflow-y-auto" onWheel={(e) => e.stopPropagation()}>
          <AnimatePresence initial={false}>
            {clips.map((c) => <ClipRow key={c.id} clip={c} now={now} />)}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}
