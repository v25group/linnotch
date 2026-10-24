// Now playing: the track Windows' media controls report (src-tauri/src/media.rs), shown in the
// resting notch while it plays and as a full player on hover.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AnimatePresence, motion } from "motion/react";
import { Icon, type IconName } from "../../components/icons";
import { clockText, useNow } from "../../island/system";
import { useTip } from "../../components/tooltip";

export type Media = {
  title: string; artist: string; album: string; app: string; playing: boolean;
  position: number; duration: number; updated: number;
  can_next: boolean; can_previous: boolean; can_seek: boolean;
  /** null when the app doesn't support it. repeat: 0 off, 1 one track, 2 whole list. */
  shuffle: boolean | null; repeat: number | null;
  /** A live stream (radio): no seek bar, a LIVE badge instead. */
  live?: boolean;
};

export const FALLBACK = "#ff6b9a";

/** A bright version of the album art's most colourful tone, readable on black. */
export function artColor(src: string): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    // Station logos come from other sites; without CORS the canvas can't be read, so fall back.
    if (!src.startsWith("data:")) img.crossOrigin = "anonymous";
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = c.height = 24;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(img, 0, 0, 24, 24);
      let px: Uint8ClampedArray;
      try {
        px = ctx.getImageData(0, 0, 24, 24).data;
      } catch {
        return resolve(FALLBACK);
      }
      // Weight each pixel by its saturation so grey backgrounds don't win.
      let [r, g, b, total] = [0, 0, 0, 0];
      for (let i = 0; i < px.length; i += 4) {
        const max = Math.max(px[i], px[i + 1], px[i + 2]);
        const w = max === 0 ? 0 : (max - Math.min(px[i], px[i + 1], px[i + 2])) / max + 0.02;
        r += px[i] * w; g += px[i + 1] * w; b += px[i + 2] * w; total += w;
      }
      if (!total) return resolve(FALLBACK);
      [r, g, b] = [r / total, g / total, b / total];
      const lift = 200 / Math.max(r, g, b, 1); // scale so the brightest channel lands around 200+
      const ch = (v: number) => Math.round(Math.min(255, v * Math.max(lift, 1) + 30));
      resolve(`rgb(${ch(r)} ${ch(g)} ${ch(b)})`);
    };
    img.onerror = () => resolve(FALLBACK);
    img.src = src;
  });
}

const trackKey = (m: Media | null) => (m ? `${m.app}\u0001${m.title}\u0001${m.artist}` : "");

export function useMedia(onTrackChange: () => void) {
  const [media, setMedia] = useState<Media | null>(null);
  const [art, setArt] = useState<string | null>(null);
  const [color, setColor] = useState(FALLBACK);
  // When the last report arrived; used when the player's own timestamp can't be trusted.
  const received = useRef(0);
  const lastKey = useRef<string | null>(null);

  useEffect(() => {
    const unlisten = [
      listen<Media | null>("media", (e) => {
        received.current = Date.now();
        setMedia(e.payload);
        const key = trackKey(e.payload);
        // The first report is a baseline. After that, a track pops the notch open the first time
        // it's heard playing: players often switch the title before they start the new track.
        if (lastKey.current === null) lastKey.current = key;
        else if (key && key !== lastKey.current && e.payload?.playing) {
          lastKey.current = key;
          onTrackChange();
        }
      }),
      listen<string | null>("media-art", (e) => setArt(e.payload)),
    ];
    // Whatever cover Rust already has: it may have been sent before we were listening.
    invoke<string | null>("media_art").then((a) => a && setArt((cur) => cur ?? a)).catch(() => {});
    return () => unlisten.forEach((p) => p.then((off) => off()));
  }, [onTrackChange]);

  useEffect(() => {
    let live = true;
    if (art) artColor(art).then((c) => live && setColor(c));
    else setColor(FALLBACK);
    return () => { live = false; };
  }, [art]);

  const now = useNow(media?.playing ? 250 : null);
  let position = 0;
  if (media) {
    const plausible = media.updated > now - 12 * 3600_000 && media.updated <= now + 1000;
    const since = media.playing ? now - (plausible ? media.updated : received.current) : 0;
    position = Math.min(Math.max(media.position + since, 0), media.duration || Infinity);
  }

  const control = (action: "toggle" | "next" | "previous" | "shuffle" | "repeat") => {
    // Flip right away; the next report from the player confirms it.
    if (action === "toggle") setMedia((m) => m && { ...m, playing: !m.playing, position, updated: Date.now() });
    if (action === "shuffle") setMedia((m) => (m && m.shuffle !== null ? { ...m, shuffle: !m.shuffle } : m));
    // Same order as Rust: off -> all -> one -> off.
    if (action === "repeat") setMedia((m) => (m && m.repeat !== null ? { ...m, repeat: m.repeat === 0 ? 2 : m.repeat === 2 ? 1 : 0 } : m));
    invoke("media_control", { action }).catch(() => {});
  };
  const seek = (ms: number) => {
    const to = Math.min(Math.max(ms, 0), media?.duration || 0);
    setMedia((m) => m && { ...m, position: to, updated: Date.now() });
    invoke("media_seek", { position: Math.round(to) }).catch(() => {});
  };

  return { media, art, color, position, control, seek };
}

export type Player = ReturnType<typeof useMedia>;

export function Art({ src, size, radius }: { src: string | null; size: number; radius: number }) {
  return src ? (
    <motion.img key={src} src={src} alt="" className="shrink-0 object-cover" style={{ width: size, height: size, borderRadius: radius }}
      initial={{ opacity: 0, scale: 0.85 }} animate={{ opacity: 1, scale: 1 }} transition={{ type: "spring", stiffness: 400, damping: 28 }} />
  ) : (
    <div className="grid shrink-0 place-items-center bg-white/10 text-white/50" style={{ width: size, height: size, borderRadius: radius }}>
      <Icon name="audio" size={size * 0.45} />
    </div>
  );
}

/** Level bars that dance while playing and rest flat while paused. */
export function Bars({ playing, color, height = 14 }: { playing: boolean; color: string; height?: number }) {
  return (
    <div className="flex shrink-0 items-center gap-[2.5px]" style={{ height }}>
      {[0.82, 1.04, 0.71, 0.93].map((duration, i) => (
        <span key={i} className="w-0.75 rounded-full transition-transform duration-300"
          style={{
            height, background: color,
            animation: playing ? `bar-dance ${duration}s ease-in-out ${-i * 0.27}s infinite alternate` : undefined,
            transform: playing ? undefined : "scaleY(0.22)",
          }} />
      ))}
    </div>
  );
}

/** Text that slowly scrolls back and forth when it's too long for its box. */
function Marquee({ text, className }: { text: string; className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(0);
  useLayoutEffect(() => {
    setOverflow(Math.max((inner.current?.scrollWidth ?? 0) - (box.current?.clientWidth ?? 0), 0));
  }, [text]);
  const end = -overflow - 18;
  return (
    <div ref={box} className={`overflow-hidden whitespace-nowrap ${className ?? ""}`}
      style={overflow ? { maskImage: "linear-gradient(to right, #000 calc(100% - 18px), transparent)" } : undefined}>
      <motion.span ref={inner} key={text} className="inline-block"
        animate={overflow ? { x: [0, 0, end, end, 0] } : { x: 0 }}
        transition={overflow ? { duration: 6 + overflow / 20, times: [0, 0.2, 0.6, 0.8, 1], repeat: Infinity, ease: "easeInOut" } : undefined}>
        {text}
      </motion.span>
    </div>
  );
}

function Control({ icon, onClick, disabled, size = 20, active, color, tip }: {
  icon: IconName; onClick: () => void; disabled?: boolean; size?: number; active?: boolean; color?: string; tip?: string;
}) {
  return (
    <motion.button onClick={onClick} disabled={disabled} aria-label={tip ?? icon} {...useTip(tip)}
      className="relative grid size-9 place-items-center rounded-full transition-colors hover:bg-white/10 disabled:opacity-25 disabled:hover:bg-transparent"
      style={{ color: active === false ? "rgb(255 255 255 / 0.45)" : active ? color : "#fff" }}
      whileHover={disabled ? undefined : { scale: 1.08 }} whileTap={disabled ? undefined : { scale: 0.86 }}>
      <Icon name={icon} size={size} />
      {active && <span className="absolute bottom-0.5 size-1 rounded-full" style={{ background: color }} />}
    </motion.button>
  );
}

function Seek({ player }: { player: Player }) {
  const { media, position, color } = player;
  const bar = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  if (!media || media.duration <= 0) return null;
  const at = (e: React.PointerEvent) => {
    const r = bar.current!.getBoundingClientRect();
    return Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1) * media.duration;
  };
  const shown = drag ?? position;
  const fraction = shown / media.duration;
  return (
    <div className="flex items-center gap-2 text-[10.5px] font-medium text-white/50 tabular-nums">
      <span className="w-8">{clockText(shown)}</span>
      <div
        ref={bar}
        className={`group relative flex h-4 flex-1 items-center ${media.can_seek ? "cursor-pointer" : ""}`}
        onPointerDown={(e) => {
          if (!media.can_seek) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          setDrag(at(e));
        }}
        onPointerMove={(e) => drag !== null && setDrag(at(e))}
        onPointerUp={(e) => {
          if (drag === null) return;
          player.seek(at(e));
          setDrag(null);
        }}
      >
        <div className={`w-full overflow-hidden rounded-full bg-white/15 transition-[height] ${drag !== null ? "h-1.5" : "h-1 group-hover:h-1.5"}`}>
          <div className="h-full rounded-full" style={{ width: `${fraction * 100}%`, background: color, boxShadow: `0 0 10px ${color}` }} />
        </div>
        {media.can_seek && (
          <div
            className={`absolute size-3 -translate-x-1/2 rounded-full bg-white shadow-md transition-[opacity,scale] ${drag !== null ? "scale-110 opacity-100" : "scale-75 opacity-0 group-hover:scale-100 group-hover:opacity-100"}`}
            style={{ left: `${fraction * 100}%` }} />
        )}
      </div>
      <span className="w-8 text-right">-{clockText(Math.max(media.duration - shown, 0))}</span>
    </div>
  );
}

/** The album art, blurred and dimmed, behind the whole player. It fades out towards the top so
    the notch's top edge stays black and keeps meeting the ears cleanly. */
function Ambient({ src }: { src: string | null }) {
  return (
    <div className="pointer-events-none absolute -inset-3 -z-10 overflow-hidden"
      style={{ maskImage: "linear-gradient(to bottom, transparent, #000 45%)" }}>
      <AnimatePresence>
        {src && (
          <motion.img key={src} src={src} alt="" className="absolute inset-0 size-full scale-150 object-cover blur-2xl saturate-150"
            initial={{ opacity: 0 }} animate={{ opacity: 0.45 }} exit={{ opacity: 0 }} transition={{ duration: 0.6 }} />
        )}
      </AnimatePresence>
      <div className="absolute inset-0 bg-linear-to-b from-black/30 to-black/55" />
    </div>
  );
}

function LiveBadge({ playing, info }: { playing: boolean; info: string }) {
  return (
    <div className="flex h-4 items-center gap-2 text-[10.5px] font-semibold tracking-wide">
      <span className="flex items-center gap-1.5 rounded-full bg-[#ff3b30]/15 px-2 py-0.5 text-[#ff6b61]">
        <span className={`size-1.5 rounded-full bg-[#ff3b30] ${playing ? "animate-pulse" : "opacity-50"}`} />
        LIVE
      </span>
      {info && <span className="truncate font-medium text-white/40">{info}</span>}
    </div>
  );
}

const REPEAT_TIP = ["Repeat", "Repeat this song", "Repeat all"];

/** The player in the hover view: big art on the left; title, seek bar and controls beside it. */
export function PlayerCard({ player }: { player: Player }) {
  const { media, art, color, position } = player;
  if (!media) return null;
  const spotify = media.app === "Spotify";
  const badge: IconName = spotify ? "spotify" : media.app === "linnotch" ? "library" : media.app === "Radio" ? "radio" : "audio";
  return (
    <div className="relative flex items-center gap-4">
      <Ambient src={art} />
      <div className="relative shrink-0">
        <div className="rounded-[20px]" style={{ boxShadow: "0 10px 28px rgb(0 0 0 / 0.55)" }}>
          <Art src={art} size={104} radius={20} />
        </div>
        <div className="absolute -right-1.5 -bottom-1.5 grid size-6.5 place-items-center rounded-full bg-black"
          style={{ color: spotify ? "#1ed760" : "#fff" }} {...useTip(media.app)}>
          <Icon name={badge} size={15} />
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <Marquee text={media.title} className="text-[15px] font-semibold" />
            <div className="truncate text-[12.5px] text-white/60">{media.artist || media.album || media.app}</div>
          </div>
          <div className="pt-1"><Bars playing={media.playing} color={color} height={16} /></div>
        </div>
        {media.live ? <LiveBadge playing={media.playing} info={media.album} /> : <Seek player={player} />}
        <div className="-mx-1 flex items-center justify-between">
          {media.shuffle !== null ? (
            <Control icon="shuffle" size={16} tip="Shuffle" active={media.shuffle} color={color} onClick={() => player.control("shuffle")} />
          ) : media.can_seek ? (
            <Control icon="back15" size={16} tip="Back 15 seconds" onClick={() => player.seek(position - 15_000)} />
          ) : <span className="size-9" />}
          <Control icon="previous" size={18} onClick={() => player.control("previous")} disabled={!media.can_previous} />
          <motion.button onClick={() => player.control("toggle")} aria-label={media.playing ? "Pause" : "Play"}
            className="grid size-10 place-items-center rounded-full bg-white text-black"
            style={{ boxShadow: `0 0 22px color-mix(in srgb, ${color} 45%, transparent)` }} whileHover={{ scale: 1.06 }} whileTap={{ scale: 0.9 }}>
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span key={media.playing ? "pause" : "play"} className="grid"
                initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.4, opacity: 0 }}
                transition={{ type: "spring", stiffness: 600, damping: 30 }}>
                <Icon name={media.playing ? "pause" : "play"} size={18} />
              </motion.span>
            </AnimatePresence>
          </motion.button>
          <Control icon="next" size={18} onClick={() => player.control("next")} disabled={!media.can_next} />
          {media.repeat !== null ? (
            <Control icon={media.repeat === 1 ? "repeatOne" : "repeat"} size={16} tip={REPEAT_TIP[media.repeat] ?? "Repeat"}
              active={media.repeat !== 0} color={color} onClick={() => player.control("repeat")} />
          ) : media.can_seek ? (
            <Control icon="forward15" size={16} tip="Forward 15 seconds" onClick={() => player.seek(position + 15_000)} />
          ) : <span className="size-9" />}
        </div>
      </div>
    </div>
  );
}

/** The brief pop-open when a new track starts. */
export function TrackFlash({ player }: { player: Player }) {
  const { media, art, color } = player;
  if (!media) return null;
  return (
    <div className="flex h-14 items-center gap-3 px-3">
      <Art src={art} size={38} radius={9} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px] font-medium">{media.title}</div>
        <div className="truncate text-[12px] text-white/55">{media.artist || media.app}</div>
      </div>
      <div className="pr-2"><Bars playing color={color} height={18} /></div>
    </div>
  );
}
