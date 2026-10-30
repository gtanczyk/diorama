import { useEffect, useRef, useState } from 'preact/hooks';
import type { Sketch, SketchApproval, SketchAsset } from '../src/world/sketch.ts';
import type { CreativeChoices } from '../src/world/idea-review.ts';
import type { ReviewInput } from './idea-review.tsx';
import { call } from './api.ts';
import { ReviewSketch } from './review-sketch.tsx';
import { ConceptEdit, type ConceptChange } from './concept-edit.tsx';

// Two paintings at a time. Leaving the preview prevents queued calls from starting.
let painting = 0;
const queue: Array<() => void> = [];
async function turn<T>(work: () => Promise<T>): Promise<T> {
  if (painting >= 2) await new Promise<void>(resolve => queue.push(resolve));
  else painting++;
  try { return await work(); } finally { const next = queue.shift(); if (next) next(); else painting--; }
}

function Concept({ sketch, asset, disabled, onSelect, onBusy }: {
  sketch: string; asset: SketchAsset; disabled: boolean;
  onSelect: (take: number) => void; onBusy: (busy: boolean, working: boolean) => void;
}) {
  const [versions, setVersions] = useState<Record<number, string>>({});
  const [largeVersions, setLargeVersions] = useState<Record<number, string>>({});
  const [directions, setDirections] = useState<Record<number, string>>({});
  const [editing, setEditing] = useState(false);
  const [revision, setRevision] = useState<ConceptChange & { baseTake?: number }>({});
  const [nextTake, setNextTake] = useState(1);
  const [selected, setSelected] = useState(0);
  const [requested, setRequested] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [paintingNow, setPaintingNow] = useState(false);
  const [previousImage, setPreviousImage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let current = true;
    setLoading(true); setPaintingNow(false); setError(''); onBusy(true, true);
    void turn(async () => {
      if (!current) return;
      setPaintingNow(true);
      const result = await call<{ image: string; largeImage?: string; nextTake?: number }>('idea_sketch_image', { id: sketch, kind: asset.kind, key: asset.key, take: requested, ...revision });
      if (current) {
        setPreviousImage(versions[selected] ?? ''); setVersions(v => ({ ...v, [requested]: result.image }));
        setLargeVersions(v => ({ ...v, [requested]: result.largeImage ?? result.image }));
        setDirections(v => ({ ...v, [requested]: revision.change || (revision.reference ? 'Your picture reference' : '') }));
        setNextTake(result.nextTake ?? requested + 1); setEditing(false); setSelected(requested); onSelect(requested);
      }
    }).catch(e => { if (current) setError(e.message); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [sketch, asset.kind, asset.key, requested, attempt, revision]);
  useEffect(() => { onBusy(loading || editing, loading); }, [loading, editing]);
  const regenerate = (change: ConceptChange = {}) => {
    if (disabled || loading || nextTake > 9) return;
    setLoading(true); onBusy(true, true); setError('');
    setRevision({ ...change, baseTake: selected }); setRequested(nextTake); setNextTake(nextTake + 1);
  };
  const progress = paintingNow ? 'Sketching…' : 'Waiting for a brush…';
  return <article class={`concept-card ${asset.kind}${editing ? ' is-editing' : ''}${loading ? paintingNow ? ' is-painting' : ' is-queued' : ''}`} aria-label={asset.label} aria-busy={loading}>
    <div class="concept-picture">
      {versions[selected] ? <>
        {previousImage && <img class="concept-previous" src={previousImage} alt="" aria-hidden="true" />}
        <img key={selected} class="concept-art" src={versions[selected]} alt={asset.label} />
      </> : <span class="concept-placeholder">{loading && (paintingNow ? <ReviewSketch compact /> : <span class="concept-paper-stack" aria-hidden="true"><i /><i /><i /></span>)}<span>{loading ? progress : 'Preview unavailable'}</span>{loading && <span class="concept-brush-trail" aria-hidden="true" />}</span>}
      {versions[selected] && <span class="concept-watermark">PREVIEW</span>}
      {versions[selected] && <button type="button" class="concept-zoom" data-lightbox={largeVersions[selected] ?? versions[selected]} aria-label={`Enlarge ${asset.label}`} title="See it big"><span aria-hidden="true">⤢</span></button>}
      {loading && versions[selected] && <span class="concept-loading" role="status"><span class="concept-brush-trail" aria-hidden="true" />{paintingNow ? 'Sketching another version…' : 'Waiting for a brush…'}</span>}
    </div>
    <div class="concept-caption"><strong>{asset.label}</strong><span>{asset.role === 'hero' ? 'You play' : asset.role === 'npc' ? 'Someone you meet' : 'A place to explore'}</span></div>
    {directions[selected] && <p class="concept-direction">“{directions[selected]}”</p>}
    {Object.keys(versions).length > 1 && <div class="concept-versions" aria-label={`Versions of ${asset.label}`}>{Object.entries(versions).map(([take, image]) => <button type="button" disabled={disabled || loading} aria-label={`${asset.label}, version ${Number(take) + 1}`} aria-pressed={selected === Number(take)} onClick={() => { if (selected !== Number(take)) setPreviousImage(versions[selected]); setSelected(Number(take)); onSelect(Number(take)); }}><img src={image} alt="" /></button>)}</div>}
    {error ? <div class="concept-error"><button type="button" class="ghost small" disabled={disabled || loading} onClick={() => setAttempt(n => n + 1)}>Retry preview</button><details class="detail"><summary>Details</summary>{error}</details></div>
      : <button type="button" class="ghost small" disabled={disabled || loading || nextTake > 9} onClick={() => regenerate()}>{loading ? paintingNow ? 'Sketching…' : 'Queued' : nextTake > 9 ? 'Choose a version above' : 'Another version'}</button>}
    {versions[selected] && !editing && <button type="button" class="ghost small concept-change" disabled={disabled || loading || nextTake > 9} onClick={() => setEditing(true)}>Change…</button>}
    {editing && <ConceptEdit label={asset.label} disabled={disabled || loading || nextTake > 9} onGenerate={regenerate} onClose={() => setEditing(false)} />}
  </article>;
}

export function IdeaStoryboard({ input, choices, busy, error, onBuild, onSkip }: {
  input: ReviewInput; choices?: CreativeChoices; busy: boolean; error: string;
  onBuild: (approval: SketchApproval) => void; onSkip: () => void;
}) {
  const [sketch, setSketch] = useState<Sketch | null>(null);
  const [failure, setFailure] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [selections, setSelections] = useState<Record<string, number>>({});
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [working, setWorking] = useState<Record<string, boolean>>({});
  const submitting = useRef(false);
  useEffect(() => {
    let current = true;
    setFailure('');
    void call<Sketch>('idea_sketch', { ...input, ...(choices && { choices }) }).then(s => { if (current) setSketch(s); }).catch(e => { if (current) setFailure(e.message); });
    return () => { current = false; };
  }, [input, choices, attempt]);
  useEffect(() => { if (!busy) submitting.current = false; }, [busy]);
  const ready = !!sketch && sketch.assets.every(a => Number.isInteger(selections[`${a.kind}:${a.key}`]) && !pending[`${a.kind}:${a.key}`]);
  const generating = !sketch && !failure || Object.values(working).some(Boolean);
  return <div class="idea-storyboard" data-lightbox-group>
    {!sketch && !failure ? <div class="review-thinking"><ReviewSketch /><div class="review-thinking-copy"><span class="review-kicker">The first sketches</span><p class="review-says" role="status">Finding your characters and places…</p><p class="review-aside">Your cast. Your corners of the world.</p><span class="review-ink-trail" aria-hidden="true" /></div></div> : <p class="review-says">{sketch ? <>Meet <em>your world.</em></> : 'The preview needs another try.'}</p>}
    {sketch && <>
      <p class="storyboard-pitch">{sketch.pitch}</p>
      <p class="detail">A first look. Try another version on any card. The game will use your picks as visual references.</p>
      {(['character', 'place'] as const).map(kind => <section class="concept-group" aria-label={kind === 'character' ? 'Your cast' : 'Your places'}>
        <h3>{kind === 'character' ? 'Who’s in the story' : 'Where you’ll go'}</h3>
        <div class={`concept-grid ${kind}`}>{sketch.assets.filter(a => a.kind === kind).map(asset => {
          const key = `${asset.kind}:${asset.key}`;
          return <Concept key={key} sketch={sketch.id} asset={asset} disabled={busy} onSelect={take => setSelections(s => ({ ...s, [key]: take }))} onBusy={(value, active) => { setPending(p => ({ ...p, [key]: value })); setWorking(p => ({ ...p, [key]: active })); }} />;
        })}</div>
      </section>)}
    </>}
    {failure && <div role="alert"><button type="button" class="ghost" disabled={busy} onClick={() => setAttempt(n => n + 1)}>Retry preview</button><details class="detail"><summary>Details</summary>{failure}</details></div>}
    {error && <p class="error" role="alert">{error}</p>}
    <footer><button type="button" class="ghost" disabled={busy} onClick={onSkip}>Skip & build</button><button type="button" class="primary" aria-busy={busy || generating} disabled={busy || !ready} onClick={() => { if (ready && sketch && !submitting.current) { submitting.current = true; onBuild({ id: sketch.id, selections }); } }}>{(busy || generating) && <span class="review-spinner" aria-hidden="true" />}{busy ? 'Starting the build…' : 'Build this version'}</button></footer>
  </div>;
}
