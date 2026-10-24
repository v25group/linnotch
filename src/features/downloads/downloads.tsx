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

export function DownloadFlash({ download }: { download: Download }) {
  return (
    <div className="flex h-15 items-center gap-3 px-3.5">
      <motion.span className="grid size-9 shrink-0 place-items-center text-[#4fd18b]"
        initial={{ y: -14, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ type: "spring", stiffness: 400, damping: 18 }}>
        <Icon name="download" size={26} />
      </motion.span>
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-semibold">Download finished</div>
        <div className="truncate text-[12px] text-white/55">{download.name} · {size(download.size)}</div>
      </div>
    </div>
  );
}

export function DownloadCard({ download, onDone }: { download: Download; onDone: () => void }) {
  return (
    <div className="flex flex-col gap-3 p-3.5">
      <div className="flex items-center gap-3">
        <span className="text-white/80"><Icon name={iconFor(download.name)} size={30} /></span>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] text-[#4fd18b]">Download finished</div>
          <div className="truncate text-[14px] font-semibold">{download.name}</div>
          <div className="text-[11.5px] text-white/45">{size(download.size)} · Downloads</div>
        </div>
      </div>
      <div className="flex gap-2">
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
