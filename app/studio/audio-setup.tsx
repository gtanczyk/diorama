import { useEffect, useState } from 'preact/hooks';
import { call } from './api.ts';

type AudioSettings = { quality: 'final' | 'draft'; env: string | null };

export function AudioSetup() {
  const [settings, setSettings] = useState<AudioSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => { void call<AudioSettings>('audio_get').then(setSettings).catch((e) => setError(e.message)); }, []);
  const choose = async (quality: string) => {
    setBusy(true); setError(''); setSaved(false);
    try { setSettings(await call<AudioSettings>('audio_set', { quality })); setSaved(true); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <section class="budget" aria-label="Audio settings">
    <h2>Audio</h2>
    <div class="prices"><label>Audio quality
      <select value={settings?.quality ?? ''} disabled={!settings || busy || settings.env !== null} onChange={(e) => void choose(e.currentTarget.value)}>
        {!settings && <option value="">Loading…</option>}
        <option value="final">Final (default)</option>
        <option value="draft">Draft (lower cost)</option>
      </select>
    </label></div>
    <p class="note">Final uses richer voices, more attempts to get lines right and longer ambience. Draft uses fewer credits for quick previews.</p>
    <p class="note">Applies to future audio generations in all worlds. To upgrade existing recordings, rerun Voices and Sound. This does not rewrite dialogue.</p>
    {settings?.env !== null && settings?.env !== undefined && <p class="note">Set by DIORAMA_SOUND={settings.env}. Unset it and restart Studio to change this here.</p>}
    <span role="status">{busy ? 'Saving…' : saved ? 'Saved' : ''}</span>
    {error && <p class="error" role="alert">{error}</p>}
  </section>;
}
