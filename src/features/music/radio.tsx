// Live radio from the free, community-run Radio Browser directory (radio-browser.info, no key).
// Stations play through the island's own player (src/features/music/library.tsx) as live tracks.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { Icon } from "../../components/icons";
import { Bars } from "./media";
import { type LocalPlayer, type Track } from "./library";
import { load, save } from "../../lib/storage";
import { Kit } from "../../island/kit";

type Station = {
  stationuuid: string; name: string; url_resolved: string; favicon: string; tags: string;
  country: string; countrycode: string; codec: string; bitrate: number; hls: number;
};

// Mirrors of the same directory; the next one is tried when one is down.
const SERVERS = ["https://de1.api.radio-browser.info", "https://de2.api.radio-browser.info"];
const FAVORITES_KEY = "island.radioFavorites";
const LIMIT = 60; // stations per page; scrolling near the end of the list fetches the next one

async function api<T>(path: string): Promise<T> {
  for (const server of SERVERS) {
    try {
      const res = await fetch(server + path, { signal: AbortSignal.timeout(8000) });
      if (res.ok) return await res.json();
    } catch {
      // try the next mirror
    }
  }
  throw new Error("Couldn't reach the radio directory. Check your internet connection.");
}

/** Tells the directory a station was played, which keeps its popularity ranking honest. */
const countClick = (uuid: string) => api(`/json/url/${uuid}`).catch(() => {});

const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());

export function toTrack(s: Station): Track {
  const tags = s.tags.split(",").map((t) => t.trim()).filter(Boolean).slice(0, 2).map(titleCase);
  return {
    path: s.stationuuid,
    url: s.url_resolved,
    title: s.name.trim(),
    artist: [s.country, ...tags].filter(Boolean).join(" · ") || "Live radio",
    album: [s.codec, s.bitrate ? `${s.bitrate} kbps` : ""].filter(Boolean).join(" · "),
    duration: 0,
    live: true,
    art: s.favicon || undefined,
  };
}

/** Streams the webview can play: HLS needs a player library, so those are left out.
    `seen` carries names across pages so a station listed again on a later page is dropped too. */
export function playable(stations: Station[], seen = new Set<string>()) {
  return stations.filter((s) => {
    const key = s.name.trim().toLowerCase();
    if (s.hls || !s.url_resolved || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// The user's country from the system language ("en-IN" -> "IN"), for "Near you".
const REGION = (navigator.language.split("-")[1] ?? "").toUpperCase();
const REGION_NAME = REGION ? new Intl.DisplayNames([navigator.language], { type: "region" }).of(REGION) : undefined;

/** A chip above the list. `params` narrow the directory search; Favorites has none (it's local). */
type Filter = { id: string; label: string; params?: Record<string, string> };
const FILTERS: Filter[] = [
  { id: "favorites", label: "Favorites" },
  { id: "popular", label: "Popular", params: {} },
  ...(REGION ? [{ id: "near", label: REGION_NAME ?? "Near you", params: { countrycode: REGION } }] : []),
  ...(REGION !== "IN" ? [{ id: "india", label: "India", params: { countrycode: "IN" } }] : []),
  { id: "tamil", label: "Tamil", params: { language: "tamil" } },
  ...["Pop", "News", "Lofi", "Jazz", "Rock", "Classical", "Hits", "Talk"].map((g) => ({ id: g, label: g, params: { tag: g.toLowerCase() } })),
];

/** What's listed for one search: the stations so far and where the next page starts. */
type Page = { url: string; list: Track[]; offset: number; done: boolean; seen: Set<string> };

function loadFavorites(): Track[] {
  try {
    return JSON.parse(load(FAVORITES_KEY) ?? "[]");
  } catch {
    return [];
  }
}

export function useRadio() {
  const [filter, setFilter] = useState(() => (loadFavorites().length ? "favorites" : REGION ? "near" : "popular"));
  const [query, setQuery] = useState("");
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [favorites, setFavorites] = useState<Track[]>(loadFavorites);
  const cache = useRef(new Map<string, Page>());

  const q = query.trim();
  const active = FILTERS.find((f) => f.id === filter) ?? FILTERS[1];
  // Typing searches all stations; otherwise the chip decides what's listed.
  const params = q ? { name: q } : active.params;
  const url = params
    ? "/json/stations/search?" + new URLSearchParams({ ...params, limit: String(LIMIT), hidebroken: "true", order: "clickcount", reverse: "true" })
    : null;

  // Fetches the page after `from` (or the first one) and adds it to what's listed for `url`.
  const fetching = useRef<string | null>(null);
  const fetchPage = useCallback(async (url: string, from: Page | null, live: () => boolean) => {
    const key = `${url}@${from?.offset ?? 0}`;
    if (fetching.current === key) return;
    fetching.current = key;
    setLoading(true);
    try {
      const offset = from?.offset ?? 0;
      const raw = await api<Station[]>(`${url}&offset=${offset}`);
      const seen = new Set(from?.seen);
      const next: Page = {
        url,
        list: [...(from?.list ?? []), ...playable(raw, seen).map(toTrack)],
        offset: offset + raw.length,
        done: raw.length < LIMIT,
        seen,
      };
      cache.current.set(url, next);
      if (live()) {
        setPage(next);
        setError(null);
      }
    } catch (e) {
      // A failed later page keeps what's listed; only an empty list shows the error.
      if (live() && !from) setError(String((e as Error).message ?? e));
    } finally {
      if (fetching.current === key) fetching.current = null;
      if (live()) setLoading(false);
    }
  }, []);

  const current = useRef(url);
  current.current = url;
  useEffect(() => {
    if (url === null) return;
    const cached = cache.current.get(url);
    if (cached) return void (setPage(cached), setError(null));
    let live = true;
    // Wait for a pause in typing before asking the directory.
    const id = setTimeout(() => fetchPage(url, null, () => live), q ? 400 : 0);
    return () => {
      live = false;
      clearTimeout(id);
    };
  }, [url, q, fetchPage]);

  const stations = page && page.url === url ? page : null;
  const more = useCallback(() => {
    if (stations && !stations.done) fetchPage(stations.url, stations, () => current.current === stations.url);
  }, [stations, fetchPage]);

  const toggleFavorite = useCallback((t: Track) => {
    setFavorites((list) => {
      const next = list.some((f) => f.path === t.path) ? list.filter((f) => f.path !== t.path) : [...list, t];
      save(FAVORITES_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const showingFavorites = url === null;
  return {
    filter, setFilter, query, setQuery, favorites, toggleFavorite, showingFavorites,
    list: showingFavorites ? favorites : stations?.list ?? null,
    more: showingFavorites ? undefined : more,
    hasMore: !showingFavorites && !!stations && !stations.done,
    loading: !showingFavorites && loading,
    error: showingFavorites ? null : error,
  };
}

export type Radio = ReturnType<typeof useRadio>;

function StationLogo({ src }: { src?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return (
    <span className="grid size-9 shrink-0 place-items-center overflow-hidden rounded-[10px] bg-white/8 text-white/40">
      {src && !failed ? <img src={src} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" className="size-full object-cover" onError={() => setFailed(true)} /> : <Icon name="radio" size={17} />}
    </span>
  );
}

export function RadioView({ radio, local }: { radio: Radio; local: LocalPlayer }) {
  const chips = useRef<HTMLDivElement>(null);
  const list = radio.list ?? [];
  const favorite = useMemo(() => new Set(radio.favorites.map((f) => f.path)), [radio.favorites]);

  const play = (i: number) => {
    local.playList(list, i);
    countClick(list[i].path);
  };

  return (
    <div className="flex flex-col gap-2.5">
      <label className="flex h-8 items-center gap-2 rounded-full bg-white/8 px-3 text-white/45 focus-within:bg-white/12">
        <Icon name="search" size={14} />
        <input value={radio.query} onChange={(e) => radio.setQuery(e.target.value)} placeholder="Search 50,000+ radio stations"
          className="min-w-0 flex-1 bg-transparent text-[12.5px] text-white outline-none placeholder:text-white/35" />
        {radio.query && (
          <button onClick={() => radio.setQuery("")} aria-label="Clear search" className="grid text-white/45 hover:text-white">
            <Icon name="close" size={13} />
          </button>
        )}
      </label>

      {!radio.query.trim() && (
        <div ref={chips} className="no-scrollbar -mx-0.5 flex gap-1.5 overflow-x-auto px-0.5"
          onWheel={(e) => chips.current && (chips.current.scrollLeft += e.deltaY + e.deltaX)}>
          {FILTERS.map((f) => (
            <button key={f.id} onClick={() => radio.setFilter(f.id)}
              className={`relative flex h-7 shrink-0 items-center gap-1 rounded-full px-3 text-[12px] font-medium transition-colors ${radio.filter === f.id ? "text-black" : "bg-white/8 text-white/70 hover:bg-white/14"}`}>
              {radio.filter === f.id && <motion.span layoutId="radio-chip" className="absolute inset-0 rounded-full bg-white" transition={{ type: "spring", stiffness: 500, damping: 36 }} />}
              <span className="relative flex items-center gap-1">
                {f.id === "favorites" && <Icon name="heart" size={12} />}
                {f.label}
              </span>
            </button>
          ))}
        </div>
      )}

      {radio.error ? (
        <div className="flex h-24 items-center justify-center px-4 text-center text-[12.5px] text-white/50">{radio.error}</div>
      ) : radio.loading && !list.length ? (
        <div className="flex h-24 items-center justify-center gap-2 text-[12.5px] text-white/50">
          <motion.span animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1, ease: "linear" }} className="grid">
            <Icon name="loading" size={16} />
          </motion.span>
          Tuning in…
        </div>
      ) : list.length === 0 ? (
        <div className="flex h-24 flex-col items-center justify-center gap-1 text-center text-[12.5px] text-white/50">
          {radio.showingFavorites ? (
            <>
              <Kit mood="idle" size={26} />
          <div>No favorite stations yet.</div>
              <div className="text-[11.5px] text-white/35">Tap the heart next to a station to keep it here.</div>
            </>
          ) : (
            <div>No stations found.</div>
          )}
        </div>
      ) : (
        <div className="no-scrollbar -mx-1 max-h-52 overflow-y-auto" onWheel={(e) => e.stopPropagation()}
          onScroll={(e) => {
            const el = e.currentTarget;
            if (radio.hasMore && el.scrollTop + el.clientHeight > el.scrollHeight - 160) radio.more?.();
          }}>
          {list.map((t, i) => {
            const current = local.track?.path === t.path;
            const fav = favorite.has(t.path);
            return (
              <div key={t.path} className="group flex h-12 items-center gap-3 rounded-xl px-2 transition-colors hover:bg-white/6">
                <button onClick={() => play(i)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                  <StationLogo src={t.art} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium" style={current ? { color: local.color } : undefined}>{t.title}</span>
                    <span className="block truncate text-[11.5px] text-white/45">{t.artist}</span>
                  </span>
                  {current && <Bars playing={local.media?.playing ?? false} color={local.color} height={12} />}
                </button>
                <button onClick={() => radio.toggleFavorite(t)} aria-label={fav ? "Remove from favorites" : "Add to favorites"}
                  className={`grid size-7 shrink-0 place-items-center rounded-full transition-[color,opacity] hover:bg-white/10 ${fav ? "text-[#ff5c8a]" : "text-white/40 opacity-0 group-hover:opacity-100"}`}>
                  <Icon name="heart" size={15} />
                </button>
              </div>
            );
          })}
          {radio.hasMore && (
            <div className="flex h-10 items-center justify-center gap-2 text-[11.5px] text-white/40">
              {radio.loading ? (
                <>
                  <motion.span animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1, ease: "linear" }} className="grid">
                    <Icon name="loading" size={13} />
                  </motion.span>
                  Loading more stations…
                </>
              ) : (
                <button onClick={() => radio.more?.()} className="hover:text-white/75">Show more stations</button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
