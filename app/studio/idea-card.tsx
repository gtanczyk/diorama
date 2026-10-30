import { useEffect, useState } from 'preact/hooks';
import { call } from './api.ts';
import { Icon } from './icons.tsx';
import { ReviewSketch } from './review-sketch.tsx';

const previews = new Map<string, { task: Promise<string>; image?: string }>();

/** Reference drawings are immediate. New concepts paint in the background and never block a choice. */
export function IdeaCard({ label, image, idea, scene, style, references, disabled, selected, hidden, onPick }: {
  label: string; image?: string; idea: string; scene: string; style?: string; references: string[];
  disabled: boolean; selected?: boolean; hidden?: boolean; onPick: () => void;
}) {
  const request = JSON.stringify({ idea, scene, ...(style && { style }), references });
  const [preview, setPreview] = useState(image ?? previews.get(request)?.image ?? '');
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let current = true;
    setPreview(image ?? previews.get(request)?.image ?? ''); setFailed(false);
    if (image) return;
    let task = previews.get(request)?.task;
    if (!task) {
      task = call<{ image: string }>('idea_preview', JSON.parse(request)).then(r => r.image);
      // A long Studio session must not retain every uploaded reference in these keys.
      while (previews.size >= 12) previews.delete(previews.keys().next().value!);
      previews.set(request, { task });
      void task.then(src => { const entry = previews.get(request); if (entry && entry.task === task) entry.image = src; })
        .catch(() => { if (previews.get(request)?.task === task) previews.delete(request); });
    }
    void task.then(src => { if (current) setPreview(src); }).catch(() => { if (current) setFailed(true); });
    return () => { current = false; };
  }, [request, image]);
  return <button type="button" class={`idea-card${selected ? ' selected' : ''}`} aria-label={label} aria-pressed={selected} hidden={hidden} disabled={disabled} onClick={onPick}>
    <span class={`idea-card-picture${!preview && !failed ? ' painting' : ''}`}>
      {preview ? <img src={preview} alt="" /> : <span class="idea-card-placeholder">{failed ? <Icon name="brush" size={25} /> : <ReviewSketch compact />}<small>{failed ? 'Preview unavailable' : 'Sketching…'}</small></span>}
      {selected && <span class="idea-card-mark" aria-hidden="true">✓</span>}
    </span>
    <span class="idea-card-caption"><strong>{label}</strong><small>{selected ? 'Your choice' : image ? 'Your picture' : 'Concept sketch'}</small></span>
  </button>;
}
