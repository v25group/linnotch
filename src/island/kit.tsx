// Kit, the fox who lives in the resting notch (a baby fox is a "kit"; the linnotch logo is a fox).
// Drawn small and simple on purpose: at ~22px a detailed fox turns to mush, so it's a round head,
// pointy ears, a pale muzzle, eyes and a tail. Kit's mood says what's going on instead of text,
// and when nothing is, Kit keeps busy with little things (looking around, a wander, a yawn...).
import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "motion/react";

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

export function Kit({ mood, size = 22, accent = "#ff6b9a" }: { mood: Mood; size?: number; accent?: string }) {
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
