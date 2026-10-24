// The island's own music player: plays files from the library (src-tauri/src/library.rs) and
// live radio streams (src/features/music/radio.tsx) in the webview, and exposes the same shape as the system
// player so PlayerCard can show either.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { motion } from "motion/react";
import { open } from "@tauri-apps/plugin-dialog";
import { Icon } from "../../components/icons";
import { Bars, FALLBACK, artColor, type Media } from "./media";
import { clockText } from "../../island/system";
import { load, save } from "../../lib/storage";

export type Track = {
  /** File path, or the station id for radio. */
  path: string;
  title: string; artist: string; album: string; duration: number;
  /** Radio: the stream to play and the station logo, instead of a file and its embedded cover. */
  live?: boolean; url?: string; art?: string;
};

const DIR_KEY = "island.libraryDir";

export function useLocalPlayer(onTrackChange: () => void, onStart: () => void) {
  const audio = useMemo(() => new Audio(), []);
  const [queue, setQueue] = useState<Track[]>([]);
  const [index, setIndex] = useState(-1);
  const [nonce, setNonce] = useState(0); // replays even when the same index is picked again
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState(0); // 0 off, 1 one track, 2 whole list
  const [buffering, setBuffering] = useState(false);
  const [failed, setFailed] = useState(false);
  const [art, setArt] = useState<string | null>(null);
  // Radio: the song on air right now, from the stream's own metadata (src-tauri/src/radio.rs).
  const [onAir, setOnAir] = useState<string | null>(null);
  const announce = useRef(onTrackChange);
  announce.current = onTrackChange;
  const [color, setColor] = useState(FALLBACK);
  const track = queue[index] ?? null;

  // Audio events fire outside React; they read the latest state from here.
  const state = useRef({ queue, index, shuffle, repeat, failures: 0 });
  state.current = { ...state.current, queue, index, shuffle, repeat };

  const step = useCallback((by: 1 | -1, auto: boolean) => {
    const { queue, index, shuffle, repeat } = state.current;
    if (!queue.length) return;
    if (auto && repeat === 1) {
      audio.currentTime = 0;
      audio.play().catch(() => {});
      return;
    }
    let next = shuffle && queue.length > 1
      ? (index + 1 + Math.floor(Math.random() * (queue.length - 1))) % queue.length
      : index + by;
    if (next >= queue.length) {
      // The list ran out: start over only when repeating it, or when the user asked for "next".
      if (auto && repeat !== 2) return void setPlaying(false);
      next = 0;
    }
    if (next < 0) next = queue.length - 1;
    setIndex(next);
    setNonce((n) => n + 1);
  }, [audio]);

  useEffect(() => {
    const handlers: [string, () => void][] = [
      ["play", () => setPlaying(true)],
      ["waiting", () => setBuffering(true)],
      ["playing", () => {
        setBuffering(false);
        setFailed(false);
      }],
      ["pause", () => setPlaying(false)],
      ["timeupdate", () => setPosition(audio.currentTime * 1000)],
      ["loadedmetadata", () => {
        state.current.failures = 0;
        // A live stream reports an infinite duration.
        setDuration(Number.isFinite(audio.duration) ? audio.duration * 1000 : 0);
      }],
      ["ended", () => !state.current.queue[state.current.index]?.live && step(1, true)],
      // A file the webview can't decode (e.g. ALAC) is skipped, but stop once every file has failed.
      // A station that's down just says so; hopping to another one on its own would be confusing.
      ["error", () => {
        setBuffering(false);
        if (state.current.queue[state.current.index]?.live) {
          setFailed(true);
          setPlaying(false);
        } else if (++state.current.failures < state.current.queue.length) step(1, true);
        else setPlaying(false);
      }],
    ];
    handlers.forEach(([name, f]) => audio.addEventListener(name, f));
    return () => handlers.forEach(([name, f]) => audio.removeEventListener(name, f));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audio, step]);

  useEffect(() => {
    if (!track) return;
    audio.src = track.url ?? convertFileSrc(track.path);
    audio.play().catch(() => {});
    setPosition(0);
    setDuration(track.duration);
    setBuffering(!!track.live);
    setFailed(false);
    setArt(track.art ?? null);
    onStart();
    onTrackChange();
    let live = true;
    if (!track.live) invoke<string | null>("track_art", { path: track.path }).then((a) => live && setArt(a)).catch(() => {});
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track?.path, nonce]);

  useEffect(() => {
    const off = listen<{ id: string; title: string }>("radio-title", (e) => {
      if (e.payload.id !== state.current.queue[state.current.index]?.path) return;
      setOnAir(e.payload.title);
      announce.current();
    });
    return () => void off.then((f) => f());
  }, []);

  // Read the song titles only while a station is actually playing.
  useEffect(() => {
    setOnAir(null);
    if (track?.live && track.url && playing) invoke("radio_watch", { id: track.path, url: track.url }).catch(() => {});
    else invoke("radio_stop").catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track?.path, nonce, playing]);

  useEffect(() => {
    let live = true;
    if (art) artColor(art).then((c) => live && setColor(c));
    else setColor(FALLBACK);
    return () => { live = false; };
  }, [art]);

  // Stations mostly send "Artist - Song": the song becomes the title, the artist and station go under it.
  const [song, singer] = onAir?.includes(" - ") ? [onAir.slice(onAir.indexOf(" - ") + 3), onAir.slice(0, onAir.indexOf(" - "))] : [onAir, ""];
  const media: Media | null = track && {
    title: song || track.title,
    artist: failed ? "Station unavailable right now" : buffering ? "Connecting…" : song ? [singer, track.title].filter(Boolean).join(" · ") : track.artist,
    album: track.album, app: track.live ? "Radio" : "linnotch", playing,
    position, duration, updated: Date.now(),
    can_next: queue.length > 1, can_previous: track.live ? queue.length > 1 : true, can_seek: !track.live && duration > 0,
    shuffle: track.live ? null : shuffle, repeat: track.live ? null : repeat, live: track.live,
  };

  return {
    media, art, color, position, track, queue, index,
    control: (action: "toggle" | "next" | "previous" | "shuffle" | "repeat") => {
      if (action === "toggle") {
        if (audio.paused) {
          onStart();
          // Resuming a station rejoins the broadcast instead of playing what was buffered.
          if (track?.live && track.url) {
            audio.src = track.url;
            setBuffering(true);
          }
          audio.play().catch(() => {});
        } else audio.pause();
      }
      if (action === "next") step(1, false);
      // Like every player: "previous" restarts the song unless it has only just begun.
      if (action === "previous") {
        if (!track?.live && audio.currentTime > 3) audio.currentTime = 0;
        else step(-1, false);
      }
      if (action === "shuffle") setShuffle((s) => !s);
      if (action === "repeat") setRepeat((r) => (r === 0 ? 2 : r === 2 ? 1 : 0));
    },
    seek: (ms: number) => {
      audio.currentTime = Math.min(Math.max(ms, 0), duration) / 1000;
      setPosition(audio.currentTime * 1000);
    },
    playList: (tracks: Track[], at: number, shuffled = false) => {
      setQueue(tracks);
      setShuffle(shuffled);
      setIndex(at);
      setNonce((n) => n + 1);
    },
  };
}

export type LocalPlayer = ReturnType<typeof useLocalPlayer>;

/** The scanned library, kept for the session so switching tabs doesn't rescan. */
export function useLibrary() {
  const [dir, setDir] = useState<string | null>(() => load(DIR_KEY));
  const [tracks, setTracks] = useState<Track[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);

  const scan = useCallback(async (folder: string | null) => {
    setScanning(true);
    setError(null);
    try {
      const [shown, found] = await invoke<[string, Track[]]>("scan_library", { dir: folder });
      setDir(shown);
      setTracks(found);
      if (folder) save(DIR_KEY, shown);
    } catch (e) {
      setError(String(e));
      setTracks([]);
    } finally {
      setScanning(false);
    }
  }, []);

  const choose = useCallback(async () => {
    const picked = await open({ directory: true, title: "Choose your music folder" }).catch(() => null);
    if (typeof picked === "string") scan(picked);
  }, [scan]);

  return { dir, tracks, error, scanning, scan, choose, ensure: () => tracks === null && !scanning && scan(dir) };
}

export type Library = ReturnType<typeof useLibrary>;

// Library row covers: the embedded art shrunk to a small JPEG, made once per song and kept for the
// session. Full covers are hundreds of KB each, so only rows that scroll into view ask, a few at a time.
const COVER_PX = 72; // 2x the 36px tile
const covers = new Map<string, Promise<string | null>>();
let reading = 0;
const queued: (() => void)[] = [];

async function oneAtATime<T>(task: () => Promise<T>) {
  while (reading >= 4) await new Promise<void>((go) => queued.push(go));
  reading++;
  try {
    return await task();
  } finally {
    reading--;
    queued.shift()?.();
  }
}

function shrink(src: string) {
  return new Promise<string | null>((resolve) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = c.height = COVER_PX;
      // Crop to a centred square, like object-cover.
      const side = Math.min(img.width, img.height);
      c.getContext("2d")!.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, COVER_PX, COVER_PX);
      resolve(c.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function coverOf(path: string) {
  let cover = covers.get(path);
  if (!cover) {
    cover = oneAtATime(() => invoke<string | null>("track_art", { path }).then((a) => (a ? shrink(a) : null))).catch(() => null);
    covers.set(path, cover);
  }
  return cover;
}

function Cover({ path }: { path: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setSrc(null);
    let live = true;
    const seen = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      seen.disconnect();
      coverOf(path).then((c) => live && setSrc(c));
    });
    seen.observe(el);
    return () => {
      live = false;
      seen.disconnect();
    };
  }, [path]);
  return (
    <span ref={ref} className="grid size-9 shrink-0 place-items-center overflow-hidden rounded-[10px] bg-white/8 text-white/40">
      {src ? <img src={src} alt="" className="size-full object-cover" draggable={false} /> : <Icon name="audio" size={16} />}
    </span>
  );
}

const folderName = (dir: string | null) => dir?.split(/[\\/]/).filter(Boolean).pop() ?? "Music";

function Pill({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
      className="flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-white/10 px-3 text-[12px] font-medium transition-colors hover:bg-white/18 active:scale-[0.96]">
      {children}
    </button>
  );
}

/** Songs from the music folder: search, play one, or shuffle them all. */
export function LibraryView({ library, local }: { library: Library; local: LocalPlayer }) {
  const [query, setQuery] = useState("");
  useEffect(() => {
    library.ensure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const { tracks } = library;
  const q = query.trim().toLowerCase();
  const shown = useMemo(
    () => (tracks ?? []).filter((t) => !q || `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(q)),
    [tracks, q],
  );

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <span className="text-white/50"><Icon name="folder" size={16} /></span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold">{folderName(library.dir)}</div>
          <div className="text-[11px] text-white/45">
            {library.scanning ? "Scanning…" : tracks ? `${tracks.length} song${tracks.length === 1 ? "" : "s"}` : ""}
          </div>
        </div>
        {shown.length > 0 && (
          <Pill onClick={() => local.playList(shown, Math.floor(Math.random() * shown.length), true)}>
            <Icon name="shuffle" size={13} />Shuffle
          </Pill>
        )}
        <Pill onClick={library.choose}>Change folder</Pill>
      </div>

      {(tracks?.length ?? 0) > 0 && (
        <label className="flex h-8 items-center gap-2 rounded-full bg-white/8 px-3 text-white/45 focus-within:bg-white/12">
          <Icon name="search" size={14} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search songs, artists, albums"
            className="min-w-0 flex-1 bg-transparent text-[12.5px] text-white outline-none placeholder:text-white/35" />
        </label>
      )}

      {library.scanning && !tracks?.length ? (
        <div className="flex h-24 items-center justify-center gap-2 text-[12.5px] text-white/50">
          <motion.span animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1, ease: "linear" }} className="grid">
            <Icon name="loading" size={16} />
          </motion.span>
          Looking for music…
        </div>
      ) : tracks && tracks.length === 0 ? (
        <div className="flex h-24 flex-col items-center justify-center gap-1 text-center text-[12.5px] text-white/50">
          <div>{library.error ?? "No songs found in this folder."}</div>
          <div className="text-[11.5px] text-white/35">MP3, M4A, FLAC, WAV, OGG and Opus files play here.</div>
        </div>
      ) : (
        <div className="no-scrollbar -mx-1 max-h-52 overflow-y-auto" onWheel={(e) => e.stopPropagation()}>
          {shown.map((t, i) => {
            const current = local.track?.path === t.path;
            return (
              <button key={t.path} onClick={() => local.playList(shown, i)}
                className="flex h-12 w-full items-center gap-3 rounded-xl px-2 text-left transition-colors hover:bg-white/6">
                <Cover path={t.path} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium" style={current ? { color: local.color } : undefined}>{t.title}</span>
                  <span className="block truncate text-[11.5px] text-white/45">{[t.artist, t.album].filter(Boolean).join(" · ") || "Unknown artist"}</span>
                </span>
                {current && <Bars playing={local.media?.playing ?? false} color={local.color} height={12} />}
                <span className="shrink-0 text-[11px] text-white/35 tabular-nums">{t.duration ? clockText(t.duration) : ""}</span>
              </button>
            );
          })}
          {shown.length === 0 && <div className="py-6 text-center text-[12.5px] text-white/45">No matches for “{query}”</div>}
        </div>
      )}
    </div>
  );
}
