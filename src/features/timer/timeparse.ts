// What people type into the Timer tab, read as a length or a time of day. Pure; checked by
// scripts/timeparse.test.ts.

export const MIN = 60_000;

/** "7" -> 7 min, "1:30" -> 1 min 30 s, "90s", "1h20", "1h 20m", "2.5" -> 2 min 30 s. Null if it isn't a length. */
export function parseDuration(text: string): number | null {
  const t = text.trim().toLowerCase().replace(/\s+/g, "");
  if (!t) return null;
  let ms: number | null = null;
  const clock = /^(\d+):(\d{1,2})(?::(\d{1,2}))?$/.exec(t);
  if (clock) {
    const [a, b, c] = [clock[1], clock[2], clock[3]].map((n) => Number(n ?? 0));
    ms = clock[3] !== undefined ? ((a * 60 + b) * 60 + c) * 1000 : (a * 60 + b) * 1000;
  } else if (/^\d+(\.\d+)?$/.test(t)) {
    ms = Number(t) * MIN;
  } else {
    const parts = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m(?:in)?)?(?:(\d+)s)?$/.exec(t.replace(/(\d)h(\d+)$/, "$1h$2m"));
    if (parts && (parts[1] || parts[2] || parts[3])) ms = (Number(parts[1] ?? 0) * 60 + Number(parts[2] ?? 0)) * MIN + Number(parts[3] ?? 0) * 1000;
  }
  return ms && ms > 0 && ms <= 24 * 60 * MIN ? Math.round(ms) : null;
}

/** "7:30", "7:30pm", "19:05", "7pm", "0730" -> the next time it's that o'clock. Null if it isn't a time.
    Without am/pm, 1-12 o'clock is whichever comes first, morning or evening ("9:34" at 9 pm is
    9:34 pm); 0-23 with a leading zero or past 12 is the 24-hour clock. */
export function parseAlarm(text: string, now = Date.now()): number | null {
  const m = /^(\d{1,2})(?::?(\d{2}))?\s*(am|pm|a|p)?$/i.exec(text.trim());
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  const ampm = m[3]?.toLowerCase();
  if (min > 59 || h > 23 || (ampm && (h < 1 || h > 12))) return null;
  if (ampm?.startsWith("p") && h < 12) h += 12;
  if (ampm?.startsWith("a") && h === 12) h = 0;
  const next = (hour: number) => {
    const at = new Date(now);
    at.setHours(hour, min, 0, 0);
    if (at.getTime() <= now) at.setDate(at.getDate() + 1);
    return at.getTime();
  };
  if (ampm || h === 0 || h > 12 || m[1].startsWith("0")) return next(h);
  return Math.min(next(h % 12), next((h % 12) + 12));
}

