// A workshop with children, on the Start screen: photos of their drawings (a file, or the camera held up to
// the paper), recordings of them telling the story, and the idea Spark writes from both; then the usual build.
import { useEffect, useRef, useState } from 'preact/hooks';
import { call, fileUrl } from './api.ts';

type Drawn = { kind: string; key: string; looks: string };
type Material = {
  drawings: Array<{ file: string; v: number; drawn: Drawn | null }>;
  told: Array<{ clip: string; file: string; text: string | null }>;
  idea: { language: string; title: string; idea: string } | null;
  built: boolean;
};

const KIND: Record<string, string> = { hero: 'Hero', npc: 'Character', item: 'Item to pick up', prop: 'Thing in a place', place: 'Place' };

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
function Camera({ onSnap, onClose }: { onSnap: (jpeg: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let stream: MediaStream | null = null;
    navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1920 }, height: { ideal: 1080 } } }).then((s) => {
      stream = s;
      if (video.current) video.current.srcObject = s;
    }).catch((e) => setError(`No camera: ${e.message}`));
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
        <button type="button" class="primary" onClick={snap} disabled={!!error}>Take the photo</button>
        <button type="button" class="ghost" onClick={onClose}>Done</button>
        <span class="detail">Hold the drawing up to the camera, flat and filling the picture.</span>
      </div>
    </div>
  );
}

/** One button: press to record, press again to stop; the clip is sent and heard straight away. */
function Recorder({ onClip }: { onClip: (blob: Blob, ext: string) => void }) {
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
      setError(`No microphone: ${(e as Error).message}`);
    }
  };
  const stop = () => (rec?.stop(), setRec(null));
  return (
    <div class="row">
      <button type="button" class={`record${rec ? ' on' : ''}`} onClick={rec ? stop : start}>{rec ? `■ Stop · ${seconds} s` : '● Record'}</button>
      <span class="detail">{rec ? 'Listening… one child at a time, close to the microphone.' : 'Each child tells a piece of the story; a clip of up to a minute or two is best.'}</span>
      {error && <span class="error">{error}</span>}
    </div>
  );
}

export function KidsStart({ slug, taken, places, onBuild, onError }: { slug: string; taken: boolean; places: number; onBuild: (idea: string) => void; onError: (m: string) => void }) {
  const [m, setM] = useState<Material | null>(null);
  const [busy, setBusy] = useState<string[]>([]);
  const [camera, setCamera] = useState(false);
  const [note, setNote] = useState('');
  const [idea, setIdea] = useState('');
  const load = () => call<Material>('kids_status', { slug }).then((s) => (setM(s), s.idea && setIdea((old) => old || s.idea!.idea))).catch((e) => onError(e.message));
  useEffect(() => {
    setM(null);
    setIdea('');
    void load();
  }, [slug]);
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
  const addPhotos = (list: FileList | null) => {
    for (const file of Array.from(list ?? [])) void work(`Keeping ${file.name}`, async () => call('kids_add', { slug, kind: 'drawing', name: /\.(png|jpe?g|webp)$/i.test(file.name) ? file.name.replace(/\.[^.]+$/, '.jpg') : file.name, data: await shrink(file) }));
  };
  const snapped = (jpeg: string) => void work('Keeping the photo', () => call('kids_add', { slug, kind: 'drawing', name: `camera-${Date.now() % 100000}.jpg`, data: jpeg }));
  const recorded = (blob: Blob, ext: string) => void work('Hearing the recording', async () => call('kids_add', { slug, kind: 'told', name: `story.${ext}`, data: await base64(blob) }));
  const setKind = (file: string, kind: string | null) => void work('Changing what it is', () => call('kids_kind', { slug, file, kind }));
  const remove = (file: string) => void work('Taking it out', () => call('kids_remove', { slug, file }));
  const write = () => void work('Spark reads the drawings and writes the story', async () => {
    const s = await call<Material>('kids_idea', { slug, note: note.trim() || undefined });
    if (s.idea) setIdea(s.idea.idea);
  });
  if (taken && m && m.built) return <p class="note">{slug} is already built: pick another name for a new workshop world.</p>;
  if (!m) return <p class="note">Loading…</p>;
  return (
    <div class="kids">
      <section>
        <h2>1 · Drawings</h2>
        <div class="drawings"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => (e.preventDefault(), addPhotos(e.dataTransfer?.files ?? null))}>
          {m.drawings.map((d) => (
            <figure>
              <img src={fileUrl(slug, d.file, d.v)} alt="" />
              <figcaption>
                <select value={d.drawn?.kind ?? ''} title="What it is in the game" onChange={(e) => setKind(d.file, e.currentTarget.value || null)}>
                  <option value="">{d.drawn ? 'Spark decides' : 'Spark decides…'}</option>
                  {Object.entries(KIND).map(([k, label]) => <option value={k}>{label}</option>)}
                </select>
                {d.drawn && <span title={d.drawn.looks}> {d.drawn.key}</span>}
              </figcaption>
              <button type="button" class="ghost small" title="Take out" onClick={() => remove(d.file)}>×</button>
            </figure>
          ))}
          <label class="add">
            <input type="file" accept="image/*" multiple onChange={(e) => (addPhotos(e.currentTarget.files), (e.currentTarget.value = ''))} />
            + Photos of drawings<span class="detail">or drop them here</span>
          </label>
        </div>
        {camera ? <Camera onSnap={snapped} onClose={() => setCamera(false)} /> : <button type="button" class="ghost small" onClick={() => setCamera(true)}>Use the camera</button>}
      </section>
      <section>
        <h2>2 · The story, told</h2>
        <Recorder onClip={recorded} />
        <ul class="told">
          {m.told.map((t) => (
            <li>
              <audio controls preload="none" src={fileUrl(slug, t.file)} />
              <span class="grow">{t.text ?? <span class="detail">not heard yet</span>}</span>
              <button type="button" class="ghost small" title="Take out" onClick={() => remove(t.file)}>×</button>
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h2>3 · Their game</h2>
        <div class="row">
          <input class="grow" placeholder="Anything to add (optional): 'the cat finds the hat', 'make it funny'" value={note} onInput={(e) => setNote(e.currentTarget.value)} />
          <button type="button" class="ghost" onClick={write} disabled={busy.length > 0 || (m.drawings.length === 0 && m.told.length === 0)}>{m.idea ? 'Write it again' : 'Write the story'}</button>
        </div>
        {m.idea && <p><strong>{m.idea.title}</strong> <span class="detail">· {m.idea.language}</span></p>}
        <textarea rows={5} placeholder="The story Spark writes from what they said and drew appears here; change anything before building." value={idea} onInput={(e) => setIdea(e.currentTarget.value)} />
        <div class="row">
          <span class="detail">{busy.length ? `${busy[busy.length - 1]}…` : `${m.drawings.length} drawing(s), ${m.told.length} recording(s), ${places} places`}</span>
          <span class="grow" />
          <button type="button" class="primary" disabled={idea.trim().length < 10 || busy.length > 0 || m.built} onClick={() => onBuild(idea.trim())}>Build their game</button>
        </div>
      </section>
    </div>
  );
}
