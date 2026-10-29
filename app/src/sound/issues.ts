/** Shared with Studio; old manifests are classified too, without regenerating any audio. */
export type AudioMisses = {
  sounds: Array<{ id: string; reason: string }>;
  lines: Array<{ speaker: string; text: string; reason: string }>;
};
type Kind = 'validation' | 'design' | 'rejected' | 'unavailable';
export type AudioIssue = { kind: Kind; speaker?: string; id?: string; count: number; reason: string };

export function audioIssues(misses: AudioMisses): AudioIssue[] {
  const groups = new Map<string, AudioIssue>();
  for (const line of misses.lines) {
    const kind: Kind = /validation pending|transcribe .*?(backlog|busy|overload|socket|timed out|closed)|transcription unavailable/i.test(line.reason) ? 'validation'
      : /waiting for a designed voice|Voice Design pending/i.test(line.reason) ? 'design'
      : /speech rejected/i.test(line.reason) ? 'rejected' : 'unavailable';
    const key = `${kind}:${line.speaker}`;
    const group = groups.get(key);
    if (group) group.count++;
    else groups.set(key, { kind, speaker: line.speaker, count: 1, reason: line.reason });
  }
  return [...groups.values(), ...misses.sounds.map((s): AudioIssue => ({ kind: /rejected/i.test(s.reason) ? 'rejected' : 'unavailable', id: s.id, count: 1, reason: s.reason }))];
}
