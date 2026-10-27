// Kit, the fox who lives in the resting notch (a baby fox is a "kit"; the linnotch logo is a fox).
// Drawn small and simple on purpose: at ~22px a detailed fox turns to mush, so it's a round head,
// pointy ears, a pale muzzle, eyes and a tail. Kit's mood says what's going on instead of text,
// and when nothing is, Kit keeps busy with little things (looking around, a wander, a yawn...).
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { listen } from "@tauri-apps/api/event";
import { load, save } from "../lib/storage";

export type Mood = "idle" | "music" | "focus" | "sleep" | "worried" | "happy";
type Activity = "rest" | "look" | "wander" | "wag" | "yawn" | "hop" | "tilt";

const FUR = "#f08a4b";
const EAR = "#b9532a";
const MUZZLE = "#fff1e6";
const INK = "#241a14";
const ACTIVITIES: Activity[] = ["look", "wander", "wag", "yawn", "hop", "tilt"];
/** How long each activity plays, in seconds. */
const LENGTH: Record<Activity, number> = { rest: 0, look: 2.4, wander: 3.2, wag: 1.8, yawn: 1.6, hop: 1.1, tilt: 2 };

/** Blinks every few seconds, at slightly random times so it doesn't feel mechanical. */
function useBlink(on: boolean) {
  const [closed, setClosed] = useState(false);
  useEffect(() => {
    if (!on) return;
    let timer: number;
    const next = () => {
      timer = window.setTimeout(() => {
        setClosed(true);
        timer = window.setTimeout(() => (setClosed(false), next()), 140);
      }, 2600 + Math.random() * 3200);
    };
    next();
    return () => clearTimeout(timer);
  }, [on]);
  return closed;
}

/** While idle: every 4-8 s a random activity (never the same twice in a row), then back to rest. */
function useActivity(on: boolean): [Activity, number] {
  const [state, setState] = useState<[Activity, number]>(["rest", 0]);
  useEffect(() => {
    if (!on) return void setState(["rest", 0]);
    let timer: number;
    let last: Activity = "rest";
    const next = () => {
      timer = window.setTimeout(() => {
        const pick = ACTIVITIES.filter((a) => a !== last)[Math.floor(Math.random() * (ACTIVITIES.length - 1))];
        last = pick;
        setState(([, n]) => [pick, n + 1]);
        timer = window.setTimeout(() => (setState(([, n]) => ["rest", n]), next()), LENGTH[pick] * 1000);
      }, 4000 + Math.random() * 4000);
    };
    next();
    return () => clearTimeout(timer);
  }, [on]);
  return state;
}

const line = { stroke: INK, strokeWidth: 1.5, strokeLinecap: "round" as const, fill: "none" };

function Eyes({ mood, blink, activity }: { mood: Mood; blink: boolean; activity: Activity }) {
  if (mood === "music" || mood === "happy") // eyes closed with joy: ^ ^
    return <><path d="M10 17 q1.6 -2.2 3.2 0" {...line} /><path d="M18.8 17 q1.6 -2.2 3.2 0" {...line} /></>;
  if (mood === "sleep" || activity === "yawn") // closed and relaxed
    return <><path d="M10 16.4 q1.6 1.6 3.2 0" {...line} /><path d="M18.8 16.4 q1.6 1.6 3.2 0" {...line} /></>;
  if (mood === "focus") // narrowed, concentrating
    return <><path d="M10 16.6 h3.2" {...line} /><path d="M18.8 16.6 h3.2" {...line} /><path d="M9.8 14.4 l3.2 0.9" {...line} strokeWidth={1.1} /><path d="M22.2 14.4 l-3.2 0.9" {...line} strokeWidth={1.1} /></>;
  const ry = blink ? 0.25 : mood === "worried" ? 1.6 : 2;
  return (
    <>
      {/* Looking around: the eyes glance left, then right. */}
      <motion.g animate={activity === "look" ? { x: [0, -1.3, -1.3, 1.3, 1.3, 0] } : { x: 0 }} transition={{ duration: LENGTH.look, times: [0, 0.15, 0.4, 0.55, 0.85, 1] }}>
        <ellipse cx={11.6} cy={16.4} rx={1.6} ry={ry} fill={INK} />
        <ellipse cx={20.4} cy={16.4} rx={1.6} ry={ry} fill={INK} />
      </motion.g>
      {mood === "worried" && <><path d="M9.8 13.6 l3 -1" {...line} strokeWidth={1.1} /><path d="M22.2 13.6 l-3 -1" {...line} strokeWidth={1.1} /></>}
    </>
  );
}

/** Headphones in the song's colour, over the ears. */
function Headphones({ color }: { color: string }) {
  return (
    <g>
      <path d="M4.4 15.5 C4.4 2.8 27.6 2.8 27.6 15.5" fill="none" stroke="#2c2c2e" strokeWidth={2.4} strokeLinecap="round" />
      <path d="M6.2 9.6 C9.4 5.2 22.6 5.2 25.8 9.6" fill="none" stroke="rgb(255 255 255 / 0.25)" strokeWidth={0.7} strokeLinecap="round" />
      <rect x={2.2} y={12.6} width={4.6} height={7.6} rx={2.2} fill={color} />
      <rect x={25.2} y={12.6} width={4.6} height={7.6} rx={2.2} fill={color} />
    </g>
  );
}

/** Something drifting up beside Kit: "z" while asleep, notes while listening. */
function Floater({ children, delay = 0 }: { children: string; delay?: number }) {
  return (
    <motion.span className="pointer-events-none absolute -top-1.5 right-0 text-[9px] font-bold text-white/65"
      animate={{ opacity: [0, 1, 0], y: [2, -5, -9], x: [0, 2, 4] }} transition={{ duration: 2.4, delay, repeat: Infinity, ease: "easeOut" }}>
      {children}
    </motion.span>
  );
}

const loop = (duration: number) => ({ duration, repeat: Infinity, ease: "easeInOut" as const });

/** Kit's whole-body motion for a mood or an activity. */
function bodyMotion(mood: Mood, activity: Activity) {
  if (mood === "music") return { animate: { rotate: [-7, 7, -7], y: [0, -1, 0] }, transition: loop(0.9) };
  if (mood === "sleep") return { animate: { scale: [1, 1.04, 1] }, transition: loop(3.2) };
  if (mood === "happy") return { animate: { y: [0, -3, 0, -1.5, 0] }, transition: { duration: 0.9, repeat: Infinity, repeatDelay: 1.2 } };
  const t = { duration: LENGTH[activity], ease: "easeInOut" as const };
  switch (activity) {
    case "wander": return { animate: { x: [0, -9, -9, 9, 9, 0], y: [0, -1, 0, -1, 0, 0] }, transition: { ...t, times: [0, 0.25, 0.4, 0.7, 0.85, 1] } };
    case "hop": return { animate: { y: [0, -4, 0, -2, 0] }, transition: t };
    case "tilt": return { animate: { rotate: [0, 13, 13, 0] }, transition: { ...t, times: [0, 0.25, 0.75, 1] } };
    case "yawn": return { animate: { scale: [1, 1.08, 1.08, 1] }, transition: t };
    default: return { animate: { x: 0, y: 0, rotate: 0, scale: 1 }, transition: { duration: 0.3 } };
  }
}

/** The chosen look (About → Look), shared from App so every Kit on screen follows it. */
export const SkinContext = createContext<Skin>("kit");

/** Kit, drawn in the chosen look: the fox, or just its eyes. Use this everywhere; `Fox` and
    `KitEyes` are for showing one look on purpose (the Look picker). */
export function Kit(props: { mood: Mood; size?: number; accent?: string }) {
  return useContext(SkinContext) === "eyes" ? <KitEyes {...props} /> : <Fox {...props} />;
}

export function Fox({ mood, size = 22, accent = "#ff6b9a" }: { mood: Mood; size?: number; accent?: string }) {
  const still = useReducedMotion();
  const [activity, nonce] = useActivity(mood === "idle" && !still);
  const blink = useBlink(mood === "idle" || mood === "worried");
  const body = still ? {} : bodyMotion(mood, activity);
  const wagging = activity === "wag" || mood === "happy" || mood === "music";
  // Now and then an ear flicks, like a fox listening.
  const ear = still || mood !== "idle" ? {} : { animate: { rotate: [0, 0, -14, 0, 0] }, transition: { duration: 7, repeat: Infinity, times: [0, 0.8, 0.84, 0.9, 1] } };
  const width = (size * 40) / 28;

  return (
    <span className="relative inline-grid shrink-0 place-items-center" style={{ width, height: size }} role="img" aria-label={`Kit the fox, ${mood === "idle" ? activity : mood}`}>
      <motion.svg key={mood === "idle" ? nonce : mood} viewBox="0 0 40 28" width={width} height={size} style={{ overflow: "visible", originX: "16px", originY: "26px" }} {...body}>
        {/* A bushy fox tail rising behind the head on the right, curving up to a white tip. Its root
            is hidden under the head (drawn after) and it pivots there, so wagging swings the tip
            side to side and the joint never shows. */}
        <motion.g style={{ originX: "22px", originY: "23px" }}
          animate={!still && wagging ? { rotate: [0, 12, -6, 12, 0] } : { rotate: 0 }}
          transition={!still && wagging ? { duration: mood === "music" ? 0.9 : 0.7, repeat: Infinity, ease: "easeInOut" } : { duration: 0.3 }}>
          <path d="M20 25.5 C26 27.6 34.2 26 36 19 C37.5 14 36.6 8.6 33 4.4 C32 8 30.2 10.6 28.6 13 C27.5 15.5 25.5 18 22 19.6 Z" fill={FUR} />
          {/* Shade along the inner curve, so it looks round and fluffy rather than flat. */}
          <path d="M28.6 13 C27.5 15.5 25.5 18 22 19.6 L23.4 21.6 C27 20 29.6 17 30.8 13.6 Z" fill={EAR} opacity={0.45} />
          <path d="M33 4.4 C35.4 6.8 36.7 9.8 36.5 12.6 C34.8 11.5 31.9 11.3 29.8 11.8 C31.2 9.8 32.4 7.4 33 4.4 Z" fill={MUZZLE} />
        </motion.g>
        <motion.g style={{ originX: "11px", originY: "10px" }} {...ear}>
          <path d="M5.5 13 L8.6 2.2 L14.6 9.2 Z" fill={FUR} />
          <path d="M8 10.6 L9.2 5.4 L12.2 8.8 Z" fill={EAR} />
        </motion.g>
        {/* Tilting the head, the other ear perks up. */}
        <motion.g style={{ originX: "21px", originY: "10px" }} animate={activity === "tilt" ? { rotate: [0, 10, 10, 0] } : { rotate: 0 }} transition={{ duration: LENGTH.tilt }}>
          <path d="M26.5 13 L23.4 2.2 L17.4 9.2 Z" fill={FUR} />
          <path d="M24 10.6 L22.8 5.4 L19.8 8.8 Z" fill={EAR} />
        </motion.g>
        <ellipse cx={16} cy={17.2} rx={11.4} ry={9.2} fill={FUR} />
        <ellipse cx={16} cy={21.4} rx={6.6} ry={4.6} fill={MUZZLE} />
        <Eyes mood={mood} blink={blink} activity={activity} />
        <ellipse cx={16} cy={19.6} rx={1.4} ry={1} fill={INK} />
        {activity === "yawn" && (
          <motion.ellipse cx={16} cy={22.6} rx={1.6} fill="#7a2f1d" initial={{ ry: 0 }} animate={{ ry: [0, 1.8, 1.8, 0] }} transition={{ duration: LENGTH.yawn }} />
        )}
        {mood === "music" && <Headphones color={accent} />}
      </motion.svg>
      {!still && mood === "sleep" && <Floater>z</Floater>}
      {!still && mood === "music" && <><Floater>♪</Floater><Floater delay={1.2}>♫</Floater></>}
    </span>
  );
}


/** How the resting notch draws its character. Kit is linnotch's own; more skins can join later. */
export type Skin = "kit" | "eyes";
const SKIN_KEY = "island.skin";

export function useSkin() {
  const [skin, setSkin] = useState<Skin>(() => (load(SKIN_KEY) === "eyes" ? "eyes" : "kit"));
  const choose = (s: Skin) => (save(SKIN_KEY, s), setSkin(s));
  return { skin, choose };
}

const clamp = (v: number) => Math.max(-1, Math.min(1, v));
const glow = (color: string) => `drop-shadow(0 0 2.5px ${color}) drop-shadow(0 0 7px rgb(120 140 255 / 0.55))`;

/** Flips on for `ms`, restarting the clock if it's flipped again meanwhile. */
function usePulse(ms: number): [boolean, () => void] {
  const [on, setOn] = useState(false);
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  return [on, () => {
    setOn(true);
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOn(false), ms);
  }];
}

type Shape = "open" | "happy" | "shut" | "narrow" | "dizzy";

function Eye({ shape, side, worried, wink, scale }: { shape: Shape; side: -1 | 1; worried: boolean; wink: boolean; scale: number }) {
  if (shape === "happy") // ^ ^
    return <motion.span className="block h-[7px] w-2.5 rounded-t-full border-x-[2.5px] border-t-[2.5px] border-white" initial={{ y: 2, opacity: 0 }} animate={{ y: 0, opacity: 1 }} />;
  if (shape === "dizzy") // @ @, spinning
    return <motion.span className="block size-3 rounded-full border-[2.5px] border-white border-t-transparent"
      animate={{ rotate: side * 360 }} transition={{ repeat: Infinity, duration: 0.6, ease: "linear" }} />;
  const scaleY = shape === "shut" || wink ? 0.14 : shape === "narrow" ? 0.5 : 1;
  return (
    <motion.span className="block h-3.5 w-2 rounded-full bg-white"
      animate={{ scaleY, scale, rotate: worried ? side * -16 : 0 }}
      transition={{ duration: scaleY < 1 ? 0.08 : 0.16, scale: { type: "spring", stiffness: 380, damping: 18 } }} />
  );
}

/** The eyes skin: Kit's eyes alone, glowing in the notch. They follow the cursor anywhere on screen,
    blink, squint at a click, wink at a copy, look down while you type, go big when the cursor
    comes near and happy right under it, get dizzy when the mouse is shaken, doze off when you're
    away and hop when you're back. Moods match Kit's: ^ ^ to music, narrowed for a task, asleep
    at night, slanted on low battery. Rust sends "cursor", "click", "typing" and "away". */
export function KitEyes({ mood, size = 22, accent = "#8cd2ff" }: { mood: Mood; size?: number; accent?: string }) {
  const still = useReducedMotion();
  const live = !still && mood !== "sleep";
  const [look, setLook] = useState({ x: 0, y: 0 });
  const [near, setNear] = useState<"far" | "near" | "under">("far");
  const [typing, setTyping] = useState(false);
  const [away, setAway] = useState(false);
  const [squint, poke] = usePulse(260);
  const [wink, winkNow] = usePulse(380);
  const [dizzy, dizzyNow] = usePulse(1400);
  const [welcome, welcomeNow] = usePulse(1200);
  const blink = useBlink(live && !away);
  const shake = useRef({ last: 0, dir: 0, flips: [] as number[] });
  // The listeners are set up once; they reach the latest pulses through this.
  const react = useRef({ poke, winkNow, dizzyNow, welcomeNow });
  react.current = { poke, winkNow, dizzyNow, welcomeNow };

  useEffect(() => {
    if (!live) return setLook({ x: 0, y: 0 });
    const offs = [
      listen<[number, number]>("cursor", ({ payload: [dx, dy] }) => {
        setLook({ x: clamp(dx / 260) * 3.5, y: clamp(dy / 160) * 2.5 });
        setNear(Math.abs(dx) < 50 && dy < 22 ? "under" : Math.hypot(dx, dy) < 160 ? "near" : "far");
        // A shake: the cursor turning back and forth 4+ times in under 0.7 s.
        const s = shake.current, step = dx - s.last, dir = Math.sign(step);
        s.last = dx;
        if (Math.abs(step) < 25 || dir === s.dir) return;
        s.dir = dir;
        const now = Date.now();
        s.flips = [...s.flips.filter((t) => now - t < 700), now];
        if (s.flips.length >= 4) {
          s.flips = [];
          react.current.dizzyNow();
        }
      }),
      listen("click", () => react.current.poke()),
      listen("clipboard", () => react.current.winkNow()),
      listen<boolean>("typing", (e) => setTyping(e.payload)),
      listen<boolean>("away", (e) => {
        setAway(e.payload);
        if (!e.payload) react.current.welcomeNow();
      }),
    ];
    return () => offs.forEach((p) => p.then((off) => off()));
  }, [live]);

  const asleep = mood === "sleep" || away;
  const shape: Shape = asleep || blink ? "shut" : dizzy ? "dizzy"
    : mood === "music" || mood === "happy" || welcome || near === "under" ? "happy"
    : mood === "focus" || typing || squint ? "narrow" : "open";
  const gaze = typing || mood === "focus" ? { x: 0, y: 2 } : dizzy || asleep ? { x: 0, y: 0 } : look;
  const body = still ? {}
    : mood === "music" ? { animate: { rotate: [-6, 6, -6], y: [0, -1, 0] }, transition: { duration: 0.9, repeat: Infinity, ease: "easeInOut" as const } }
    : mood === "happy" || welcome ? { animate: { rotate: 0, y: [0, -3, 0, -1.5, 0] }, transition: { duration: 0.8 } }
    : { animate: { rotate: 0, y: 0 } };
  const eye = { shape, worried: mood === "worried", scale: near === "near" && shape === "open" ? 1.2 : mood === "worried" ? 0.85 : 1 };

  return (
    // Drawn for the notch (size 22) and scaled for bigger spots like empty pages.
    <span className="relative flex h-5 shrink-0 items-center px-1.5" style={{ zoom: size / 22 }} role="img" aria-label={`Kit's eyes, ${asleep ? "asleep" : mood}`}>
      <motion.span className="flex items-center" style={{ filter: glow(mood === "music" ? accent : "rgb(140 210 255 / 0.95)") }} {...body}>
        <motion.span className="flex items-center gap-2" animate={gaze} transition={{ type: "spring", stiffness: 260, damping: 22 }}>
          <Eye side={-1} wink={wink} {...eye} />
          <Eye side={1} wink={false} {...eye} />
        </motion.span>
      </motion.span>
      {!still && asleep && <Floater>z</Floater>}
      {!still && mood === "music" && <><Floater>♪</Floater><Floater delay={1.2}>♫</Floater></>}
    </span>
  );
}
