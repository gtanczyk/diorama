import { audioIssues, type AudioMisses } from '../src/sound/issues.ts';

export function AudioMissing({ misses, retry }: { misses: AudioMisses; retry: () => void }) {
  const groups = audioIssues(misses);
  const waiting = groups.filter((g) => g.kind === 'validation');
  const count = waiting.reduce((n, g) => n + g.count, 0);
  const other = misses.lines.length - count;
  const nice = (s: string) => s.replace(/-/g, ' ');
  const labels = { validation: 'verification pending', design: 'voice creation pending', rejected: 'did not pass audio checks', unavailable: 'generation unavailable' };
  return <>
    {waiting.length > 0 && <p>Voice verification is pending for {waiting.length} {waiting.length === 1 ? 'voice' : 'voices'}, blocking {count} {count === 1 ? 'line' : 'lines'}. The verification service could not finish; this does not mean the voices sound bad.</p>}
    {(other > 0 || misses.sounds.length > 0) && <p>{other} other spoken {other === 1 ? 'line' : 'lines'} and {misses.sounds.length} {misses.sounds.length === 1 ? 'sound' : 'sounds'} are missing.</p>}
    <p class="note">You can play, but this audio is missing. Retry checks saved voice samples again and generates new audio only when needed.</p>
    <details><summary>Audio details · {groups.length} {groups.length === 1 ? 'group' : 'groups'}</summary>
      <ul>{groups.map((g) => <li key={`${g.kind}:${g.speaker ?? g.id}`}>
        <strong>{nice(g.speaker ?? g.id!)}: {labels[g.kind]}{g.speaker ? ` (${g.count} ${g.count === 1 ? 'line' : 'lines'})` : ''}</strong>
        <p class="detail" style={{ overflowWrap: 'anywhere' }}>{g.reason}</p>
      </li>)}</ul>
    </details>
    <div class="btns"><button type="button" class="ghost small" onClick={retry}>Retry missing audio</button></div>
  </>;
}
