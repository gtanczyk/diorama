import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { CreativeChoices, IdeaReview as Review } from '../src/world/idea-review.ts';
import { call } from './api.ts';
import { IdeaCard } from './idea-card.tsx';
import { Logo } from './atelier.tsx';
import { IdeaStoryboard } from './idea-storyboard.tsx';
import type { SketchApproval } from '../src/world/sketch.ts';
import { ReviewSketch } from './review-sketch.tsx';
import { CustomLook, type Look } from './custom-look.tsx';
import { Icon } from './icons.tsx';

export type ReviewInput = { idea: string; photos: Array<{ name: string; data: string }>; videos: string[]; places?: number; language?: string };
type Decision = { review: Review; answer: string; style: string; styleReference?: string };

function ReviewOption({ textOnly, ...props }: Parameters<typeof IdeaCard>[0] & { textOnly: boolean }) {
  if (!textOnly) return <IdeaCard {...props} />;
  return <button type="button" class={`review-text-option${props.selected ? ' selected' : ''}`} aria-label={props.label} aria-pressed={props.selected} hidden={props.hidden} disabled={props.disabled} onClick={props.onPick}>
    {props.selected && <span aria-hidden="true">✓</span>}<span>{props.label}</span>
  </button>;
}

function AnsweredChoice({ decision, input, editing, busy, onEdit, onCancel, onChoose }: {
  decision: Decision; input: ReviewInput; editing: boolean; busy: boolean;
  onEdit: () => void; onCancel: () => void; onChoose: (answer: string) => void;
}) {
  const q = decision.review.questions[0];
  const [draft, setDraft] = useState(decision.answer);
  const [writing, setWriting] = useState(false);
  useLayoutEffect(() => { setDraft(decision.answer); setWriting(!q.options.includes(decision.answer)); }, [editing, decision.answer]);
  return <section class={`review-exchange${editing ? ' is-editing' : ' is-collapsed'}`} aria-label={`Decision: ${q.question}`}>
    <div class="review-decision-heading"><p class="review-says">{q.question}</p><button type="button" class="ghost small" disabled={busy} aria-label={`${editing ? 'Cancel change' : 'Change answer'}: ${q.question}`} onClick={editing ? onCancel : onEdit}>{editing ? 'Cancel' : 'Change'}</button></div>
    <div class={q.presentation === 'text' ? 'review-text-options' : 'review-cards'} data-lightbox-group>{q.options.map((option, i) => {
      const visual = q.visuals?.[i];
      return <ReviewOption key={i} textOnly={q.presentation === 'text'} label={option} image={visual?.photo !== undefined ? input.photos[visual.photo]?.data : undefined} idea={input.idea} scene={visual?.scene ?? `${q.question} — ${option}`} style={decision.style || undefined} styleReference={decision.styleReference} references={input.photos.slice(0, 4).map(p => p.data)} selected={option === decision.answer} hidden={!editing && option !== decision.answer} disabled={busy} onPick={() => editing ? onChoose(option) : onEdit()} />;
    })}</div>
    {!q.options.includes(decision.answer) && !editing && <button type="button" class="review-written-choice" disabled={busy} onClick={onEdit}>{decision.answer}</button>}
    {editing && <>
      {!writing && <button type="button" class="ghost small" disabled={busy} onClick={() => setWriting(true)}>Something else…</button>}
      {writing && <form class="review-compose" onSubmit={e => { e.preventDefault(); if (draft.trim()) onChoose(draft.trim()); }}>
        <input aria-label="Change your reply" maxLength={600} disabled={busy} value={draft} onInput={e => setDraft(e.currentTarget.value)} />
        <button type="submit" class="ghost" disabled={busy || !draft.trim()}>Save change</button>
      </form>}
      <p class="detail">Changing this choice updates what comes after it.</p>
    </>}
  </section>;
}

export function IdeaReview({ input, busy, error, onBuild, onBack }: {
  input: ReviewInput; busy: boolean; error: string;
  onBuild: (choices?: CreativeChoices, sketch?: SketchApproval) => void; onBack: () => void;
}) {
  const section = useRef<HTMLElement>(null);
  const latest = useRef<HTMLDivElement>(null);
  const looks = useRef<HTMLElement>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [failure, setFailure] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const answers = useMemo(() => decisions.map(d => ({ question: d.review.questions[0].question, answer: d.answer })), [decisions]);
  const [editing, setEditing] = useState<number | null>(null);
  const [style, setStyle] = useState('');
  const [styleChoice, setStyleChoice] = useState<{ title: string; scene: string; options: Look[]; reference?: string } | null>(null);
  const [showStyles, setShowStyles] = useState(false);
  const [looksSeen, setLooksSeen] = useState(false);
  const [customLook, setCustomLook] = useState(false);
  const [draft, setDraft] = useState('');
  const [writing, setWriting] = useState(false);
  const [fullIdea, setFullIdea] = useState(false);
  const [preview, setPreview] = useState<{ choices?: CreativeChoices } | null>(null);
  const submitting = useRef(false);
  const replying = useRef(false);
  const generation = useRef(0);
  useEffect(() => { section.current?.focus({ preventScroll: true }); section.current?.scrollIntoView({ block: 'start' }); }, []);
  useEffect(() => { if (answers.length) latest.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [review, answers.length]);
  useEffect(() => {
    // One useful follow-up is enough. No endlessly expanding interview.
    if (answers.length >= 2 || preview) return;
    let current = true;
    const request = ++generation.current;
    setFailure(''); setReview(null);
    void call<Review>('idea_review', { ...input, ...(answers.length && { choices: { answers, ...(style && { style }) } }) })
      .then(r => { if (current && generation.current === request) { setReview(r); replying.current = false; } })
      .catch(e => { if (current && generation.current === request) { setFailure(e.message); replying.current = false; } });
    return () => { current = false; };
  }, [input, attempt, answers, preview]);
  useEffect(() => { if (!busy) submitting.current = false; }, [busy]);
  const question = answers.length < 2 ? review?.questions[0] : undefined;
  const reply = (text: string, index?: number) => {
    const source = index === undefined ? review : decisions[index]?.review;
    if (!source?.questions[0] || !text.trim() || busy || replying.current) return;
    if (index !== undefined && text.trim() === decisions[index].answer) { setEditing(null); return; }
    generation.current++;
    replying.current = true;
    const at = index ?? decisions.length;
    setDecisions(d => [...d.slice(0, at), { review: source, answer: text.trim(), style: index === undefined ? style : d[index].style, styleReference: index === undefined ? styleChoice?.reference : d[index].styleReference }]);
    setEditing(null);
    setPreview(null);
    setFailure('');
    if (at < 1) setReview(null);
    setDraft('');
    setWriting(false);
    setShowStyles(false);
  };
  const chosen = () => answers.length || style ? { answers, ...(style && { style, ...(styleChoice?.reference && { styleReference: styleChoice.reference }) }) } : undefined;
  const build = (sketch?: SketchApproval) => {
    if (busy || submitting.current) return;
    submitting.current = true;
    // Skip the remaining conversation, not what the creator already told us.
    onBuild(preview?.choices ?? chosen(), sketch);
  };
  const waiting = !review && !failure && answers.length < 2;
  const readyToBuild = answers.length >= 2 || !!review && !review.questions.length;
  const canPreview = readyToBuild && !busy && editing === null && !showStyles;
  const references = input.photos.slice(0, 4).map(p => p.data);
  const styleOptions: Look[] = styleChoice?.options ?? review?.styles ?? [];
  const styleScene = styleChoice?.scene ?? review?.understanding ?? input.idea;
  const offerLooks = readyToBuild && decisions.length > 0 && decisions.every(d => d.review.questions[0].presentation === 'text') && !looksSeen && !style && styleOptions.length > 0 && !preview && editing === null;
  useEffect(() => { if (offerLooks) looks.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [offerLooks]);
  const chooseLook = (look: Look) => {
    if (look.description !== style || look.reference !== styleChoice?.reference) setPreview(null);
    setLooksSeen(true); setStyle(look.description);
    setStyleChoice({ title: look.title, scene: styleScene, options: [...styleOptions.filter(s => s.description !== look.description), look], reference: look.reference });
    setCustomLook(false); setShowStyles(false);
  };
  const openCustomLook = () => { setLooksSeen(true); setEditing(null); setShowStyles(true); setCustomLook(true); };
  const edit = (index: number) => { if (!busy) { replying.current = false; setEditing(index); setShowStyles(false); } };
  return <section ref={section} tabIndex={-1} class={`idea-review${waiting && !preview ? ' is-thinking' : ''}`} aria-label="Shape your world">
    <header class="review-header"><button type="button" class="ghost small" disabled={busy} aria-label="Back to idea" onClick={onBack}>← Edit idea</button><Logo size={30} /><span>Let’s shape your world</span></header>
    <div class="idea-review-body">
      <div class="review-origin"><span class="review-kicker">Your idea</span><p class="review-reply">{!fullIdea && input.idea.length > 240 ? `${input.idea.slice(0, 240)}…` : input.idea}{input.idea.length > 240 && <button type="button" class="ghost small review-expand" aria-expanded={fullIdea} onClick={() => setFullIdea(v => !v)}>{fullIdea ? 'Show less' : 'Read full idea'}</button>}</p>{input.photos.length > 0 && <div class="review-attachments">{input.photos.map(p => <img src={p.data} alt={p.name} title={p.name} />)}</div>}</div>
      {decisions.map((decision, i) => <AnsweredChoice key={i} decision={decision} input={input} editing={editing === i} busy={busy} onEdit={() => edit(i)} onCancel={() => setEditing(null)} onChoose={answer => reply(answer, i)} />)}
      {style && styleChoice && <section class="review-exchange is-collapsed" aria-label="Chosen look">
        <div class="review-decision-heading"><p class="review-says">The look of your world</p><button type="button" class="ghost small" disabled={busy} onClick={() => { setEditing(null); setShowStyles(true); }}>Change look</button></div>
        <div class="review-cards" data-lightbox-group><IdeaCard label={styleChoice.title} idea={input.idea} scene={styleChoice.scene} style={style} styleReference={styleChoice.reference} references={references} selected disabled={busy} onPick={() => { setEditing(null); setShowStyles(true); }} /></div>
      </section>}
      {(showStyles || offerLooks) && <section ref={looks} class="review-current" aria-label="Looks for your world">
        <p class="review-says">{offerLooks ? 'Let’s picture your world.' : 'Which look?'}</p>
        {customLook ? <CustomLook input={input} scene={styleScene} busy={busy} onChoose={chooseLook} onClose={() => setCustomLook(false)} /> : <>
        <div class="review-cards" data-lightbox-group>{styleOptions.map(s => <IdeaCard key={s.description} label={s.title} idea={input.idea} scene={styleScene} style={s.description} styleReference={s.reference} references={references} selected={s.description === style} disabled={busy} onPick={() => chooseLook(s)} />)}</div>
        <button type="button" class="ghost small" disabled={busy} onClick={openCustomLook}><Icon name="pencil" /> My own style…</button>
        </>}
        {!customLook && <><p class="detail">Or let Diorama choose a style from your idea and pictures.</p>
        <div class="review-style-actions">
          <button type="button" class="amber small" disabled={busy} onClick={() => { if (style) setPreview(null); setLooksSeen(true); setStyle(''); setStyleChoice(null); setShowStyles(false); }}>Let Diorama choose</button>
          <button type="button" class="ghost small review-style-cancel" disabled={busy} onClick={() => { setLooksSeen(true); setShowStyles(false); }}>{offerLooks ? 'Not now' : 'Cancel'}</button>
        </div></>}
      </section>}
      {preview && <div hidden={editing !== null || showStyles}><IdeaStoryboard input={input} choices={preview.choices} busy={busy} error={error} onBuild={build} onSkip={() => build()} /></div>}
      {!preview && <div hidden={editing !== null || showStyles || offerLooks}><div ref={latest} class="review-current" aria-live="polite">
      {waiting && <div class="review-thinking"><ReviewSketch /><div class="review-thinking-copy"><span class="review-kicker">At the drawing table</span><p class="review-says" role="status">{answers.length ? 'Got it. One moment…' : 'Let me look at your idea…'}</p><p class="review-aside">A few sketches before the adventure.</p><span class="review-ink-trail" aria-hidden="true" /></div></div>}
      {failure && <div role="alert"><p class="review-says">Let’s go with your idea. We can work out the details along the way.</p><button type="button" class="ghost small" disabled={busy} onClick={() => setAttempt(a => a + 1)}>Try asking again</button><details class="detail"><summary>Details</summary>{failure}</details></div>}
      {!waiting && !failure && <>
        <p class="review-says">{question?.question ?? 'Your story is ready for its first sketches.'}</p>
        {!question && <p class="review-aside">Select <strong>Choose cast &amp; places</strong> below to see your characters and locations.</p>}
        {question?.photo !== undefined && input.photos[question.photo] && <img class="review-reference" src={input.photos[question.photo].data} alt={input.photos[question.photo].name} />}
        {question?.video && <p class="detail">Video {input.videos.indexOf(question.video.id) + 1} · {Math.floor(question.video.seconds / 60)}:{String(Math.floor(question.video.seconds % 60)).padStart(2, '0')}</p>}
        {question && <>
          <div class={question.presentation === 'text' ? 'review-text-options' : 'review-cards'} data-lightbox-group>{question.options.map((option, i) => {
            const visual = question.visuals?.[i];
            return <ReviewOption key={`${question.question}:${i}`} textOnly={question.presentation === 'text'} label={option} image={visual?.photo !== undefined ? input.photos[visual.photo]?.data : undefined} idea={input.idea} scene={visual?.scene ?? `${question.question} — ${option}`} style={style || undefined} styleReference={styleChoice?.reference} references={references} disabled={busy} onPick={() => reply(option)} />;
          })}</div>
          {(writing || !question.options.length) && <form class="review-compose" onSubmit={e => { e.preventDefault(); reply(draft); }}>
            <input aria-label="Your reply" maxLength={600} disabled={busy} placeholder="Or tell me in your own words…" value={draft} onInput={e => setDraft(e.currentTarget.value)} />
            <button type="submit" class="ghost" aria-label="Send reply" disabled={busy || !draft.trim()}>↑</button>
          </form>}
        </>}
        <div class="review-question-actions">
          {question && !writing && question.options.length > 0 && <button type="button" class="ghost small" disabled={busy} onClick={() => setWriting(true)}>Something else…</button>}
          {!style && !!styleOptions.length && <button type="button" class="ghost small review-explore-looks" disabled={busy} onClick={() => { setLooksSeen(true); setShowStyles(true); }}><Icon name="brush" />Show me some looks</button>}
          <button type="button" class="ghost small review-explore-looks" disabled={busy} onClick={openCustomLook}><Icon name="pencil" />My own style…</button>
        </div>
      </>}
      {error && <p role="alert" class="error">{error}</p>}
      </div></div>}
    </div>
    {(!preview || editing !== null || showStyles) && <footer>
      <button type="button" class="ghost" aria-busy={busy} disabled={busy} onClick={() => build()}>{busy && <span class="review-spinner" aria-hidden="true" />}{busy ? 'Starting the build…' : readyToBuild ? 'Skip & build now' : 'Skip & build'}</button>
      <button type="button" class="primary" disabled={!canPreview} aria-busy={waiting && !busy} title={!readyToBuild ? 'Finish the questions before choosing your cast and places.' : undefined} onClick={() => { if (canPreview) setPreview({ choices: chosen() }); }}>{waiting && !busy ? <><span class="review-spinner" aria-hidden="true" />Thinking…</> : 'Choose cast & places'}</button>
    </footer>}
  </section>;
}
