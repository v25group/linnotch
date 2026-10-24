// Quick toggles (src-tauri/src/toggles.rs) and the Today tab that holds them with the weather.
// Do Not Disturb is linnotch's own: it silences the island's notification pop-ups (they still
// collect in the Notifications tab); Windows' own switch is one click away in its notification centre.
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { motion } from "motion/react";
import { Icon, type IconName } from "../../components/icons";
import { load, save } from "../../lib/storage";
import { useTip } from "../../components/tooltip";
import { WeatherPanel, type Weather } from "./weather";

type SystemToggles = { wifi: boolean | null; bluetooth: boolean | null; dark: boolean | null; mic_muted: boolean | null };

const DND_KEY = "island.dnd";

export function useDnd() {
  const [dnd, setDnd] = useState(() => load(DND_KEY) === "1");
  const toggle = useCallback(() => {
    setDnd((on) => {
      save(DND_KEY, on ? "0" : "1");
      return !on;
    });
  }, []);
  return { dnd, toggle };
}

function useSystemToggles(active: boolean) {
  const [state, setState] = useState<SystemToggles | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!active) return;
    invoke<SystemToggles>("toggles").then(setState).catch(() => {});
  }, [active]);
  const set = (name: string, on: boolean) => {
    setError(null);
    invoke<SystemToggles>("set_toggle", { name, on }).then(setState).catch((e) => {
      setError(String(e));
      setTimeout(() => setError(null), 3000);
    });
  };
  return { state, set, error };
}

/** A round control-centre button that fills with its colour when on. */
function Toggle({ icon, label, on, color, available = true, onClick }: {
  icon: IconName; label: string; on: boolean; color: string; available?: boolean; onClick: () => void;
}) {
  return (
    <button onClick={onClick} disabled={!available} aria-pressed={on} aria-label={label}
      className="group flex w-[76px] shrink-0 flex-col items-center gap-1.5 disabled:opacity-35">
      <motion.span className="grid size-11 place-items-center rounded-full transition-colors duration-200"
        style={{ background: on ? color : "rgb(255 255 255 / 0.09)", color: on ? "#fff" : "rgb(255 255 255 / 0.8)", boxShadow: on ? `0 0 18px color-mix(in srgb, ${color} 45%, transparent)` : undefined }}
        whileHover={available ? { scale: 1.06 } : undefined} whileTap={available ? { scale: 0.9 } : undefined}>
        <Icon name={icon} size={19} />
      </motion.span>
      <span className="text-[10.5px] leading-tight font-medium text-white/80">{label}</span>
      <span className="-mt-1 text-[10px] leading-tight text-white/35">{available ? (on ? "On" : "Off") : "Unavailable"}</span>
    </button>
  );
}

export function TodayView({ weather, dnd, onDnd, devOn, onDev }: {
  weather: Weather; dnd: boolean; onDnd: () => void; devOn: boolean; onDev: () => void;
}) {
  const { state: s, set, error } = useSystemToggles(true);
  const row = useRef<HTMLDivElement>(null);
  return (
    <div className="flex flex-col gap-3">
      <WeatherPanel weather={weather} />
      <div className="h-px bg-white/10" />
      {/* More buttons than fit: the row scrolls sideways (wheel too). */}
      <div ref={row} className="no-scrollbar -mx-1 flex overflow-x-auto px-1" onWheel={(e) => row.current && (row.current.scrollLeft += e.deltaY + e.deltaX)}>
        <Toggle icon={s?.wifi === false ? "wifiOff" : "wifi"} label="Wi-Fi" color="#0a84ff" on={!!s?.wifi} available={s?.wifi != null}
          onClick={() => set("wifi", !s?.wifi)} />
        <Toggle icon={s?.bluetooth === false ? "bluetoothOff" : "bluetooth"} label="Bluetooth" color="#0a84ff" on={!!s?.bluetooth}
          available={s?.bluetooth != null} onClick={() => set("bluetooth", !s?.bluetooth)} />
        <Toggle icon="dnd" label="Focus" color="#5e5ce6" on={dnd} onClick={onDnd} />
        <Toggle icon="moon" label="Dark mode" color="#8e8e93" on={!!s?.dark} available={s?.dark != null} onClick={() => set("dark", !s?.dark)} />
        <Toggle icon={s?.mic_muted ? "micOff" : "mic"} label="Mute mic" color="#ff453a" on={!!s?.mic_muted} available={s?.mic_muted != null}
          onClick={() => set("mic", !s?.mic_muted)} />
        <Toggle icon="code" label="Developer" color="#30b0c7" on={devOn} onClick={onDev} />
      </div>
      <div className="flex min-h-4 items-center justify-between gap-2 px-1 text-[11px] text-white/40">
        <span className="truncate">{error ?? (dnd ? "Focus is on: notification pop-ups are silenced." : "")}</span>
        <button onClick={() => invoke("open_notification_center").catch(() => {})} {...useTip("Windows' own Do Not Disturb")}
          className="flex shrink-0 items-center gap-1 hover:text-white/75">
          Windows Do Not Disturb <Icon name="external" size={11} />
        </button>
      </div>
    </div>
  );
}
