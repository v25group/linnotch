// "Download finished" (src-tauri/src/downloads.rs): a pop-up when a file lands in Downloads;
// hovering it offers Open and Show in folder.
import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { motion } from "motion/react";
import { Icon, type IconName } from "../../components/icons";

export type Download = { path: string; name: string; size: number };

export function useDownloads(onNew: (d: Download) => void) {
  const announce = useRef(onNew);
  announce.current = onNew;
  useEffect(() => {
    const off = listen<Download>("download", (e) => announce.current(e.payload));
    return () => void off.then((f) => f());
  }, []);
}

function iconFor(name: string): IconName {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["mp3", "m4a", "flac", "wav", "ogg", "opus", "aac"].includes(ext)) return "audio";
  if (["mp4", "mkv", "mov", "webm", "avi"].includes(ext)) return "video";
  if (["png", "jpg", "jpeg", "gif", "webp", "avif", "heic"].includes(ext)) return "image";
  return "file";
}

function size(bytes: number) {
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) (bytes /= 1024), i++;
  return `${bytes.toFixed(i === 0 || bytes >= 100 ? 0 : 1)} ${units[i]}`;
}

const GREEN = "#4fd18b";

/** The pop-up: centred, the arrow drops in beside the title. */
export function DownloadFlash({ download }: { download: Download }) {
  return (
    <div className="flex h-15 flex-col items-center justify-center gap-0.5 px-5 text-center">
      <div className="flex items-center gap-1.5 text-[13.5px] font-semibold">
        <motion.span className="grid place-items-center" style={{ color: GREEN }}
          initial={{ y: -12, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ type: "spring", stiffness: 400, damping: 18 }}>
          <Icon name="download" size={16} />
        </motion.span>
        Download finished
      </div>
      <div className="max-w-full truncate text-[11.5px] text-white/55">{download.name} · {size(download.size)}</div>
    </div>
  );
}

/** Hovering the pop-up: the file front and centre with a check on it, then its actions. */
export function DownloadCard({ download, onDone }: { download: Download; onDone: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 p-4 text-center">
      <motion.div className="relative" initial={{ scale: 0.85, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", stiffness: 420, damping: 24 }}>
        <span className="grid size-13 place-items-center rounded-2xl bg-white/8 text-white/85" style={{ boxShadow: "inset 0 0 0 1px rgb(255 255 255 / 0.08)" }}>
          <Icon name={iconFor(download.name)} size={26} />
        </span>
        <span className="absolute -right-1.5 -bottom-1.5 grid size-5 place-items-center rounded-full text-black ring-2 ring-black" style={{ background: GREEN }}>
          <Icon name="check" size={12} />
        </span>
      </motion.div>
      <div className="w-full min-w-0">
        <div className="truncate px-2 text-[14px] font-semibold">{download.name}</div>
        <div className="mt-0.5 text-[11.5px] text-white/45">{size(download.size)} · Saved to Downloads</div>
      </div>
      <div className="flex w-full gap-2">
        <button onClick={() => { invoke("open_download", { path: download.path }).catch(() => {}); onDone(); }}
          className="flex h-8 flex-1 items-center justify-center rounded-full bg-white text-[12.5px] font-semibold text-black hover:brightness-90">
          Open
        </button>
        <button onClick={() => { invoke("reveal", { path: download.path }).catch(() => {}); onDone(); }}
          className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-full bg-white/10 text-[12.5px] font-medium hover:bg-white/18">
          <Icon name="folder" size={14} />Show in folder
        </button>
      </div>
    </div>
  );
}
