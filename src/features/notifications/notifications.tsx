// Notification history: everything that arrived this session, grouped by app. Click one to open
// its app; ✕ removes it here and from the Windows notification centre.
import { useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AnimatePresence, motion } from "motion/react";
import { Icon } from "../../components/icons";
import { AppLogo, ago, useNow, type Note } from "../../island/system";
import { useTip } from "../../components/tooltip";
import { Kit } from "../../island/kit";

export type StoredNote = Note & { at: number };

function RemoveButton({ onClick }: { onClick: () => void }) {
  return (
    <button aria-label="Remove" {...useTip("Remove")}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="grid size-6 shrink-0 place-items-center rounded-full text-white/45 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-white/12 hover:text-white">
      <Icon name="close" size={12} />
    </button>
  );
}

export function NotificationsView({ notes, onRemove, onClear }: { notes: StoredNote[]; onRemove: (id: number) => void; onClear: () => void }) {
  const now = useNow(30_000);
  // Apps in the order of their newest notification.
  const groups = useMemo(() => {
    const byApp = new Map<string, StoredNote[]>();
    for (const n of notes) byApp.set(n.aumid || n.app, [...(byApp.get(n.aumid || n.app) ?? []), n]);
    return [...byApp.values()];
  }, [notes]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 px-1">
        <span className="text-white/50"><Icon name="bell" size={16} /></span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold">Notifications</div>
          <div className="text-[11px] text-white/40">{notes.length ? `${notes.length} this session · click one to open its app` : "This session"}</div>
        </div>
        {notes.length > 0 && (
          <button onClick={onClear} className="flex h-7 shrink-0 items-center rounded-full bg-white/10 px-3 text-[12px] font-medium hover:bg-white/18">
            Clear all
          </button>
        )}
      </div>
      {notes.length === 0 ? (
        <div className="flex h-24 flex-col items-center justify-center gap-1 text-center text-[12.5px] text-white/50">
          <Kit mood="idle" size={26} />
          <div>No notifications yet.</div>
          <div className="text-[11.5px] text-white/35">Messages from WhatsApp, Teams, mail and others collect here.</div>
        </div>
      ) : (
        <div className="no-scrollbar -mx-1 flex max-h-64 flex-col gap-2 overflow-y-auto" onWheel={(e) => e.stopPropagation()}>
          <AnimatePresence initial={false}>
            {groups.map((group) => (
              <motion.div key={group[0].aumid || group[0].app} layout initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                className="rounded-2xl bg-white/5 p-1.5">
                <div className="flex items-center gap-2 px-1.5 pt-0.5 pb-1">
                  <AppLogo note={group[0]} size={18} />
                  <span className="flex-1 truncate text-[11.5px] font-medium text-white/60">{group[0].app}</span>
                  {group.length > 1 && <span className="text-[10.5px] text-white/35">{group.length}</span>}
                </div>
                {group.map((n) => (
                  <motion.div key={n.id} layout exit={{ opacity: 0, x: 20 }} role="button"
                    onClick={() => invoke("open_app", { aumid: n.aumid }).catch(() => {})}
                    className="group flex cursor-pointer items-start gap-2 rounded-xl px-1.5 py-1.5 transition-colors hover:bg-white/6">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="truncate text-[12.5px] font-semibold">{n.title || n.app}</span>
                        <span className="shrink-0 text-[10.5px] text-white/35">{ago(n.at, now)}</span>
                      </div>
                      {n.body && <div className="line-clamp-2 text-[12px] whitespace-pre-line text-white/65">{n.body}</div>}
                    </div>
                    <RemoveButton onClick={() => onRemove(n.id)} />
                  </motion.div>
                ))}
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}
