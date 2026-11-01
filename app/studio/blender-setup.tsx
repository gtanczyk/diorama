import { useEffect, useState } from 'preact/hooks';
import { call } from './api.ts';

type BlenderState = { enabled: boolean; active: boolean; env: string | null; installed: { bin: string; version: string } | null };

/** Setup: the optional local Blender that gives 3D figures a calm rest pose, and its on/off switch. */
export function BlenderSetup() {
  const [state, setState] = useState<BlenderState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { void call<BlenderState>('blender_get').then(setState).catch((e) => setError(e.message)); }, []);
  const toggle = async (enabled: boolean) => {
    setBusy(true); setError('');
    try { setState(await call<BlenderState>('blender_set', { enabled })); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <section class="budget blender" aria-label="Blender">
    <h2>3D animation</h2>
    <label class="switch-row" title="Free, runs on this computer. New 3D models get it automatically; existing ones with Relax in the cast (cast_relax)">
      <span>Use Blender for natural walks</span>
      <input type="checkbox" role="switch" checked={!!state?.enabled} disabled={!state || busy || state.env !== null} onChange={(e) => void toggle(e.currentTarget.checked)} />
    </label>
    <p class="note">{!state ? 'Looking for Blender…'
      : state.installed ? `Blender ${state.installed.version} found${state.active ? ', in use' : ', not in use'}. It puts each 3D figure into a calm pose (arms down, feet under the hips) before it walks; without it they walk legs apart, arms out.`
      : 'Not installed. On a Mac: brew install --cask blender, or blender.org. Then Check again. Without it 3D figures walk legs apart, arms out.'}</p>
    {state?.env !== null && state?.env !== undefined && <p class="note">Set by DIORAMA_BLENDER={state.env}. Unset it and restart Studio to switch it here.</p>}
    {error && <p class="error" role="alert">{error}</p>}
  </section>;
}
