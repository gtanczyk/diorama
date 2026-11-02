import { useEffect, useState } from 'preact/hooks';
import { call } from './api.ts';

type FacesState = { enabled: boolean; env: string | null };

/** Setup: talking mouths on or off. Off by default: barely visible in play, costly in calls and build time. */
export function FacesSetup() {
  const [state, setState] = useState<FacesState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { void call<FacesState>('faces_get').then(setState).catch((e) => setError(e.message)); }, []);
  const toggle = async (enabled: boolean) => {
    setBusy(true); setError('');
    try { setState(await call<FacesState>('faces_set', { enabled })); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <section class="budget blender" aria-label="Talking mouths">
    <h2>Talking mouths</h2>
    <label class="switch-row" title="Muse paints mouth shapes for each character's portrait and Spark checks them: about $0.20 and a few minutes a character">
      <span>Animate lips when characters speak</span>
      <input type="checkbox" role="switch" checked={!!state?.enabled} disabled={!state || busy || state.env !== null} onChange={(e) => void toggle(e.currentTarget.checked)} />
    </label>
    <p class="note">{state?.enabled ? 'On: after every place plays, each speaking character gets mouth shapes on its portrait (Muse Image, Spark).' : 'Off: characters speak with voice and gestures; builds skip the faces step. Mouths made earlier still play.'}</p>
    {state?.env != null && <p class="note">Set by DIORAMA_FACES={state.env}. Unset it and restart Studio to switch it here.</p>}
    {error && <p class="error" role="alert">{error}</p>}
  </section>;
}
