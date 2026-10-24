// Notes (src-tauri/src/notes.rs): plain-text files in Documents\linnotch\Notes, edited here or in
// Notepad, plus text files dropped on the island (edited in place). Typing saves a moment later;
// Ctrl+S saves now, Ctrl+N (or New) starts a fresh note. Edits made in Notepad show up here.
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AnimatePresence, motion } from "motion/react";
import { Icon } from "../../components/icons";
import { useTip } from "../../components/tooltip";

type Note = { path: string; name: string; text: string; modified: number; external: boolean };
type NoteInfo = { path: string; name: string; preview: string; modified: number };

/** "24 Oct 12.18": the new note's file name. */
const stamp = () => {
  const d = new Date();
  return `${d.toLocaleDateString([], { day: "numeric", month: "short" })} ${String(d.getHours()).padStart(2, "0")}.${String(d.getMinutes()).padStart(2, "0")}`;
};
const firstLine = (text: string) => text.split("\n").map((l) => l.trim()).find(Boolean)?.slice(0, 40) ?? "";
const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

function ToolButton({ onClick, tip, children, danger }: { onClick: () => void; tip: string; children: React.ReactNode; danger?: boolean }) {
  return (
    <button onClick={onClick} aria-label={tip} {...useTip(tip)}
      className={`flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium transition-colors ${danger ? "bg-[#ff453a] text-white" : "bg-white/10 hover:bg-white/18"}`}>
      {children}
    </button>
  );
}

export function NotesView({ open, onOpened }: { open: { path: string; nonce: number } | null; onOpened: () => void }) {
  const [list, setList] = useState<NoteInfo[]>([]);
  const [note, setNote] = useState<Note | null>(null);
  const [text, setText] = useState("");
  const [status, setStatus] = useState<"saved" | "saving" | "error">("saved");
  const [toast, setToast] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const dirty = useRef(false);
  const modified = useRef(0);
  const area = useRef<HTMLTextAreaElement>(null);
  const chips = useRef<HTMLDivElement>(null);
  const opening = useRef(!!open);
  const state = useRef({ note, text });
  state.current = { note, text };

  const say = useCallback((message: string) => {
    setToast(message);
    setTimeout(() => setToast((t) => (t === message ? null : t)), 2200);
  }, []);
  const refreshList = useCallback(() => invoke<NoteInfo[]>("notes_list").then(setList).catch(() => {}), []);

  const show = useCallback((n: Note) => {
    setNote(n);
    setText(n.text);
    modified.current = n.modified;
    dirty.current = false;
    setStatus("saved");
    setConfirmDelete(false);
    requestAnimationFrame(() => area.current?.focus());
  }, []);

  /** Writes what's typed now, if anything changed. Resolves once it's on disk. */
  const flush = useCallback(async () => {
    const { note, text } = state.current;
    if (!note || !dirty.current) return true;
    setStatus("saving");
    try {
      modified.current = await invoke<number>("note_write", { path: note.path, text });
      dirty.current = false;
      setStatus("saved");
      refreshList();
      return true;
    } catch {
      setStatus("error");
      return false;
    }
  }, [refreshList]);

  const newNote = useCallback(async () => {
    const { note, text } = state.current;
    if (note && !note.external && !text.trim()) {
      area.current?.focus();
      return say("This note is empty: just start typing");
    }
    if (!(await flush())) return say("Couldn't save, so no new note yet");
    const fresh = await invoke<Note>("note_new", { stamp: stamp() });
    show(fresh);
    refreshList();
    say(note && text.trim() ? `Saved “${firstLine(text) || note.name}” · new note` : "New note");
  }, [flush, show, refreshList, say]);

  const switchTo = useCallback(async (path: string) => {
    if (path === state.current.note?.path) return;
    await flush();
    invoke<Note>("note_read", { path }).then(show).catch(() => say("Couldn't open that note"));
  }, [flush, show, say]);

  // First open: the newest note, or a fresh one.
  useEffect(() => {
    invoke<NoteInfo[]>("notes_list").then((found) => {
      setList(found);
      if (state.current.note || opening.current) return;
      if (found.length) invoke<Note>("note_read", { path: found[0].path }).then(show).catch(() => {});
      else invoke<Note>("note_new", { stamp: stamp() }).then(show).catch(() => setStatus("error"));
    }).catch(() => setStatus("error"));
  }, [show]);

  // A text file dropped on the island.
  useEffect(() => {
    if (!open) return;
    (async () => {
      await flush();
      invoke<Note>("note_import", { path: open.path }).then((n) => {
        show(n);
        say(`Opened ${fileName(n.path)}`);
      }).catch((e) => say(String(e))).finally(onOpened);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, flush, show, say]);

  // Save half a second after the last key.
  useEffect(() => {
    if (!dirty.current) return;
    setStatus("saving");
    const id = setTimeout(flush, 600);
    return () => clearTimeout(id);
  }, [text, flush]);

  // Edits made in Notepad (unless you're mid-typing here). Saves what's pending when leaving the tab.
  useEffect(() => {
    const id = setInterval(() => {
      const n = state.current.note;
      if (!n || dirty.current) return;
      invoke<Note>("note_read", { path: n.path }).then((fresh) => {
        if (fresh.modified === modified.current || dirty.current) return;
        modified.current = fresh.modified;
        setText(fresh.text);
        say("Updated from Notepad");
      }).catch(() => {});
    }, 2000);
    return () => {
      clearInterval(id);
      flush();
    };
  }, [flush, say]);

  useEffect(() => {
    if (!confirmDelete) return;
    const id = setTimeout(() => setConfirmDelete(false), 3000);
    return () => clearTimeout(id);
  }, [confirmDelete]);

  const remove = async () => {
    if (!note) return;
    await invoke("note_delete", { path: note.path }).catch(() => {});
    const rest = (await invoke<NoteInfo[]>("notes_list").catch(() => [])).filter((n) => n.path !== note.path);
    setList(rest);
    if (rest.length) invoke<Note>("note_read", { path: rest[0].path }).then(show);
    else invoke<Note>("note_new", { stamp: stamp() }).then(show);
    say("Note deleted");
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const key = e.key.toLowerCase();
    if (key === "s") {
      e.preventDefault();
      flush().then((ok) => say(ok ? "Saved" : "Couldn't save"));
    } else if (key === "n") {
      e.preventDefault();
      newNote();
    }
  };

  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  // The dropped file (if one is open) first, then your notes.
  const shown = note?.external ? [{ path: note.path, name: note.name, preview: fileName(note.path), modified: note.modified }, ...list] : list;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 px-1">
        <span className="text-white/50"><Icon name={note?.external ? "file" : "note"} size={16} /></span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold">{note?.external ? fileName(note.path) : firstLine(text) || "New note"}</div>
          <div className="truncate text-[11px] text-white/40">
            {status === "error" ? "Couldn't save" : status === "saving" ? "Saving…" : `Saved · ${words} word${words === 1 ? "" : "s"}`}
            {" · Ctrl+S save · Ctrl+N new"}
          </div>
        </div>
        <ToolButton onClick={newNote} tip="New note (Ctrl+N)"><Icon name="plus" size={13} />New</ToolButton>
        {note && <ToolButton onClick={() => flush().then(() => invoke("note_open", { path: note.path }))} tip="Open in Notepad"><Icon name="external" size={12} /></ToolButton>}
        {note && !note.external && (confirmDelete
          ? <ToolButton onClick={remove} tip="Delete this note" danger>Delete?</ToolButton>
          : <ToolButton onClick={() => setConfirmDelete(true)} tip="Delete this note"><Icon name="trash" size={13} /></ToolButton>)}
      </div>

      {shown.length > 1 && (
        <div ref={chips} className="no-scrollbar -mx-0.5 flex gap-1.5 overflow-x-auto px-0.5"
          onWheel={(e) => chips.current && (chips.current.scrollLeft += e.deltaY + e.deltaX)}>
          {shown.map((n) => (
            <button key={n.path} onClick={() => switchTo(n.path)}
              className={`flex h-6 max-w-36 shrink-0 items-center rounded-full px-2.5 text-[11.5px] transition-colors ${n.path === note?.path ? "bg-white font-medium text-black" : "bg-white/8 text-white/65 hover:bg-white/14"}`}>
              <span className="truncate">{(n.path === note?.path ? firstLine(text) : n.preview) || n.name}</span>
            </button>
          ))}
        </div>
      )}

      <div className="relative">
        <textarea
          ref={area}
          value={text}
          disabled={!note}
          onChange={(e) => {
            dirty.current = true;
            setText(e.target.value);
          }}
          onKeyDown={onKey}
          onWheel={(e) => e.stopPropagation()}
          placeholder="Type anything: a phone number, a to-do, a snippet…"
          spellCheck={false}
          className={`no-scrollbar h-44 w-full resize-none rounded-2xl bg-white/5 px-3 py-2.5 text-[13px] leading-relaxed text-white/90 outline-none placeholder:text-white/30 focus:bg-white/8 ${note?.external ? "font-mono text-[12px]" : ""}`}
        />
        <AnimatePresence>
          {toast && (
            <motion.div key={toast} initial={{ opacity: 0, y: 8, scale: 0.95 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 4 }}
              transition={{ type: "spring", stiffness: 500, damping: 32 }}
              className="pointer-events-none absolute right-2.5 bottom-2.5 flex max-w-[85%] items-center gap-1.5 rounded-full bg-white px-3 py-1 text-[11.5px] font-medium text-black shadow-lg">
              <Icon name="check" size={12} /><span className="truncate">{toast}</span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
