import { useEffect, useRef, useState } from 'preact/hooks';
import { shrink } from './camera.tsx';

export type ConceptChange = { change?: string; reference?: { name: string; data: string } };

/** A small conversation beside the picture, rather than another setup form. */
export function ConceptEdit({ label, disabled, onGenerate, onClose }: {
  label: string; disabled: boolean; onGenerate: (change: ConceptChange) => void; onClose: () => void;
}) {
  const [words, setWords] = useState('');
  const [reference, setReference] = useState<ConceptChange['reference']>();
  const [reading, setReading] = useState(false);
  const [error, setError] = useState('');
  const picker = useRef<HTMLInputElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const uploading = useRef(false);
  useEffect(() => {
    form.current?.querySelector('textarea')?.focus({ preventScroll: true });
    form.current?.scrollIntoView({ block: 'center', behavior: 'instant' });
  }, []);
  const add = async (file?: File) => {
    if (!file || disabled || uploading.current) return;
    if (!file.type.startsWith('image/')) { setError('Choose an image for this reference.'); return; }
    uploading.current = true; setReading(true); setError('');
    try {
      const data = await shrink(file);
      if (data.length > 8_000_000) throw new Error('This picture is too large. Try a smaller image.');
      setReference({ name: (file.name || 'pasted-image').slice(0, 120), data });
    } catch (e) { setError((e as Error).message); }
    finally { uploading.current = false; setReading(false); }
  };
  return <form ref={form} class="concept-edit" aria-label={`Change ${label}`} onSubmit={e => {
    e.preventDefault();
    if (!disabled && !reading && (words.trim() || reference)) onGenerate({ ...(words.trim() && { change: words.trim() }), ...(reference && { reference }) });
  }} onPaste={e => {
    const file = [...(e.clipboardData?.files ?? [])].find(f => f.type.startsWith('image/'));
    if (file) { e.preventDefault(); void add(file); }
  }}>
    <label>What would you change?<textarea autoFocus aria-label={`Changes for ${label}`} value={words} maxLength={1200} rows={3} disabled={disabled} placeholder="A bigger hat, warmer colours…" onInput={e => setWords(e.currentTarget.value)} /></label>
    <p>Describe the picture, or paste a reference here.</p>
    {reference && <div class="concept-reference"><button type="button" class="ghost bare" data-lightbox={reference.data} aria-label="Enlarge reference"><img src={reference.data} alt="Your reference" /></button><button type="button" class="ghost small" disabled={disabled || reading} onClick={() => setReference(undefined)}>Remove</button></div>}
    <input hidden ref={picker} type="file" accept="image/*" aria-label={`Reference for ${label}`} onChange={e => { void add(e.currentTarget.files?.[0]); e.currentTarget.value = ''; }} />
    <div class="concept-edit-tools"><button type="button" class="ghost small" disabled={disabled || reading} onClick={() => picker.current?.click()}>{reading ? 'Reading picture…' : '+ Picture'}</button><button type="button" class="ghost small" disabled={disabled || reading} onClick={onClose}>Cancel</button><button type="submit" class="primary small" disabled={disabled || reading || !words.trim() && !reference}>Regenerate</button></div>
    {error && <p class="error" role="alert">{error}</p>}
  </form>;
}
