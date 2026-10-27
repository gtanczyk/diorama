// The Muse Code panel: genaicode's own chat (genaicode/react), fed the session state the Studio server keeps
// for this world. The page holds no agent and no key: it sends what the person types and answers approvals.
import { AgentChat, type SessionState } from 'genaicode/react';
import { useEffect, useState } from 'preact/hooks';
import { token } from './api.ts';

/** What each Studio tool does, as the person would say it. */
const SAYS: Record<string, string> = {
  world_list: 'List worlds', world_status: 'World status', place_status: 'Look at a place', job_list: 'List jobs',
  job_wait: 'Wait for a job', job_cancel: 'Stop a job', job_retry: 'Run a job again', world_build: 'Build', run_step: 'Run a step',
  corrections_get: 'Read fixes', corrections_clear: 'Take fixes back', mask_fix: 'Fix a mask', mask_brush: 'Brush a mask',
  floor_cells: 'Fix floor cells', stand_set: 'Move a stand spot', repaint_region: 'Repaint a region', water_flow: 'Set water flow',
  feedback_pending: 'Read open notes', feedback_list: 'Read notes', feedback_done: 'Close a note', feedback_add: 'Leave a note', feedback_reopen: 'Reopen a note',
  history_list: 'Read history', history_undo: 'Undo a job', lock_set: 'Change a lock', ui_focus: 'Show a place', budget: 'Check budget', setup_status: 'Check Setup',
};

const auth = { authorization: `Bearer ${token}` };

/** Follows the world's conversation: one whole SessionState per change, reconnecting when the line drops. */
function useSession(slug: string): [SessionState | null, boolean] {
  const [state, setState] = useState<SessionState | null>(null);
  const [live, setLive] = useState(false);
  useEffect(() => {
    let stopped = false;
    let ctrl: AbortController | null = null;
    (async () => {
      while (!stopped) {
        ctrl = new AbortController();
        try {
          const res = await fetch(`/api/agent/${slug}/live`, { headers: auth, signal: ctrl.signal });
          if (!res.ok || !res.body) throw new Error(String(res.status));
          setLive(true);
          const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
          let buf = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += value;
            let cut;
            while ((cut = buf.indexOf('\n\n')) >= 0) {
              const data = buf.slice(0, cut).split('\n').find((l) => l.startsWith('data: '));
              buf = buf.slice(cut + 2);
              if (data) setState(JSON.parse(data.slice(6)) as SessionState | null);
            }
          }
        } catch {}
        setLive(false);
        if (!stopped) await new Promise((r) => setTimeout(r, 1500));
      }
    })();
    return () => {
      stopped = true;
      ctrl?.abort();
    };
  }, [slug]);
  return [state, live];
}

export function AgentPanel({ slug }: { slug: string }) {
  const [state, live] = useSession(slug);
  const [error, setError] = useState('');
  const post = async (verb: string, body: object = {}) => {
    setError('');
    const res = await fetch(`/api/agent/${slug}/${verb}`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `could not send (${res.status})`);
  };
  return (
    <section class="agent">
      <AgentChat
        state={state}
        onSend={(text) => void post('say', { text })}
        onStop={() => void post('stop')}
        onApprove={(id, decision) => void post('approval', { id, decision })}
        formatToolName={(name) => (name.startsWith('mcp__diorama__') ? SAYS[name.slice(14)] ?? name.slice(14).replace(/_/g, ' ') : name)}
        foldSteps
        theme="dark"
        disabled={!live}
        header={<div class="row"><h2>Muse Code</h2><span class="grow" /><span class={`live ${live ? 'on' : ''}`}>{state?.status === 'running' ? 'working…' : live ? 'ready' : 'reconnecting'}</span></div>}
        emptyState={<p class="note">Ask for a world, a fix or a check. The agent changes things only through the Studio's tools, the same as the buttons, so you see each step here and in Activity and can undo its jobs.</p>}
        hint={error ? <span class="error">{error}</span> : null}
      />
    </section>
  );
}
