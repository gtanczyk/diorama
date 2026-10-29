// Activity: what ran in this world, newest first. Each job is one row (what, who, how it went, how long, which
// models it called) with its steps folded under it; the agent's and your clicks fold into one line per run of them.
import { SAYS } from './agent.tsx';
import { MODEL_NAME, nowBy } from './build.tsx';
import { Icon, type IconName } from './icons.tsx';

export type ActivityJob = { id: string; label: string; args: string[]; state: string; by: string; error?: string; queuedAt?: string; startedAt?: string; endedAt?: string };
export type ActivityLine = { seq: number; text: string; kind: string; at?: number; job?: string; info?: ActivityJob; who?: 'you' | 'agent'; act?: string };

type Group =
  | { type: 'job'; id: string; info: ActivityJob; lines: ActivityLine[]; at: number }
  | { type: 'acts'; who: 'you' | 'agent'; acts: string[]; at: number; last: number }
  | { type: 'line'; line: ActivityLine; at: number };

/** What a job is, as a sign. */
function sign(j: ActivityJob): IconName {
  // A build of one step ("derive · canal-walk") is that step.
  const [first] = j.label.split(/[\s·]/);
  const cmd = j.args[0] === 'build' && STEPS.has(first) ? first : j.args[0];
  if (cmd === 'build') return 'build';
  if (j.args.includes('--animate') || /animate/i.test(j.label)) return 'cube';
  if (cmd === 'cast' || cmd === 'model' || cmd === 'sprites') return 'person';
  if (cmd === 'story' || cmd === 'world') return 'book';
  if (cmd === 'paint' || cmd === 'layout' || /repaint|style/i.test(j.label)) return 'brush';
  if (cmd === 'masks' || cmd === 'plates' || /mask|thing/i.test(j.label)) return 'scissors';
  if (cmd === 'derive' || /floor|stand|walk/i.test(j.label)) return 'ruler';
  if (cmd === 'sound' || cmd === 'voices' || /voice/i.test(j.label)) return 'sound';
  if (cmd === 'icons') return 'bag';
  if (cmd === 'export' || cmd === 'publish') return 'box';
  return 'gear';
}

const STEPS = new Set(['world', 'story', 'layout', 'paint', 'masks', 'plates', 'icons', 'derive', 'backdrop', 'weather', 'cast', 'model', 'sprites', 'sound', 'voices', 'verify']);

const STATE: Record<string, { mark: string; word: string }> = {
  queued: { mark: '⏳', word: 'waiting' },
  running: { mark: '●', word: 'running' },
  done: { mark: '✓', word: 'done' },
  failed: { mark: '✕', word: 'failed' },
  cancelled: { mark: '–', word: 'stopped' },
};

const clock = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.floor(ms / 60_000)} min ${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')} s`);
const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
/** An action as a person would say it: "Look at a place ×3". */
const said = (name: string) => SAYS[name] ?? name.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

export function Activity({ lines, costs, all }: { lines: ActivityLine[]; costs: Record<string, Record<string, number>>; all: boolean }) {
  const groups: Group[] = [];
  const jobs = new Map<string, Extract<Group, { type: 'job' }>>();
  for (const l of lines) {
    const at = l.at ?? 0;
    if (l.job) {
      let g = jobs.get(l.job);
      if (!g) {
        // The click that started this job is the job's row now: drop it from the clicks just before.
        const before = groups.at(-1);
        const by = l.info?.by === 'agent' ? 'agent' : 'you';
        if (before?.type === 'acts' && before.who === by && at - before.last < 3000) {
          before.acts.pop();
          if (!before.acts.length) groups.pop();
        }
        g = { type: 'job', id: l.job, info: l.info ?? { id: l.job, label: 'a job', args: [], state: 'running', by: 'user' }, lines: [], at };
        jobs.set(l.job, g);
        groups.push(g);
      }
      if (l.info) g.info = l.info;
      else if (all || l.kind !== 'out') g.lines.push(l);
      continue;
    }
    if (l.act && l.who) {
      const last = groups.at(-1);
      if (last?.type === 'acts' && last.who === l.who) (last.acts.push(l.act), (last.last = at));
      else groups.push({ type: 'acts', who: l.who, acts: [l.act], at, last: at });
      continue;
    }
    if (all || l.kind !== 'out') groups.push({ type: 'line', line: l, at });
  }
  if (!groups.length) return <p class="note">Nothing yet: builds, the agent's steps and your clicks show here as they happen.</p>;
  return (
    <ol class="activity">
      {[...groups].reverse().map((g) => {
        if (g.type === 'job') {
          const j = g.info;
          const st = STATE[j.state] ?? { mark: '·', word: j.state };
          const took = j.startedAt ? (j.endedAt ? Date.parse(j.endedAt) : Date.now()) - Date.parse(j.startedAt) : 0;
          const models = Object.entries(costs[j.id] ?? {});
          return (
            <li class={`a-job ${j.state}`} key={`j${j.id}`}>
              <details open={j.state === 'running' || j.state === 'failed'}>
                <summary>
                  <span class="a-sign"><Icon name={sign(j)} /></span>
                  <span class="a-what"><strong>{j.label}</strong><small>{j.by === 'agent' ? 'the agent' : 'you'} · {time(Date.parse(j.queuedAt ?? '') || g.at)}{took ? ` · ${clock(took)}` : ''}{models.length ? ` · ${models.map(([m, n]) => `${nowBy(MODEL_NAME[m] ?? m)} ${n}`).join(', ')}` : ''}</small></span>
                  <span class={`a-state ${j.state}`} title={st.word}>{st.mark} {st.word}</span>
                  {(g.lines.length > 0 || j.error) && <span class="a-more" aria-hidden="true" />}
                </summary>
                {j.error && <p class="a-error">{j.error}</p>}
                {g.lines.length > 0 && <ul class="a-steps">{g.lines.map((l) => <li class={l.kind}>{l.text}</li>)}</ul>}
              </details>
            </li>
          );
        }
        if (g.type === 'acts') {
          // Runs of the same action fold: "Look at a place ×3".
          const runs: Array<[string, number]> = [];
          for (const a of g.acts) runs.at(-1)?.[0] === a ? runs.at(-1)![1]++ : runs.push([a, 1]);
          return (
            <li class={`a-acts ${g.who}`} key={`a${g.at}-${g.acts.length}`}>
              <span class="a-sign"><Icon name={g.who === 'agent' ? 'agent' : 'hand'} /></span>
              <span class="a-what"><small>{g.who === 'agent' ? 'The agent' : 'You'} · {time(g.at)}</small><span>{runs.map(([a, n]) => `${said(a)}${n > 1 ? ` ×${n}` : ''}`).join(' · ')}</span></span>
            </li>
          );
        }
        const l = g.line;
        return (
          <li class={`a-line ${l.kind}`} key={`l${l.seq}`}>
            <span class="a-sign">{l.kind === 'play' ? <Icon name="play" /> : l.kind === 'err' ? <Icon name="warning" /> : l.kind === 'agent' ? <Icon name="agent" /> : '·'}</span>
            <span class="a-what"><span>{l.text.replace(/^play: /, '')}</span></span>
          </li>
        );
      })}
    </ol>
  );
}
