// One shared tooltip for the island. The first one waits a beat; moving straight on to another
// control keeps it open and slides it over, the way native toolbars do.
import { createContext, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";

type Tip = { owner: string; text: string; x: number; y: number };
type Api = { show: (tip: Tip) => void; hide: (owner?: string) => void };

const TipContext = createContext<Api>({ show() {}, hide() {} });

const DELAY = 450;
const WARM = 300; // ms after a tooltip closes during which the next one opens at once

export function TooltipLayer({ active, children }: { active: boolean; children: React.ReactNode }) {
  const [tip, setTip] = useState<Tip | null>(null);
  const [round, setRound] = useState(0); // a new round pops in fresh instead of sliding
  const current = useRef<Tip | null>(null);
  const pending = useRef<{ owner: string; timer: number } | null>(null);
  const hiddenAt = useRef(0);

  const api = useMemo<Api>(() => {
    const set = (t: Tip | null) => {
      if (current.current && !t) hiddenAt.current = Date.now();
      current.current = t;
      setTip(t);
    };
    const cancel = () => {
      clearTimeout(pending.current?.timer);
      pending.current = null;
    };
    return {
      show(next) {
        cancel();
        if (current.current || Date.now() - hiddenAt.current < WARM) return set(next);
        pending.current = { owner: next.owner, timer: setTimeout(() => (setRound((r) => r + 1), set(next)), DELAY) };
      },
      hide(owner) {
        if (!owner || pending.current?.owner === owner) cancel();
        if (current.current && (!owner || current.current.owner === owner)) set(null);
      },
    };
  }, []);

  // The window stops getting mouse events once the cursor leaves the island, so no
  // pointerleave arrives; close the tooltip when Rust says the cursor has gone.
  useEffect(() => {
    if (!active) api.hide();
  }, [active, api]);

  return (
    <TipContext.Provider value={api}>
      {children}
      <AnimatePresence>
        {tip && (
          <motion.div
            key={round}
            className="pointer-events-none fixed z-50 flex flex-col items-center"
            style={{ x: "-50%" }}
            initial={{ opacity: 0, scale: 0.92, left: tip.x, top: tip.y - 4 }}
            animate={{ opacity: 1, scale: 1, left: tip.x, top: tip.y }}
            exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.12 } }}
            transition={{ type: "spring", stiffness: 520, damping: 36 }}
          >
            <div className="-mb-1 size-2 rotate-45 rounded-xs bg-[#1c1c1e]" />
            <motion.div
              layout
              className="overflow-hidden rounded-lg bg-[#1c1c1e] px-2.5 py-1 text-[12px] font-medium whitespace-nowrap text-white/90"
              style={{ boxShadow: "inset 0 0 0 1px rgb(255 255 255 / 0.08), 0 6px 18px rgb(0 0 0 / 0.35)" }}
              transition={{ type: "spring", stiffness: 520, damping: 36 }}
            >
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.span key={tip.text} className="block"
                  initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.14 }}>
                  {tip.text}
                </motion.span>
              </AnimatePresence>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </TipContext.Provider>
  );
}

/** Props that give an element the island's tooltip, shown centred below it. */
export function useTip(text: string | undefined) {
  const api = useContext(TipContext);
  const owner = useId();
  useEffect(() => () => api.hide(owner), [api, owner]);
  if (!text) return {};
  return {
    onPointerEnter: (e: React.PointerEvent<HTMLElement>) => {
      const r = e.currentTarget.getBoundingClientRect();
      api.show({ owner, text, x: r.left + r.width / 2, y: r.bottom + 8 });
    },
    onPointerLeave: () => api.hide(owner),
    onPointerDown: () => api.hide(owner),
  };
}
