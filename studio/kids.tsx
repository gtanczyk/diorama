// A workshop with children, on the Start screen: photos of their drawings (a file, or the camera held up to
// the paper), recordings of them telling the story, and the idea Spark writes from both; then the usual build.
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import { call, fileUrl } from './api.ts';

type Drawn = { kind: string; key: string; looks: string };
type Material = {
  drawings: Array<{ file: string; v: number; drawn: Drawn | null; preview: { file: string; v: number } | null }>;
  told: Array<{ clip: string; file: string; text: string | null }>;
  idea: { language: string; title: string; idea: string } | null;
  reading: { file: string; v: number } | null;
  built: boolean;
};

/** A workshop is run in Polish (the default) or English: every word the children and the grown-up see on its screens. */
export const polish = signal(read() !== 'en');
function read() {
  try {
    return localStorage.getItem('diorama.workshop.lang');
  } catch {
    return null;
  }
}
export function setPolish(on: boolean) {
  polish.value = on;
  try {
    localStorage.setItem('diorama.workshop.lang', on ? 'pl' : 'en');
  } catch {
    // A private window keeps it for this visit only.
  }
}
/** The Polish or the English words, as the workshop is run. */
export const t = (pl: string, en: string) => (polish.value ? pl : en);

const KIND = (): Record<string, string> => polish.value
  ? { hero: 'Bohater', player: 'Drugi bohater (na drugi pad)', npc: 'Postać', item: 'Rzecz do zabrania', prop: 'Coś w miejscu', place: 'Miejsce' }
  : { hero: 'Hero', player: 'Another hero (one per gamepad)', npc: 'Character', item: 'Item to pick up', prop: 'Thing in a place', place: 'Place' };

/** A photo shrunk to 1600 px as JPEG, so a phone picture travels light; what the browser cannot read goes as it is. */
async function shrink(file: Blob): Promise<string> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.88);
  } catch {
    return base64(file);
  }
}

function base64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** The webcam held up to a drawing: a live preview and a button that keeps one frame. */
export function Camera({ onSnap, onClose, tip = 'Hold the drawing up to the camera, flat and filling the picture.', words = { snap: 'Take the photo', done: 'Done', none: 'No camera' } }: { onSnap: (jpeg: string) => void; onClose: () => void; tip?: string; words?: { snap: string; done: string; none: string } }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let stream: MediaStream | null = null;
    navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1920 }, height: { ideal: 1080 } } }).then((s) => {
      stream = s;
      if (video.current) video.current.srcObject = s;
    }).catch((e) => setError(`${words.none}: ${e.message}`));
    return () => stream?.getTracks().forEach((t) => t.stop());
  }, []);
  const snap = () => {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    canvas.getContext('2d')!.drawImage(v, 0, 0);
    onSnap(canvas.toDataURL('image/jpeg', 0.9));
  };
  return (
    <div class="camera">
      {error ? <p class="error">{error}</p> : <video ref={video} autoPlay playsInline muted />}
      <div class="row">
        <button type="button" class="primary" onClick={snap} disabled={!!error}>{words.snap}</button>
        <button type="button" class="ghost" onClick={onClose}>{words.done}</button>
        <span class="detail">{tip}</span>
      </div>
    </div>
  );
}

/** One button: press to record, press again to stop; the clip is sent and heard straight away. */
function Recorder({ onClip, big }: { onClip: (blob: Blob, ext: string) => void; big?: boolean }) {
  const [rec, setRec] = useState<MediaRecorder | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!rec) return;
    const started = Date.now();
    const timer = setInterval(() => setSeconds(Math.round((Date.now() - started) / 1000)), 250);
    return () => clearInterval(timer);
  }, [rec]);
  const start = async () => {
    setError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const type = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
      const r = new MediaRecorder(stream, type ? { mimeType: type } : {});
      const chunks: Blob[] = [];
      r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      r.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks, { type: r.mimeType });
        onClip(blob, r.mimeType.includes('mp4') ? 'm4a' : 'webm');
      };
      r.start(1000);
      setSeconds(0);
      setRec(r);
    } catch (e) {
      setError(`${t('Brak mikrofonu', 'No microphone')}: ${(e as Error).message}`);
    }
  };
  const stop = () => (rec?.stop(), setRec(null));
  return (
    <div class="row">
      <button type="button" class={`record${rec ? ' on' : big ? ' primary' : ''}`} onClick={rec ? stop : start}>{rec ? `■ ${t('Stop', 'Stop')} · ${seconds} s` : `● ${t('Nagrywaj', 'Record')}`}</button>
      <span class="detail">{rec ? t('Słucham… jedno dziecko naraz, blisko mikrofonu.', 'Listening… one child at a time, close to the microphone.') : t('Jedno dziecko naraz opowiada kawałek historii, najwyżej minutę lub dwie.', 'One child at a time tells a piece of the story, a minute or two at most.')}</span>
      {error && <span class="error">{error}</span>}
    </div>
  );
}

export function KidsStart({ slug, taken, onBuild, onError, children }: { slug: string; taken: boolean; onBuild: (idea: string) => void; onError: (m: string) => void; children?: ComponentChildren }) {
  const [m, setM] = useState<Material | null>(null);
  const [busy, setBusy] = useState<string[]>([]);
  const [camera, setCamera] = useState(false);
  const [note, setNote] = useState('');
  const [idea, setIdea] = useState('');
  /** Drawings being brought to life, and the one shown big (drawing beside what it became). */
  const [painting, setPainting] = useState<string[]>([]);
  const [shown, setShown] = useState<string | null>(null);
  const [grow, setGrow] = useState(true);
  const reader = useRef<HTMLAudioElement | null>(null);
  const load = () => call<Material>('kids_status', { slug }).then((s) => (setM(s), s.idea && setIdea((old) => old || s.idea!.idea))).catch((e) => onError(e.message));
  useEffect(() => {
    setM(null);
    setIdea('');
    void load();
  }, [slug]);
  // The reading stops when the screen goes (Build moves on to the waiting show, which reads the story itself).
  useEffect(() => () => reader.current?.pause(), []);
  /** Runs one piece of work with a line saying what is happening, then reloads what the world has. */
  const work = async (what: string, run: () => Promise<unknown>) => {
    setBusy((b) => [...b, what]);
    try {
      await run();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy((b) => b.filter((x) => x !== what));
      await load();
    }
  };
  /** A drawing comes to life right after it is kept: the children see their character while the next one is drawn. */
  const bringToLife = async (file: string) => {
    setPainting((p) => [...p, file]);
    try {
      setM(await call<Material>('kids_preview', { slug, file }));
      setShown(file);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setPainting((p) => p.filter((x) => x !== file));
    }
  };
  const keep = (name: string, data: () => Promise<string>) => void work(t('Czytam rysunek', `Reading ${name}`), async () => {
    const kept = await call<{ file: string }>('kids_add', { slug, kind: 'drawing', name, data: await data() });
    void bringToLife(kept.file);
  });
  const addPhotos = (list: FileList | null) => {
    for (const file of Array.from(list ?? [])) keep(/\.(png|jpe?g|webp)$/i.test(file.name) ? file.name.replace(/\.[^.]+$/, '.jpg') : file.name, () => shrink(file));
  };
  const snapped = (jpeg: string) => keep(`camera-${Date.now() % 100000}.jpg`, async () => jpeg);
  /** Each recording is heard, and (when the story grows) the story is written again with it and read aloud. */
  const recorded = (blob: Blob, ext: string) => void work(t('Słucham nagrania', 'Hearing the recording'), async () => {
    await call('kids_add', { slug, kind: 'told', name: `story.${ext}`, data: await base64(blob) });
    if (grow) await writeNow();
  });
  const setKind = (file: string, kind: string | null) => void work(t('Zmieniam', 'Changing what it is'), () => call('kids_kind', { slug, file, kind }));
  const remove = (file: string) => void work(t('Usuwam', 'Taking it out'), () => call('kids_remove', { slug, file }));
  const writeNow = async () => {
    const s = await call<Material>('kids_idea', { slug, note: note.trim() || undefined, ...(polish.value && { language: 'Polish' }) });
    if (s.idea) setIdea(s.idea.idea);
    setM(s);
    if (s.reading) {
      try {
        reader.current?.pause();
        reader.current = new Audio(fileUrl(slug, s.reading.file, s.reading.v));
        await reader.current.play();
      } catch {}
    }
  };
  const write = () => void work(t('Piszę historię', 'Writing the story'), writeNow);
  const big = m?.drawings.find((d) => d.file === shown && d.preview);
  const [editing, setEditing] = useState(false);
  if (taken && m && m.built) return <div class="kids"><p class="note">{t(`${slug} jest już zbudowany: wpisz inną nazwę.`, `${slug} is already built: pick another name for a new workshop world.`)}</p>{children}</div>;
  if (!m) return <p class="note">{t('Wczytuję…', 'Loading…')}</p>;
  // One step at a time: the next one lights up when the one before has something in it.
  const drew = m.drawings.length > 0;
  const told = m.told.length > 0 || !!m.idea;
  const step = !drew ? 1 : !m.idea ? 2 : 3;
  return (
    <div class="kids">
      {busy.length > 0 && <p class="busy" aria-live="polite">{busy[busy.length - 1]}…</p>}
      <section class={`card${step === 1 ? ' now' : ''}`}>
        <h2><span class="n">{drew ? '✓' : '1'}</span> {t('Rysunki', 'Their drawings')}</h2>
        <div class="row big">
          <button type="button" class={step === 1 ? 'primary' : 'ghost'} onClick={() => setCamera(!camera)}>📷 {camera ? t('Zamknij aparat', 'Close the camera') : t('Zrób zdjęcie', 'Take a photo')}</button>
          <label class="button ghost">
            <input type="file" accept="image/*" multiple onChange={(e) => (addPhotos(e.currentTarget.files), (e.currentTarget.value = ''))} />
            {t('Dodaj zdjęcia', 'Add photos')}
          </label>
        </div>
        {camera && <Camera onSnap={snapped} onClose={() => setCamera(false)} tip={t('Trzymaj rysunek przed kamerą, płasko, na cały kadr.', 'Hold the drawing up to the camera, flat and filling the picture.')} words={{ snap: t('Pstryk!', 'Take the photo'), done: t('Gotowe', 'Done'), none: t('Brak kamery', 'No camera') }} />}
        <div class="drawings"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => (e.preventDefault(), addPhotos(e.dataTransfer?.files ?? null))}>
          {m.drawings.map((d) => (
            <figure class={painting.includes(d.file) ? 'painting' : ''}>
              <button type="button" class="pic" title={d.preview ? t('Pokaż w dużym', 'Show it big') : ''} onClick={() => d.preview && setShown(d.file)}>
                <img src={fileUrl(slug, d.file, d.v)} alt="" />
                {d.preview && <img class={`alive${d.drawn?.kind === 'place' ? ' place' : ''}`} src={fileUrl(slug, d.preview.file, d.preview.v)} alt="" />}
                {painting.includes(d.file) && <span class="spark">{t('Ożywa…', 'Coming to life…')}</span>}
              </button>
              <figcaption>
                <select value={d.drawn?.kind ?? ''} title={d.drawn ? `${d.drawn.key}: ${d.drawn.looks}` : t('Czym jest w grze', 'What it is in the game')} onChange={(e) => setKind(d.file, e.currentTarget.value || null)}>
                  <option value="">{d.drawn ? `${KIND()[d.drawn.kind] ?? d.drawn.kind}?` : t('Czytam…', 'Reading…')}</option>
                  {Object.entries(KIND()).map(([k, label]) => <option value={k}>{label}</option>)}
                </select>
              </figcaption>
              <button type="button" class="ghost small" title={t('Usuń', 'Take out')} onClick={() => remove(d.file)}>×</button>
            </figure>
          ))}
          {!drew && <p class="detail empty">{t('Sfotografuj każdy rysunek, płasko, na cały kadr. Każdy ożyje po mniej więcej pół minucie. Zdjęcia można też tu upuścić.', 'Photograph each drawing, flat and filling the picture. Each one comes to life in about half a minute. You can also drop photos here.')}</p>}
        </div>
      </section>
      <section class={`card${step === 2 ? ' now' : ''}`}>
        <h2><span class="n">{m.idea ? '✓' : '2'}</span> {t('Opowiadanie', 'The story, told')}</h2>
        <Recorder onClip={recorded} big={step === 2} />
        {m.told.length > 0 && (
          <details class="told">
            <summary class="detail">{t(`Nagrania: ${m.told.length}, co usłyszałem`, `${m.told.length} recording${m.told.length === 1 ? '' : 's'}: what was heard`)}</summary>
            <ul>
              {m.told.map((clip) => (
                <li>
                  <audio controls preload="none" src={fileUrl(slug, clip.file)} />
                  <span class="grow">{clip.text ?? <span class="detail">{t('jeszcze nie usłyszane', 'not heard yet')}</span>}</span>
                  <button type="button" class="ghost small" title={t('Usuń', 'Take out')} onClick={() => remove(clip.file)}>×</button>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>
      <section class={`card${step === 3 ? ' now' : ''}`}>
        <h2><span class="n">3</span> {m.idea ? m.idea.title : t('Ich gra', 'Their game')}</h2>
        {m.idea ? (
          <>
            {m.reading && <audio controls preload="none" src={fileUrl(slug, m.reading.file, m.reading.v)} />}
            {editing
              ? <textarea rows={5} value={idea} onInput={(e) => setIdea(e.currentTarget.value)} />
              : <p class="story" onClick={() => setEditing(true)} title={t('Kliknij, żeby zmienić', 'Click to change')}>{idea}</p>}
          </>
        ) : <p class="detail">{drew || told ? t('Historia powstanie z nagrań i rysunków i zostanie przeczytana na głos.', 'The story is written from the recordings and drawings, and read aloud.') : t('Historia pojawi się tu, gdy dzieci narysują i opowiedzą.', 'The story appears here once they have drawn and told it.')}</p>}
        <div class="row big">
          {!m.idea && <button type="button" class="ghost" onClick={write} disabled={busy.length > 0 || (!drew && !told)}>{t('Napisz historię', 'Write the story')}</button>}
          <span class="grow" />
          <button type="button" class="primary" disabled={idea.trim().length < 10 || busy.length > 0 || m.built} onClick={() => onBuild(idea.trim())}>{t('Budujemy grę!', 'Build their game')}</button>
        </div>
      </section>
      <details class="more">
        <summary>{t('Więcej', 'More')}</summary>
        {children}
        <div class="row">
          <input class="grow" placeholder={t('Coś do dodania (nieobowiązkowe): „kotek znajduje czapkę”, „niech będzie śmiesznie”', "Anything to add (optional): 'the cat finds the hat', 'make it funny'")} value={note} onInput={(e) => setNote(e.currentTarget.value)} />
          <button type="button" class="ghost" onClick={write} disabled={busy.length > 0 || (!drew && !told)}>{m.idea ? t('Napisz od nowa', 'Write it again') : t('Napisz historię', 'Write the story')}</button>
        </div>
        <label class="detail"><input type="checkbox" checked={grow} onChange={(e) => setGrow(e.currentTarget.checked)} /> {t('Po każdym nagraniu historia pisze się od nowa i jest czytana na głos', 'The story is written again after every recording and read aloud')}</label>
        {m.idea && !editing && <button type="button" class="ghost small" onClick={() => setEditing(true)}>{t('Zmień tekst historii', 'Change the story text')}</button>}
      </details>
      {big && (
        <div class="show" onClick={() => setShown(null)}>
          <img src={fileUrl(slug, big.file, big.v)} alt="" />
          <span class="arrow">→</span>
          <img class={`alive${big.drawn?.kind === 'place' ? ' place' : ''}`} src={fileUrl(slug, big.preview!.file, big.preview!.v)} alt="" />
          <p>{big.drawn?.kind === 'hero' ? t('Nasz bohater', 'Our hero') : big.drawn?.kind === 'player' ? t('Bohater na drugi pad', `A hero for a gamepad: ${big.drawn.key.replace(/-/g, ' ')}`) : polish.value ? '' : big.drawn?.key.replace(/-/g, ' ')}</p>
        </div>
      )}
    </div>
  );
}

const WAIT_WORDS = {
  English: { title: 'Your game is being made', left: (n: number) => `about ${n} min to go`, soon: 'almost there', listen: 'Listen to the story', place: 'A new place!', play: "Let's play!", oops: 'Something went wrong: the grown-up will have a look.', hide: 'Hide' },
  Polish: { title: 'Wasza gra powstaje', left: (n: number) => `jeszcze około ${n} min`, soon: 'już prawie', listen: 'Posłuchaj historii', place: 'Nowe miejsce!', play: 'Zagrajmy!', oops: 'Coś poszło nie tak: dorosły zaraz zerknie.', hide: 'Ukryj' },
};

type Slide = { id: string; from?: string; to: string; label: string; place?: boolean };

/**
 * While a workshop world builds (a quarter of an hour), the children watch it come together: their drawings beside
 * what they became, every place as soon as it is painted, the story read aloud, and their hero walking along the
 * road to the end of the build. When the game is ready one big button starts it.
 */
export function KidsWait({ slug, places, progress, left, ready, failed, onPlay, onHide }: {
  slug: string;
  places: Array<{ key: string; image: { file: string; v: number | null } | null }>;
  progress: number;
  left: number | null;
  ready: boolean;
  failed: boolean;
  onPlay: () => void;
  onHide: () => void;
}) {
  const [m, setM] = useState<Material | null>(null);
  const [world, setWorld] = useState<{ title?: string; names?: Record<string, string>; hero?: { key: string } } | null>(null);
  const [at, setAt] = useState(0);
  const reader = useRef<HTMLAudioElement | null>(null);
  const painted = places.filter((p) => p.image?.file.endsWith('painting.png')).map((p) => p.key).join(' ');
  useEffect(() => void call<Material>('kids_status', { slug }).then(setM).catch(() => {}), [slug]);
  // The world step names the characters in the children's language; read it again as places arrive.
  useEffect(() => void fetch(fileUrl(slug, 'world.json', Date.now())).then((r) => (r.ok ? r.json() : null)).then(setWorld).catch(() => {}), [slug, painted]);
  const words = WAIT_WORDS[polish.value || m?.idea?.language === 'Polish' ? 'Polish' : 'English'];
  // English keys are for the painters; in another language a thing goes unnamed until the world step names it.
  const name = (key: string) => world?.names?.[key] ?? (words === WAIT_WORDS.English ? key.replace(/-/g, ' ') : '');
  const slides: Slide[] = [
    ...(m?.drawings ?? []).filter((d) => d.preview && d.drawn?.kind !== 'place').map((d) => ({ id: d.file, from: fileUrl(slug, d.file, d.v), to: fileUrl(slug, d.preview!.file, d.preview!.v), label: name(d.drawn!.key) })),
    ...places.filter((p) => p.image?.file.endsWith('painting.png')).map((p) => ({ id: p.key, to: fileUrl(slug, p.image!.file, p.image!.v), label: name(p.key), place: true })),
  ];
  // A place just painted is shown at once; otherwise the show moves on every few seconds.
  const seen = useRef(new Set<string>());
  const primed = useRef(false);
  const [fresh, setFresh] = useState<string | null>(null);
  useEffect(() => {
    const at = slides.findIndex((s) => s.place && !seen.current.has(s.id));
    slides.forEach((s) => s.place && seen.current.add(s.id));
    // Places painted before the show opened are not news.
    if (at >= 0 && primed.current) (setAt(at), setFresh(slides[at].id));
    primed.current = true;
  }, [painted]);
  useEffect(() => {
    const timer = setInterval(() => setAt((i) => i + 1), 7000);
    return () => clearInterval(timer);
  }, []);
  const read = () => {
    if (!m?.reading) return;
    reader.current?.pause();
    reader.current = new Audio(fileUrl(slug, m.reading.file, m.reading.v));
    reader.current.play().catch(() => {});
  };
  // The story is read once as the wait begins (the click on Build lets the page play sound).
  useEffect(() => (m?.reading && !reader.current && read(), undefined), [m]);
  useEffect(() => () => reader.current?.pause(), []);
  const slide = slides.length ? slides[at % slides.length] : null;
  const hero = m?.drawings.find((d) => d.drawn?.kind === 'hero' && d.preview);
  const done = Math.max(0, Math.min(1, ready ? 1 : progress));
  // Only a world made from drawings or recordings waits like this.
  if (!m || (!m.drawings.length && !m.told.length)) return null;
  return (
    <div class="wait" role="dialog" aria-label={words.title}>
      <div class="row">
        <h1 class="grow">{world?.title ?? m?.idea?.title ?? words.title}</h1>
        {m?.reading && <button type="button" class="ghost" onClick={read}>🔊 {words.listen}</button>}
        <button type="button" class="ghost small" title={words.hide} onClick={onHide}>×</button>
      </div>
      <div class="screen">
        {slide && (
          <figure key={slide.id} class={slide.place ? 'place' : ''}>
            {slide.from && <img class="from" src={slide.from} alt="" />}
            {slide.from && <span class="arrow">→</span>}
            <img class="to" src={slide.to} alt="" />
            <figcaption>{slide.id === fresh && !ready ? `${words.place} ` : ''}{slide.label}</figcaption>
          </figure>
        )}
      </div>
      {ready ? (
        <button type="button" class="primary go" onClick={onPlay}>▶ {words.play}</button>
      ) : failed ? (
        <p class="oops">{words.oops}</p>
      ) : (
        <div class="road" aria-label={`${Math.round(done * 100)}%`}>
          <div class="done" style={{ width: `${done * 100}%` }} />
          {hero && <img class="walker" style={{ left: `${done * 100}%` }} src={fileUrl(slug, hero.preview!.file, hero.preview!.v)} alt="" />}
          <span class="flag">🏁</span>
          <span class="detail">{left === null ? '' : left > 60 ? words.left(Math.round(left / 60)) : words.soon}</span>
        </div>
      )}
    </div>
  );
}
