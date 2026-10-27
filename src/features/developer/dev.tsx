// The Developer tab (src-tauri/src/dev.rs): commands run with `notch`, AI agents (Claude Code
// hooks), listening ports, CPU/RAM meters and GitHub pull requests through the `gh` CLI.
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AnimatePresence, motion } from "motion/react";
import { Icon, type IconName } from "../../components/icons";
import { COLOR, ago, clockText, useNow, type Flash } from "../../island/system";
import { useTip } from "../../components/tooltip";
import claudeLogo from "../../assets/claude.png";
import { Kit, type Mood } from "../../island/kit";
import claudeThinking from "../../assets/claude-thinking.gif";
import { load, save } from "../../lib/storage";

type DevEvent = {
  id: string; kind: "task" | "agent"; title: string; state: "running" | "waiting" | "done" | "failed";
  detail?: string | null; cwd?: string | null; hwnd?: number | null; code?: number | null; ms?: number | null;
  /** A failed task couldn't get this port. */
  port?: number | null;
  /** An agent is waiting for Allow / Deny from the island. */
  ask?: boolean | null;
};
export type Job = DevEvent & { started: number; updated: number };
type Port = { port: number; pid: number; name: string; public: boolean; project: string | null };
type Meters = { cpu: number; ram: number; ram_used_gb: number; ram_total_gb: number };
type Setup = { cli: boolean; claude_found: boolean; claude: boolean; shell: boolean };

/** A pop-up from the dev tools; hovering it gives a card that can jump to the terminal or the page. */
export type DevFlash = {
  icon: IconName; color: string; title: string; subtitle?: string; hwnd?: number | null; url?: string;
  /** Agent id with a question waiting: the card shows Allow / Deny. */
  ask?: string;
  /** Port a failed command couldn't get: the card offers to free it. */
  port?: number | null;
  /** From Claude Code: shown with its logo instead of the icon. */
  agent?: boolean;
};

const DEV_KEY = "island.devTab";

/** Whether the Developer tab is on (Settings → Tabs). Off for people who never need it: no
    tab, no GitHub polling, no dev-server pop-ups. `notch` still reports, since that's asked for.
    New installs start with it off; an update keeps it on for people who already had it
    (a last-run version is saved, see src/features/settings/settings.tsx). */
export function useDevEnabled() {
  const [on, setOn] = useState(() => {
    const saved = load(DEV_KEY);
    if (saved) return saved === "1";
    const on = !!load("island.lastVersion");
    save(DEV_KEY, on ? "1" : "0");
    return on;
  });
  const toggle = useCallback(() => setOn((v) => (save(DEV_KEY, v ? "0" : "1"), !v)), []);
  return { on, toggle };
}

/** Allow or deny an agent's tool call from the island. */
export const answer = (id: string, allow: boolean) => invoke("answer_ask", { id, allow });
/** Stops what's on a port; resolves to what it was ("node"). */
export const freePort = (port: number) => invoke<string>("free_port", { port });

const GREEN = COLOR.charge;
const RED = COLOR.low;
const AMBER = COLOR.tool;
const BLUE = COLOR.bluetooth;

const folder = (p?: string | null) => p?.split(/[\\/]/).filter(Boolean).pop();
const seconds = (ms: number) => (ms < 60_000 ? `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s` : clockText(ms));

const focus = (hwnd?: number | null) => hwnd && invoke("focus_window", { hwnd }).catch(() => {});
const openUrl = (url: string) => invoke("open_url", { url }).catch(() => {});

/** Tasks and agents as they report in, newest first, with a pop-up when one needs you or ends. */
export function useDev(show: (f: Flash) => void, enabled: boolean) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const known = useRef(new Map<string, Job>());
  const announce = useRef(show);
  announce.current = show;
  const on = useRef(enabled);
  on.current = enabled;
  const update = useCallback((id: string, change: Partial<Job>) => {
    const job = known.current.get(id);
    if (!job) return;
    known.current.set(id, { ...job, ...change, updated: Date.now() });
    setJobs([...known.current.values()].sort((a, b) => b.updated - a.updated).slice(0, 20));
  }, []);

  useEffect(() => {
    const offs = [
      listen<DevEvent>("dev", ({ payload: e }) => {
        const now = Date.now();
        const prev = known.current.get(e.id);
        const job: Job = {
          ...prev, ...e,
          // Agents only say where they are when you submit a prompt; keep it for later reports.
          hwnd: e.hwnd ?? prev?.hwnd,
          started: e.state === "running" && prev?.state !== "running" ? now : prev?.started ?? now,
          updated: now,
        };
        known.current.set(e.id, job);
        setJobs([...known.current.values()].sort((a, b) => b.updated - a.updated).slice(0, 20));
        const where = folder(job.cwd);
        if (job.kind === "task" && (job.state === "done" || job.state === "failed")) {
          const ok = job.state === "done";
          announce.current({ kind: "dev", dev: {
            icon: ok ? "passed" : "failed", color: ok ? GREEN : RED, title: job.title, hwnd: job.hwnd, port: job.port,
            subtitle: ok ? [`Done in ${seconds(job.ms ?? now - job.started)}`, where].filter(Boolean).join(" · ")
              : job.port ? `Port ${job.port} is already in use` : job.detail || `Failed with exit code ${job.code}`,
          } });
        } else if (job.ask) {
          announce.current({ kind: "dev", dev: {
            icon: "agent", agent: true, color: AMBER, hwnd: job.hwnd, ask: job.id, title: `${job.title} asks to run`, subtitle: job.detail ?? undefined,
          } });
        } else if (job.kind === "agent" && (job.state === "waiting" || job.state === "done") && prev?.state !== job.state) {
          announce.current({ kind: "dev", dev: {
            icon: "agent", agent: true, color: job.state === "waiting" ? AMBER : GREEN, hwnd: job.hwnd,
            title: `${job.title} ${job.state === "waiting" ? "needs you" : "finished"}`, subtitle: job.detail ?? undefined,
          } });
        }
      }),
      // The question was answered here, or went to the terminal after 55 s.
      listen<{ id: string; answered: boolean }>("ask-done", ({ payload }) => {
        update(payload.id, payload.answered ? { ask: false, state: "running", detail: "Working…" } : { ask: false });
      }),
      listen<Port>("port-opened", ({ payload: p }) => {
        if (!on.current) return;
        announce.current({ kind: "dev", dev: {
          icon: "server", color: BLUE, title: `localhost:${p.port} is up`, url: `http://localhost:${p.port}`,
          subtitle: [p.name, p.project, p.public && "reachable on your network"].filter(Boolean).join(" · "),
        } });
      }),
    ];
    return () => offs.forEach((off) => off.then((f) => f()));
  }, [update]);

  const dismiss = useCallback((id: string) => {
    known.current.delete(id);
    setJobs((list) => list.filter((j) => j.id !== id));
  }, []);
  const clearFinished = useCallback(() => {
    for (const [id, j] of known.current) if (j.state === "done" || j.state === "failed") known.current.delete(id);
    setJobs((list) => list.filter((j) => j.state === "running" || j.state === "waiting"));
  }, []);

  return {
    jobs, dismiss, clearFinished,
    running: jobs.filter((j) => j.kind === "task" && j.state === "running"),
    waiting: jobs.filter((j) => j.kind === "agent" && j.state === "waiting"),
  };
}

export type Dev = ReturnType<typeof useDev>;

function usePoll<T>(command: string, ms: number, active: boolean) {
  const [value, setValue] = useState<T | null>(null);
  const refresh = useCallback(() => invoke<T>(command).then(setValue).catch(() => {}), [command]);
  useEffect(() => {
    if (!active) return;
    refresh();
    const id = setInterval(refresh, ms);
    return () => clearInterval(id);
  }, [active, ms, refresh]);
  return [value, refresh] as const;
}

export const useMeters = (active: boolean) => usePoll<Meters>("meters", 1500, active)[0];

// ---- GitHub ------------------------------------------------------------------------------------

type Check = "SUCCESS" | "FAILURE" | "ERROR" | "PENDING" | "EXPECTED" | null;
type PullRequest = { number: number; title: string; url: string; repo: string; draft?: boolean; review?: string | null; checks?: Check; author?: string; branch?: string };
type Issue = { number: number; title: string; url: string; repo: string };
type Run = { id: number; name: string; title: string; status: string; conclusion: string | null; url: string; repo: string; branch: string; event: string; updated: string };
type GitHubLists = { mine: PullRequest[]; toReview: PullRequest[]; issues: Issue[]; runs: Run[] };
type GitHubState = GitHubLists & { error: string | null; loaded: boolean };

/** The reply of the `github` command (src-tauri/src/dev.rs) -> the lists. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parse(reply: any): GitHubLists {
  const data = reply?.graphql?.data;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nodes = (x: any): any[] => (x?.nodes ?? []).filter((n: any) => n?.url);
  return {
    mine: nodes(data?.viewer?.pullRequests).map((n) => ({
      number: n.number, title: n.title, url: n.url, repo: n.repository?.nameWithOwner ?? "", draft: n.isDraft, branch: n.headRefName,
      review: n.reviewDecision, checks: n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null,
    })),
    toReview: nodes(data?.reviews).map((n) => ({ number: n.number, title: n.title, url: n.url, repo: n.repository?.nameWithOwner ?? "", author: n.author?.login })),
    issues: nodes(data?.issues).map((n) => ({ number: n.number, title: n.title, url: n.url, repo: n.repository?.nameWithOwner ?? "" })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runs: (reply?.runs ?? []).map((r: any) => ({
      id: r.id, name: r.name, title: r.display_title, status: r.status, conclusion: r.conclusion, url: r.html_url,
      repo: r.repo, branch: r.head_branch, event: r.event, updated: r.updated_at ?? "",
    })).sort((a: Run, b: Run) => b.updated.localeCompare(a.updated)).slice(0, 8),
  };
}

const finished = (c: Check) => c === "SUCCESS" || c === "FAILURE" || c === "ERROR";
const RUN_OK = ["success", "skipped", "neutral"];

/** Polls GitHub every 90 s (every 10 min while `gh` is missing or signed out), and pops up when
    checks on your PR finish, a workflow run of yours finishes, or someone asks for your review. */
export function useGitHub(show: (f: Flash) => void, enabled: boolean) {
  const [state, setState] = useState<GitHubState>({ mine: [], toReview: [], issues: [], runs: [], error: null, loaded: false });
  const prev = useRef<{ checks: Map<string, Check>; review: Set<string>; runs: Map<number, string> } | null>(null);
  const announce = useRef(show);
  announce.current = show;

  const refresh = useCallback(async () => {
    try {
      const lists = parse(await invoke("github"));
      const { mine, toReview, runs } = lists;
      const before = prev.current;
      if (before) {
        for (const pr of mine) {
          if (before.checks.get(pr.url) === "PENDING" && finished(pr.checks ?? null)) {
            const ok = pr.checks === "SUCCESS";
            announce.current({ kind: "dev", dev: { icon: ok ? "passed" : "failed", color: ok ? GREEN : RED, url: pr.url,
              title: ok ? "Checks passed" : "Checks failed", subtitle: `${pr.repo}#${pr.number} · ${pr.title}` } });
          }
        }
        for (const pr of toReview.filter((p) => !before.review.has(p.url))) {
          announce.current({ kind: "dev", dev: { icon: "pr", color: BLUE, url: pr.url,
            title: `${pr.author ?? "Someone"} asked for your review`, subtitle: `${pr.repo}#${pr.number} · ${pr.title}` } });
        }
        // Runs on a branch with an open PR already pop up as that PR's checks.
        const prBranches = new Set(mine.map((p) => `${p.repo}:${p.branch}`));
        for (const run of runs) {
          const was = before.runs.get(run.id);
          if (was && was !== "completed" && run.status === "completed" && !prBranches.has(`${run.repo}:${run.branch}`)) {
            const ok = RUN_OK.includes(run.conclusion ?? "");
            announce.current({ kind: "dev", dev: { icon: ok ? "passed" : "failed", color: ok ? GREEN : RED, url: run.url,
              title: `${run.name} ${ok ? "passed" : run.conclusion === "cancelled" ? "was cancelled" : "failed"}`, subtitle: `${run.repo} · ${run.branch} · ${run.title}` } });
          }
        }
      }
      prev.current = {
        checks: new Map(mine.map((p) => [p.url, p.checks ?? null])),
        review: new Set(toReview.map((p) => p.url)),
        runs: new Map(runs.map((r) => [r.id, r.status])),
      };
      setState({ ...lists, error: null, loaded: true });
    } catch (e) {
      setState((s) => ({ ...s, error: String(e), loaded: true }));
    }
  }, []);

  const setupMissing = state.error === "gh-missing" || state.error === "gh-auth";
  useEffect(() => {
    if (!enabled) return;
    refresh();
    const id = setInterval(refresh, setupMissing ? 600_000 : 90_000);
    return () => clearInterval(id);
  }, [refresh, setupMissing, enabled]);
  return { ...state, refresh };
}

export type GitHub = ReturnType<typeof useGitHub>;

// ---- Notch, pop-up and card --------------------------------------------------------------------

function Spinner({ size = 13, color }: { size?: number; color?: string }) {
  return (
    <motion.span className="grid" style={{ color }} animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1, ease: "linear" }}>
      <Icon name="loading" size={size} />
    </motion.span>
  );
}

/** In the resting notch: an agent waiting for you, else the running task with its time and the CPU. */
export function DevChip({ dev, meters }: { dev: Dev; meters: Meters | null }) {
  const now = useNow(dev.running.length ? 1000 : null);
  const waiting = dev.waiting[0];
  const task = dev.running[0];
  return (
    <AnimatePresence>
      {waiting ? (
        <motion.span key="waiting" initial={{ opacity: 0, scale: 0.6 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.6 }}
          className="flex shrink-0 items-center gap-1.5" style={{ color: AMBER }}>
          <motion.span className="size-1.5 rounded-full" style={{ background: AMBER }} animate={{ opacity: [1, 0.3, 1] }} transition={{ repeat: Infinity, duration: 1.4 }} />
          Needs you
        </motion.span>
      ) : task ? (
        <motion.span key="task" initial={{ opacity: 0, scale: 0.6 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.6 }}
          className="flex shrink-0 items-center gap-1.5 whitespace-nowrap" style={{ color: BLUE }}>
          <Spinner />
          <span>{clockText(now - task.started)}</span>
          {meters && <span className="text-white/45">CPU {meters.cpu}%</span>}
        </motion.span>
      ) : null}
    </AnimatePresence>
  );
}

/** Claude's logo for its pop-ups, the flash's icon for everything else. */
function Mark({ flash, size }: { flash: DevFlash; size: number }) {
  return flash.agent
    ? <img src={claudeLogo} alt="Claude" className="shrink-0 object-contain" style={{ width: size, height: size }} draggable={false} />
    : <span className="grid shrink-0 place-items-center" style={{ color: flash.color }}><Icon name={flash.icon} size={size} /></span>;
}

/** The pop-up: centred like the download and update ones, the mark drops in beside the title. */
export function DevFlashView({ flash }: { flash: DevFlash }) {
  return (
    <div className="flex h-15 flex-col items-center justify-center gap-0.5 px-5 text-center">
      <div className="flex max-w-full items-center gap-1.5 text-[13.5px] font-semibold">
        <motion.span className="grid shrink-0 place-items-center"
          initial={{ y: -12, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ type: "spring", stiffness: 400, damping: 18 }}>
          <Mark flash={flash} size={16} />
        </motion.span>
        <span className="truncate">{flash.title}</span>
      </div>
      {flash.subtitle && <div className={`max-w-full truncate text-[11.5px] ${flash.ask ? "font-mono" : ""}`} style={{ color: flash.ask ? flash.color : "rgb(255 255 255 / 0.55)" }}>{flash.subtitle}</div>}
    </div>
  );
}

const solid = "flex h-8 flex-1 items-center justify-center gap-1.5 rounded-full text-[12.5px] font-semibold hover:brightness-90";
const quiet = "flex h-8 flex-1 items-center justify-center gap-1.5 rounded-full bg-white/10 text-[12.5px] font-medium hover:bg-white/18";

/** Allow / Deny for an agent's question. Deny is as easy as Allow, and the exact call is shown. */
function AskButtons({ id, onDone, small }: { id: string; onDone?: () => void; small?: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const reply = (allow: boolean) => answer(id, allow).then(onDone).catch((e) => setError(String(e)));
  if (error) return <span className="text-[11px] text-white/45">{error}</span>;
  const size = small ? "h-7 flex-none px-3 text-[12px]" : "";
  return (
    <>
      <button onClick={(e) => { e.stopPropagation(); reply(false); }} className={`${quiet} ${size}`}>Deny</button>
      <button onClick={(e) => { e.stopPropagation(); reply(true); }} className={`${solid} ${size} bg-[#30d158] text-black`}>Allow</button>
    </>
  );
}

/** "Port 3000 is already in use": stop whatever holds it. */
function FreePortButton({ port, small }: { port: number; small?: boolean }) {
  const [result, setResult] = useState<string | null>(null);
  if (result) return <span className="flex items-center text-[11.5px] text-white/55">{result}</span>;
  return (
    <button onClick={(e) => { e.stopPropagation(); freePort(port).then((name) => setResult(`Stopped ${name} · run it again`)).catch((err) => setResult(String(err))); }}
      className={small ? "h-7 shrink-0 rounded-full bg-[#ff453a] px-3 text-[11.5px] font-semibold text-white" : `${solid} bg-[#ff453a] text-white`}>
      Free :{port}
    </button>
  );
}

export function DevCard({ flash, onDone }: { flash: DevFlash; onDone: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 p-4 text-center">
      {/* The mark front and centre in a tile, with a dot in the state's colour (amber asks, green done...). */}
      <motion.div className="relative" initial={{ scale: 0.85, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", stiffness: 420, damping: 24 }}>
        <span className="grid size-13 place-items-center rounded-2xl bg-white/8" style={{ boxShadow: "inset 0 0 0 1px rgb(255 255 255 / 0.08)" }}>
          <Mark flash={flash} size={flash.agent ? 30 : 26} />
        </span>
        <span className="absolute -right-1 -bottom-1 size-3.5 rounded-full ring-2 ring-black" style={{ background: flash.color }} />
      </motion.div>
      <div className="w-full min-w-0">
        <div className="truncate px-2 text-[14px] font-semibold">{flash.title}</div>
        {flash.subtitle && (
          <div className={`mt-1 line-clamp-3 px-1 text-[12px] [overflow-wrap:anywhere] ${flash.ask ? "rounded-lg bg-white/6 px-2 py-1.5 text-left font-mono text-white/75" : "text-white/55"}`}>{flash.subtitle}</div>
        )}
      </div>
      <div className="flex w-full gap-2">
        {flash.ask ? <AskButtons id={flash.ask} onDone={onDone} /> : (
          <>
            {flash.port && <FreePortButton port={flash.port} />}
            {flash.hwnd && (
              <button onClick={() => { focus(flash.hwnd); onDone(); }} className={`${solid} bg-white text-black`}>
                <Icon name="terminal" size={14} />Go to window
              </button>
            )}
            {flash.url && (
              <button onClick={() => { openUrl(flash.url!); onDone(); }} className={`${solid} bg-white text-black`}>
                <Icon name="globe" size={14} />Open
              </button>
            )}
            <button onClick={onDone} className={quiet}>Dismiss</button>
          </>
        )}
      </div>
    </div>
  );
}

// ---- The tab -----------------------------------------------------------------------------------

type Pane = "tasks" | "ports" | "github" | "tools";
const PANES: { id: Pane; label: string }[] = [
  { id: "tasks", label: "Tasks" }, { id: "ports", label: "Ports" }, { id: "github", label: "GitHub" }, { id: "tools", label: "Tools" },
];

function IconButton({ icon, tip, onClick, color }: { icon: IconName; tip: string; onClick: () => void; color?: string }) {
  return (
    <button aria-label={tip} {...useTip(tip)} onClick={(e) => { e.stopPropagation(); onClick(); }}
      className="grid size-7 shrink-0 place-items-center rounded-full text-white/55 hover:bg-white/12 hover:text-white" style={{ color }}>
      <Icon name={icon} size={14} />
    </button>
  );
}

const List = ({ children }: { children: React.ReactNode }) => (
  <div className="no-scrollbar -mx-1 max-h-52 overflow-y-auto" onWheel={(e) => e.stopPropagation()}>{children}</div>
);
/** Kit naps when all is quiet and looks worried when something's wrong. */
const Empty = ({ title, hint, kit = "sleep" }: { title: string; hint?: React.ReactNode; kit?: Mood }) => (
  <div className="flex h-24 flex-col items-center justify-center gap-1 px-4 text-center text-[12.5px] text-white/50">
    <Kit mood={kit} size={24} />
    <div>{title}</div>
    {hint && <div className="text-[11.5px] text-white/35">{hint}</div>}
  </div>
);
const Code = ({ children }: { children: React.ReactNode }) => (
  <code className="rounded bg-white/10 px-1 py-px font-mono text-[11px] text-white/75">{children}</code>
);
const Heading = ({ children }: { children: React.ReactNode }) => (
  <div className="px-2 pt-1 text-[10.5px] font-semibold tracking-wide text-white/35 uppercase">{children}</div>
);

function SetupRow({ title, hint, done, action, onClick }: { title: string; hint: React.ReactNode; done: boolean; action: string; onClick: () => void }) {
  return (
    <div className="flex items-center gap-2.5 px-1">
      <span style={{ color: done ? GREEN : "rgb(255 255 255 / 0.35)" }}><Icon name={done ? "passed" : "code"} size={16} /></span>
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] font-medium">{title}</div>
        <div className="truncate text-[11px] text-white/40">{hint}</div>
      </div>
      {done ? <span className="text-[11.5px] text-white/45">Ready</span> : (
        <button onClick={onClick} className="flex h-7 shrink-0 items-center rounded-full bg-white px-3 text-[12px] font-semibold text-black hover:brightness-90">{action}</button>
      )}
    </div>
  );
}

function TasksPane({ dev, setup, onSetup }: { dev: Dev; setup: Setup | null; onSetup: () => void }) {
  const now = useNow(1000);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const act = (command: string, args?: Record<string, unknown>) =>
    invoke<string | null>(command, args)
      .then((text) => setMessage(typeof text === "string" ? { text, error: false } : null))
      .catch((e) => setMessage({ text: String(e), error: true }))
      .finally(onSetup);
  const needsSetup = setup && (!setup.cli || !setup.shell || (setup.claude_found && !setup.claude));
  const finished = dev.jobs.some((j) => j.state === "done" || j.state === "failed");

  return (
    <div className="flex flex-col gap-2">
      {needsSetup && (
        <div className="flex flex-col gap-2 rounded-2xl bg-white/5 p-2.5">
          <SetupRow title="The notch command" done={setup.cli} action="Set up" onClick={() => act("install_cli")}
            hint={<>Then <Code>notch npm test</Code> in a new terminal</>} />
          <SetupRow title="Watch long commands" done={setup.shell} action="Turn on" onClick={() => act("shell_watch", { on: true })}
            hint="Anything over 10 s pops up, no notch needed" />
          {setup.claude_found && (
            <SetupRow title="Claude Code" done={setup.claude} action="Connect" onClick={() => act("connect_claude", { on: true })}
              hint="Allow or deny from here; pops up when it needs you" />
          )}
        </div>
      )}
      {message && <div className="px-1 text-[11px]" style={{ color: message.error ? RED : "rgb(255 255 255 / 0.55)" }}>{message.text}</div>}
      {dev.jobs.length === 0 ? (
        <Empty title="Nothing running." hint={<>Start a build or tests with <Code>notch npm run build</Code> and watch it here.</>} />
      ) : (
        <List>
          {dev.jobs.map((j) => {
            const color = j.state === "running" ? BLUE : j.state === "waiting" ? AMBER : j.state === "done" ? GREEN : RED;
            const status =
              j.state === "running" ? (j.kind === "agent" ? "Working…" : `Running · ${clockText(now - j.started)}`)
              : j.state === "waiting" ? j.detail ?? "Needs your input"
              : j.state === "done" ? [j.ms != null ? `Done in ${seconds(j.ms)}` : "Finished", ago(j.updated, now)].join(" · ")
              : j.port ? `Port ${j.port} is already in use` : j.detail || `Exit code ${j.code}`;
            return (
              <div key={j.id} role="button" onClick={() => focus(j.hwnd)}
                className="group flex cursor-pointer items-center gap-3 rounded-xl px-2 py-1.5 transition-colors hover:bg-white/6">
                <span className="grid size-7 shrink-0 place-items-center" style={{ color }}>
                  {j.kind === "agent"
                    ? <img src={j.state === "running" ? claudeThinking : claudeLogo} alt="Claude" className={j.state === "running" ? "size-7" : "size-4.5"} draggable={false} />
                    : j.state === "running" ? <Spinner size={16} color={color} /> : <Icon name={j.state === "failed" ? "failed" : "passed"} size={17} />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-[12px] text-white/90">{j.title}</div>
                  <div className={`truncate text-[11px] ${j.ask ? "font-mono" : ""}`} style={{ color: j.state === "failed" ? RED : j.ask ? AMBER : "rgb(255 255 255 / 0.42)" }}>
                    {j.ask ? status : [status, folder(j.cwd)].filter(Boolean).join(" · ")}
                  </div>
                </div>
                {j.ask ? (
                  <span className="flex shrink-0 gap-1.5"><AskButtons id={j.id} small /></span>
                ) : j.state === "failed" && j.port ? (
                  <FreePortButton port={j.port} small />
                ) : (
                  <span className="flex shrink-0 opacity-0 transition-opacity group-hover:opacity-100">
                    {j.hwnd && <IconButton icon="terminal" tip="Go to window" onClick={() => focus(j.hwnd)} />}
                    <IconButton icon="close" tip="Dismiss" onClick={() => dev.dismiss(j.id)} />
                  </span>
                )}
              </div>
            );
          })}
        </List>
      )}
      {(finished || setup?.claude || setup?.shell) && (
        <div className="flex items-center gap-3 px-1 text-[11px] text-white/40">
          {finished && <button onClick={dev.clearFinished} className="hover:text-white/75">Clear finished</button>}
          <span className="flex-1" />
          {setup?.shell && <button onClick={() => act("shell_watch", { on: false })} className="hover:text-white/75">Stop watching commands</button>}
          {setup?.claude && <button onClick={() => act("connect_claude", { on: false })} className="hover:text-white/75">Disconnect Claude</button>}
        </div>
      )}
    </div>
  );
}

function useStopConfirm() {
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (!confirm) return;
    const id = setTimeout(() => setConfirm(false), 3000);
    return () => clearTimeout(id);
  }, [confirm]);
  return [confirm, setConfirm] as const;
}

function useNote() {
  const [note, setNote] = useState<string | null>(null);
  const say = (text: string) => {
    setNote(text);
    setTimeout(() => setNote(null), 1800);
  };
  return [note, say] as const;
}

function StopButton({ confirm, onAsk, onStop, tip }: { confirm: boolean; onAsk: () => void; onStop: () => void; tip: string }) {
  return confirm ? (
    <button onClick={onStop} className="ml-0.5 h-7 rounded-full bg-[#ff453a] px-2.5 text-[11.5px] font-semibold text-white">Stop?</button>
  ) : (
    <IconButton icon="stopCircle" tip={tip} onClick={onAsk} />
  );
}

function PortRow({ p, onStopped }: { p: Port; onStopped: () => void }) {
  const [confirm, setConfirm] = useStopConfirm();
  const [note, say] = useNote();
  const url = `http://localhost:${p.port}`;
  const lanTip = useTip("Other devices on your network can reach it");
  return (
    <div className="group flex items-center gap-3 rounded-xl px-2 py-1.5 transition-colors hover:bg-white/6">
      <span className="w-13 shrink-0 font-mono text-[13px] font-semibold" style={{ color: BLUE }}>:{p.port}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 truncate text-[12.5px]">
          <span className="truncate">{p.project ?? p.name}</span>
          {p.public && <span className="shrink-0 rounded-full bg-[#ff9f0a]/15 px-1.5 text-[10px] font-medium text-[#ff9f0a]" {...lanTip}>LAN</span>}
        </div>
        <div className="truncate text-[11px] text-white/40">{note ?? `${p.name} · PID ${p.pid}`}</div>
      </div>
      <span className="flex shrink-0 items-center">
        <IconButton icon="globe" tip="Open in browser" onClick={() => openUrl(url)} />
        <IconButton icon="copy" tip="Copy URL" onClick={() => invoke("clipboard_write", { text: url }).then(() => say("Copied " + url)).catch(() => {})} />
        <StopButton confirm={confirm} onAsk={() => setConfirm(true)} tip="Stop this server"
          onStop={() => invoke("stop_port", { port: p.port, pid: p.pid }).then(onStopped).catch((e) => say(String(e))).finally(() => setConfirm(false))} />
      </span>
    </div>
  );
}

type Container = { id: string; name: string; image: string; status: string; ports: string };

/** "0.0.0.0:5432->5432/tcp, :::5432->5432/tcp" -> 5432 (the first port published on this PC). */
const hostPort = (ports: string) => Number(/:(\d+)->/.exec(ports)?.[1]) || null;

function ContainerRow({ c, onStopped }: { c: Container; onStopped: () => void }) {
  const [confirm, setConfirm] = useStopConfirm();
  const [note, say] = useNote();
  const port = hostPort(c.ports);
  return (
    <div className="flex items-center gap-3 rounded-xl px-2 py-1.5 transition-colors hover:bg-white/6">
      <span className="w-13 shrink-0 font-mono text-[13px] font-semibold text-[#64d2ff]">{port ? `:${port}` : "—"}</span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px]">{c.name}</div>
        <div className="truncate text-[11px] text-white/40">{note ?? `${c.image} · ${c.status}`}</div>
      </div>
      <span className="flex shrink-0 items-center">
        {port && <IconButton icon="globe" tip="Open in browser" onClick={() => openUrl(`http://localhost:${port}`)} />}
        <StopButton confirm={confirm} onAsk={() => setConfirm(true)} tip="Stop this container"
          onStop={() => { say("Stopping…"); invoke("stop_container", { id: c.id }).then(onStopped).catch((e) => say(String(e))).finally(() => setConfirm(false)); }} />
      </span>
    </div>
  );
}

function PortsPane({ active }: { active: boolean }) {
  const [ports, refresh] = usePoll<Port[]>("ports", 3000, active);
  // null: Docker isn't installed or running, so there's no section for it.
  const [containers, refreshContainers] = usePoll<Container[] | null>("containers", 5000, active);
  if (!ports) return <div className="flex h-24 items-center justify-center gap-2 text-[12.5px] text-white/50"><Spinner />Looking at ports…</div>;
  if (!ports.length && !containers?.length) {
    return <Empty title="No dev servers running." hint={<>Start one (<Code>npm run dev</Code>, <Code>python manage.py runserver</Code>, <Code>cargo run</Code>…) and it shows up here.</>} />;
  }
  return (
    <List>
      {containers && containers.length > 0 && ports.length > 0 && <Heading>Servers</Heading>}
      {ports.map((p) => <PortRow key={`${p.port}-${p.pid}`} p={p} onStopped={refresh} />)}
      {containers && containers.length > 0 && <Heading>Docker</Heading>}
      {containers?.map((c) => <ContainerRow key={c.id} c={c} onStopped={refreshContainers} />)}
    </List>
  );
}

const CHECK: Record<string, { color: string; label: string }> = {
  SUCCESS: { color: GREEN, label: "Checks passed" }, FAILURE: { color: RED, label: "Checks failed" }, ERROR: { color: RED, label: "Checks errored" },
  PENDING: { color: AMBER, label: "Checks running" }, EXPECTED: { color: AMBER, label: "Checks waiting" },
};

function LinkRow({ url, icon, color, title, meta }: { url: string; icon: IconName; color?: string; title: string; meta: (string | false | null | undefined)[] }) {
  return (
    <button onClick={() => openUrl(url)} className="flex w-full items-center gap-3 rounded-xl px-2 py-1.5 text-left transition-colors hover:bg-white/6">
      <span className="grid size-7 shrink-0 place-items-center" style={{ color: color ?? "rgb(255 255 255 / 0.35)" }}><Icon name={icon} size={16} /></span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px]">{title}</div>
        <div className="truncate text-[11px] text-white/40">{meta.filter(Boolean).join(" · ")}</div>
      </div>
    </button>
  );
}

function runLook(r: Run): { color: string; label: string } {
  if (r.status !== "completed") return { color: AMBER, label: r.status === "queued" ? "Queued" : "Running" };
  if (RUN_OK.includes(r.conclusion ?? "")) return { color: GREEN, label: "Passed" };
  return { color: r.conclusion === "cancelled" ? "rgb(255 255 255 / 0.4)" : RED, label: r.conclusion === "cancelled" ? "Cancelled" : "Failed" };
}

function GitHubPane({ github }: { github: GitHub }) {
  const now = useNow(60_000);
  if (github.error === "gh-missing") return <Empty kit="worried" title="Needs the GitHub CLI." hint={<>Install it with <Code>winget install GitHub.cli</Code>, then <Code>gh auth login</Code></>} />;
  if (github.error === "gh-auth") return <Empty kit="worried" title="Sign in to the GitHub CLI." hint={<>Run <Code>gh auth login</Code> in a terminal</>} />;
  if (!github.loaded) return <div className="flex h-24 items-center justify-center gap-2 text-[12.5px] text-white/50"><Spinner />Asking GitHub…</div>;
  const empty = !github.mine.length && !github.toReview.length && !github.issues.length && !github.runs.length;
  if (github.error && empty) return <Empty kit="worried" title="Couldn't reach GitHub." hint={github.error} />;
  if (empty) return <Empty title="All quiet on GitHub." hint="Your pull requests, reviews asked of you, assigned issues and workflow runs show up here." />;
  return (
    <List>
      {github.toReview.length > 0 && <Heading>Waiting for your review</Heading>}
      {github.toReview.map((pr) => <LinkRow key={pr.url} url={pr.url} icon="pr" color={BLUE} title={pr.title} meta={[`${pr.repo}#${pr.number}`, pr.author && `by ${pr.author}`]} />)}
      {github.mine.length > 0 && <Heading>Your pull requests</Heading>}
      {github.mine.map((pr) => {
        const check = pr.checks ? CHECK[pr.checks] : null;
        const review = pr.review === "APPROVED" ? "Approved" : pr.review === "CHANGES_REQUESTED" ? "Changes requested" : null;
        return <LinkRow key={pr.url} url={pr.url} icon="pr" color={check?.color} title={pr.title} meta={[`${pr.repo}#${pr.number}`, pr.draft && "Draft", check?.label, review]} />;
      })}
      {github.runs.length > 0 && <Heading>Your workflow runs</Heading>}
      {github.runs.map((r) => {
        const look = runLook(r);
        return <LinkRow key={r.id} url={r.url} icon={look.label === "Passed" ? "passed" : look.label === "Failed" ? "failed" : "loading"} color={look.color}
          title={`${r.name} · ${r.title}`} meta={[look.label, r.repo, r.branch, r.updated && ago(Date.parse(r.updated), now)]} />;
      })}
      {github.issues.length > 0 && <Heading>Assigned to you</Heading>}
      {github.issues.map((i) => <LinkRow key={i.url} url={i.url} icon="alert" color="#7cc4ff" title={i.title} meta={[`${i.repo}#${i.number}`]} />)}
    </List>
  );
}

// ---- Tools: things developers copy a dozen times a day -------------------------------------------

function password(length = 24) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*-_=+";
  const bytes = crypto.getRandomValues(new Uint32Array(length));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

const TOOLS: { label: string; hint: string; make: () => string }[] = [
  { label: "UUID", hint: "A new random v4 UUID", make: () => crypto.randomUUID() },
  { label: "Unix time", hint: "Seconds since 1970, now", make: () => String(Math.floor(Date.now() / 1000)) },
  { label: "Unix ms", hint: "Milliseconds since 1970, now", make: () => String(Date.now()) },
  { label: "ISO 8601", hint: "Now, in UTC", make: () => new Date().toISOString() },
  { label: "Password", hint: "24 random characters", make: () => password() },
  { label: "Hex secret", hint: "32 random bytes as hex", make: () => Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("") },
];

function ToolsPane() {
  const [copied, setCopied] = useState<{ label: string; value: string } | null>(null);
  const copy = (t: (typeof TOOLS)[number]) => {
    const value = t.make();
    invoke("clipboard_write", { text: value }).then(() => setCopied({ label: t.label, value })).catch(() => {});
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-3 gap-1.5">
        {TOOLS.map((t) => (
          <button key={t.label} onClick={() => copy(t)}
            className="flex flex-col items-start rounded-xl bg-white/5 px-2.5 py-2 text-left transition-colors hover:bg-white/10 active:scale-[0.98]">
            <span className="text-[12.5px] font-medium">{t.label}</span>
            <span className="w-full truncate text-[10.5px] text-white/40">{t.hint}</span>
          </button>
        ))}
      </div>
      <div className="flex h-5 items-center gap-1.5 px-1 text-[11px] text-white/45">
        {copied ? (
          <>
            <span style={{ color: GREEN }}><Icon name="check" size={12} /></span>
            Copied {copied.label}: <span className="min-w-0 truncate font-mono text-white/70">{copied.label === "Password" || copied.label === "Hex secret" ? "•".repeat(12) : copied.value}</span>
          </>
        ) : "Click to copy a fresh one. Decoding JSON, tokens and timestamps happens in the Clipboard tab."}
      </div>
    </div>
  );
}

export function DevView({ dev, github, meters }: { dev: Dev; github: GitHub; meters: Meters | null }) {
  const [pane, setPane] = useState<Pane>("tasks");
  const [setup, refreshSetup] = usePoll<Setup>("dev_setup", 60_000, true);
  const cpuTip = useTip("Processor");
  const ramTip = useTip(meters ? `${meters.ram_used_gb.toFixed(1)} of ${meters.ram_total_gb.toFixed(0)} GB memory in use` : "Memory");
  useEffect(() => {
    if (pane === "github") github.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane]);

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2 px-1">
        <div className="flex flex-1 gap-1">
          {PANES.map((p) => (
            <button key={p.id} onClick={() => setPane(p.id)}
              className={`relative flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium transition-colors ${pane === p.id ? "text-black" : "bg-white/8 text-white/70 hover:bg-white/14"}`}>
              {pane === p.id && <motion.span layoutId="dev-pane" className="absolute inset-0 rounded-full bg-white" transition={{ type: "spring", stiffness: 500, damping: 36 }} />}
              <span className="relative">{p.label}</span>
              {p.id === "tasks" && dev.waiting.length > 0 && <span className="relative size-1.5 rounded-full" style={{ background: AMBER }} />}
            </button>
          ))}
        </div>
        {meters && (
          <div className="flex shrink-0 items-center gap-2.5 text-[11px] text-white/50 tabular-nums">
            <span className="flex items-center gap-1" {...cpuTip}><Icon name="cpu" size={13} />{meters.cpu}%</span>
            <span className="flex items-center gap-1" {...ramTip}>
              <Icon name="ram" size={13} />{meters.ram}%
            </span>
          </div>
        )}
      </div>
      {pane === "tasks" && <TasksPane dev={dev} setup={setup} onSetup={refreshSetup} />}
      {pane === "ports" && <PortsPane active />}
      {pane === "github" && <GitHubPane github={github} />}
      {pane === "tools" && <ToolsPane />}
    </div>
  );
}
