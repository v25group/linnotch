// Weather and sunrise/sunset for where you are. Location comes from your internet connection
// (city-level); weather from Open-Meteo, free and keyless. Everything is cached so the notch has something to show straight away.
import { useCallback, useEffect, useState } from "react";
import { Icon, type IconName } from "../../components/icons";
import { load, save } from "../../lib/storage";

type Place = { lat: number; lon: number; city: string; at: number };
type Day = { date: number; code: number; high: number; low: number };
export type Forecast = {
  at: number; city: string; temp: number; code: number; day: boolean; high: number; low: number;
  sunrise: number[]; sunset: number[]; days: Day[];
};

const PLACE_KEY = "island.place";
const WEATHER_KEY = "island.weather";
const PLACE_TTL = 12 * 3600_000;
const WEATHER_TTL = 15 * 60_000;

function cached<T>(key: string): T | null {
  try {
    return JSON.parse(load(key) ?? "null");
  } catch {
    return null;
  }
}

async function getJson(url: string) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

async function locate(): Promise<Place> {
  const old = cached<Place>(PLACE_KEY);
  if (old && Date.now() - old.at < PLACE_TTL) return old;
  // Two free IP-location services; the second covers for the first.
  for (const url of ["https://get.geojs.io/v1/ip/geo.json", "https://ipwho.is/"]) {
    try {
      const j = await getJson(url);
      const place = { lat: Number(j.latitude), lon: Number(j.longitude), city: j.city ?? "", at: Date.now() };
      if (Number.isFinite(place.lat) && Number.isFinite(place.lon)) {
        save(PLACE_KEY, JSON.stringify(place));
        return place;
      }
    } catch {
      // try the next one
    }
  }
  if (old) return old;
  throw new Error("Couldn't find your location");
}

async function fetchForecast(place: Place): Promise<Forecast> {
  const q = new URLSearchParams({
    latitude: String(place.lat), longitude: String(place.lon), timezone: "auto", forecast_days: "5",
    current: "temperature_2m,weather_code,is_day",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset",
  });
  const j = await getJson(`https://api.open-meteo.com/v1/forecast?${q}`);
  // Times come in the place's own time zone, without an offset; this PC is in the same place.
  const t = (s: string) => new Date(s).getTime();
  return {
    at: Date.now(), city: place.city,
    temp: Math.round(j.current.temperature_2m), code: j.current.weather_code, day: j.current.is_day === 1,
    high: Math.round(j.daily.temperature_2m_max[0]), low: Math.round(j.daily.temperature_2m_min[0]),
    sunrise: j.daily.sunrise.map(t), sunset: j.daily.sunset.map(t),
    days: j.daily.time.map((d: string, i: number) => ({
      date: t(d), code: j.daily.weather_code[i], high: Math.round(j.daily.temperature_2m_max[i]), low: Math.round(j.daily.temperature_2m_min[i]),
    })),
  };
}

/** WMO weather code -> words and icon. */
export function describe(code: number, day = true): { label: string; icon: IconName } {
  if (code === 0) return { label: day ? "Sunny" : "Clear", icon: day ? "sunny" : "moon" };
  if (code <= 2) return { label: "Partly cloudy", icon: day ? "partly" : "partlyNight" };
  if (code === 3) return { label: "Cloudy", icon: "cloud" };
  if (code === 45 || code === 48) return { label: "Fog", icon: "fog" };
  if (code >= 95) return { label: "Thunderstorm", icon: "storm" };
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return { label: "Snow", icon: "snow" };
  return { label: code >= 80 ? "Showers" : code >= 61 ? "Rain" : "Drizzle", icon: "rain" };
}

export const timeOf = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).toUpperCase();

export function useWeather() {
  const [forecast, setForecast] = useState<Forecast | null>(() => cached<Forecast>(WEATHER_KEY));
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (force = false) => {
    const old = cached<Forecast>(WEATHER_KEY);
    if (!force && old && Date.now() - old.at < WEATHER_TTL) return;
    try {
      const place = await locate();
      const next = await fetchForecast(place);
      save(WEATHER_KEY, JSON.stringify(next));
      setForecast(next);
      setError(null);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(() => refresh(), WEATHER_TTL);
    return () => clearInterval(id);
  }, [refresh]);

  return { forecast, error, refresh };
}

export type Weather = ReturnType<typeof useWeather>;

/** Weather part of the Today tab. */
export function WeatherPanel({ weather }: { weather: Weather }) {
  const f = weather.forecast;
  if (!f) {
    return (
      <div className="flex h-20 items-center justify-center text-center text-[12.5px] text-white/50">
        {weather.error ? "Weather isn't available right now." : "Getting the weather…"}
      </div>
    );
  }
  const { icon, label } = describe(f.code, f.day);
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-3">
        <span className="text-white"><Icon name={icon} size={34} /></span>
        <div className="flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-[26px] leading-none font-semibold">{f.temp}°</span>
            <span className="text-[13px] text-white/70">{label}</span>
          </div>
          <div className="text-[11.5px] text-white/45">{[f.city, `H ${f.high}°  L ${f.low}°`].filter(Boolean).join(" · ")}</div>
        </div>
        <div className="flex flex-col items-end gap-0.5 text-[11.5px] text-white/60">
          <span className="flex items-center gap-1"><Icon name="sunrise" size={13} />{timeOf(f.sunrise[0])}</span>
          <span className="flex items-center gap-1"><Icon name="sunset" size={13} />{timeOf(f.sunset[0])}</span>
        </div>
      </div>
      <div className="flex justify-between rounded-xl bg-white/5 px-2 py-1.5">
        {f.days.map((d, i) => (
          <div key={d.date} className="flex w-14 flex-col items-center gap-0.5 text-[11px]">
            <span className="text-white/50">{i === 0 ? "Today" : new Date(d.date).toLocaleDateString([], { weekday: "short" })}</span>
            <span className="text-white/85"><Icon name={describe(d.code).icon} size={16} /></span>
            <span className="tabular-nums"><span className="text-white/85">{d.high}°</span> <span className="text-white/40">{d.low}°</span></span>
          </div>
        ))}
      </div>
    </div>
  );
}
