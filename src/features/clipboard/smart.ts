// Recognises developer text on the clipboard (JSON, JWTs, Base64, timestamps, UUIDs, colours,
// URL-encoding) and offers the converted form to copy. Pure functions; checked by scripts/smart.test.ts.

export type Smart = {
  label: string;
  /** One line about it: when a token expires, what a timestamp is in local time... */
  note?: string;
  /** A colour to show as a swatch. */
  swatch?: string;
  copy: { label: string; text: string }[];
};

function b64decode(s: string) {
  const std = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(std + "=".repeat((4 - (std.length % 4)) % 4));
  return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

const json = (s: string) => {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};

/** "in 2 h", "3 d ago". */
export function relative(at: number, now: number) {
  const mins = Math.round((at - now) / 60_000);
  const abs = Math.abs(mins);
  const text = abs < 1 ? "now" : abs < 60 ? `${abs} min` : abs < 48 * 60 ? `${Math.round(abs / 60)} h` : `${Math.round(abs / 1440)} d`;
  return text === "now" ? "now" : mins > 0 ? `in ${text}` : `${text} ago`;
}

const local = (ms: number) => new Date(ms).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
const hex2 = (n: number) => Math.round(n).toString(16).padStart(2, "0");

export function smart(raw: string, now = Date.now()): Smart | null {
  const t = raw.trim();
  if (!t || t.length > 100_000) return null;

  // JWT: three base64url parts and a JSON header with "alg".
  if (/^[\w-]+\.[\w-]+\.[\w-]*$/.test(t)) {
    try {
      const [h, p] = t.split(".").map((part, i) => (i < 2 ? JSON.parse(b64decode(part)) : null));
      if (h?.alg) {
        const exp = typeof p?.exp === "number" ? p.exp * 1000 : null;
        const who = p?.email ?? p?.sub;
        const note = [exp ? (exp < now ? `expired ${relative(exp, now)}` : `expires ${relative(exp, now)}`) : "no expiry", who && `for ${who}`]
          .filter(Boolean).join(" · ");
        return { label: `JWT · ${h.alg}`, note, copy: [{ label: "Claims", text: JSON.stringify(p, null, 2) }, { label: "Header", text: JSON.stringify(h, null, 2) }] };
      }
    } catch {
      // not a token
    }
  }

  if (/^[[{]/.test(t)) {
    const v = json(t);
    if (v && typeof v === "object") {
      const pretty = JSON.stringify(v, null, 2);
      const min = JSON.stringify(v);
      const size = Array.isArray(v) ? `${v.length} item${v.length === 1 ? "" : "s"}` : `${Object.keys(v).length} key${Object.keys(v).length === 1 ? "" : "s"}`;
      return { label: `JSON · ${size}`, copy: [t !== pretty && { label: "Pretty", text: pretty }, t !== min && { label: "Minified", text: min }].filter((c) => !!c) };
    }
  }

  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t)) {
    return { label: "UUID", copy: [{ label: "No dashes", text: t.replace(/-/g, "") }, { label: t === t.toUpperCase() ? "lowercase" : "UPPERCASE", text: t === t.toUpperCase() ? t.toLowerCase() : t.toUpperCase() }] };
  }

  // Unix time in seconds or milliseconds, 2001-2100.
  if (/^\d{10}$|^\d{13}$/.test(t)) {
    const ms = t.length === 10 ? Number(t) * 1000 : Number(t);
    if (ms > 978_307_200_000 && ms < 4_102_444_800_000) {
      return { label: "Unix time", note: `${local(ms)} · ${relative(ms, now)}`, copy: [{ label: "ISO 8601", text: new Date(ms).toISOString() }] };
    }
  }

  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.test(t)) {
    const ms = Date.parse(t);
    if (!Number.isNaN(ms)) {
      return { label: "Date", note: `${local(ms)} · ${relative(ms, now)}`, copy: [{ label: "Unix seconds", text: String(Math.floor(ms / 1000)) }, { label: "Unix ms", text: String(ms) }] };
    }
  }

  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(t);
  if (hex) {
    const d = hex[1].length <= 4 ? [...hex[1]].map((c) => c + c).join("") : hex[1];
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(d.slice(i, i + 2), 16));
    const a = d.length === 8 ? parseInt(d.slice(6, 8), 16) / 255 : null;
    return { label: "Colour", swatch: t, copy: [{ label: a === null ? "rgb()" : "rgba()", text: a === null ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${+a.toFixed(2)})` }] };
  }
  const rgb = /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})(?:[\s,/]+([\d.]+%?))?\s*\)$/i.exec(t);
  if (rgb) {
    const [r, g, b] = rgb.slice(1, 4).map(Number);
    if ([r, g, b].every((n) => n <= 255)) {
      const a = rgb[4] === undefined ? "" : hex2((rgb[4].endsWith("%") ? parseFloat(rgb[4]) / 100 : Number(rgb[4])) * 255);
      return { label: "Colour", swatch: t, copy: [{ label: "Hex", text: `#${hex2(r)}${hex2(g)}${hex2(b)}${a}` }] };
    }
  }

  if (/%[0-9a-f]{2}/i.test(t) && !/\s/.test(t)) {
    try {
      const decoded = decodeURIComponent(t.replace(/\+/g, " "));
      if (decoded !== t) return { label: "URL-encoded", note: decoded.slice(0, 120), copy: [{ label: "Decoded", text: decoded }] };
    } catch {
      // stray % sign
    }
  }

  // Base64 of readable text. Needs some sign of encoding (digits, +/, padding) so plain words don't match.
  if (t.length >= 12 && t.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(t) && /[0-9+/=]/.test(t)) {
    try {
      const text = b64decode(t);
      if (!/[\x00-\x08\x0e-\x1f\x7f]/.test(text)) return { label: "Base64", note: text.replace(/\s+/g, " ").slice(0, 120), copy: [{ label: "Decoded", text }] };
    } catch {
      // binary, not text
    }
  }
  return null;
}
