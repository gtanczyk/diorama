import { useEffect, useRef, useState } from 'preact/hooks';
import { call } from './api.ts';
import { ConceptEdit, type ConceptChange } from './concept-edit.tsx';
import type { ReviewInput } from './idea-review.tsx';

export type Look = { title: string; description: string; reference?: string };

export function CustomLook({ input, scene, busy, onChoose, onClose }: {
  input: ReviewInput; scene: string; busy: boolean; onChoose: (look: Look) => void; onClose: () => void;
}) {
  const [draft, setDraft] = useState<{ look: Look; image: string }>();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const active = useRef(true), pending = useRef(false);
  useEffect(() => () => { active.current = false; }, []);
  const preview = async ({ change, reference }: ConceptChange) => {
    if (pending.current || busy) return;
    pending.current = true; setWorking(true); setError('');
    try {
      const look = await call<Look>('idea_style', { words: change ?? '', ...(reference && { reference }) });
      const { image } = await call<{ image: string }>('idea_preview', { idea: input.idea, scene, style: look.description, ...(look.reference && { styleReference: look.reference }), references: input.photos.slice(0, 4).map(p => p.data) });
      if (active.current) setDraft({ look, image });
    } catch (e) { if (active.current) setError((e as Error).message); }
    finally { pending.current = false; if (active.current) setWorking(false); }
  };
  return <section class="custom-look" aria-label="Your own style" aria-busy={working}>
    <ConceptEdit label="your style" purpose="style" disabled={busy || working} onGenerate={preview} onClose={onClose} onDraftChange={() => setDraft(undefined)} />
    {error && <p class="error" role="alert">{error}</p>}
    {working && <p role="status"><span class="review-spinner" aria-hidden="true" /> Sketching your style…</p>}
    {draft && <div class="custom-look-preview">
      <button type="button" class="ghost bare" data-lightbox={draft.image} aria-label="Enlarge your style preview"><img src={draft.image} alt={draft.look.title} /></button>
      <p>{draft.look.description}</p>
      <button type="button" class="amber" disabled={busy || working} onClick={() => onChoose(draft.look)}>Use this style</button>
    </div>}
  </section>;
}
