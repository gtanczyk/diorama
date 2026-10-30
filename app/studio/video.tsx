import { useEffect, useRef, useState } from 'preact/hooks';
import { call } from './api.ts';
import { base64 } from './camera.tsx';
import { Icon } from './icons.tsx';
import { VIDEO_CHUNK, VIDEO_MAX } from '../src/world/video-limits.ts';
export type VideoResult = { speech?: Array<{ at: number; text: string; provider: string; model: string; timing: string; speakerScope?: string; segments: Array<{ start: number; end: number; text: string; speaker?: string }> }>;  idea: string; photos: Array<{ name: string; data: string }>; totalFrames: number; observations: Array<{ at: number; text: string }> };
/** Upload and interpretation are resumable independently; no world is built until the person reviews it. */
export function VideoInput({ note, disabled, onResult, onBusy }: { note: string; disabled: boolean; onResult: (id: string, result: VideoResult) => void; onBusy: (busy: boolean) => void }) {
  const [preview, setPreview] = useState('');
  const picker = useRef<HTMLInputElement>(null);
  const [filename, setFilename] = useState('');
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(false);
  const work = useRef<{ id?: string; file: File; note: string }>();
  const stop = useRef(false);
  useEffect(() => () => { stop.current = true; }, []);
  const run = async () => {
    if (!work.current || busy) return;
    stop.current = false; setBusy(true); onBusy(true); setError(''); setPending(true);
    const task = work.current;
    try {
      if (!task.id) task.id = (await call<{ id: string }>('video_upload', { name: task.file.name, size: task.file.size })).id;
      // Store the token so a refresh can resume: select the same source file again to continue.
      try { localStorage.setItem('diorama-video-upload', JSON.stringify({ id: task.id, name: task.file.name, size: task.file.size, modified: task.file.lastModified, note: task.note })); } catch {}
      let { received } = await call<{ received: number }>('video_upload', { id: task.id });
      while (received < task.file.size) {
        if (stop.current) return;
        setStatus(`Uploading video · ${Math.floor(received / task.file.size * 100)}%`);
        const data = (await base64(task.file.slice(received, received + VIDEO_CHUNK))).split(',')[1];
        ({ received } = await call<{ received: number }>('video_upload', { id: task.id, offset: received, data }));
      }
      setStatus('Reading video duration and audio…');
      const info = await call<{ duration: number; audio: boolean; parts: number }>('video_inspect', { id: task.id });
      for (let index = 0; index < info.parts; index++) {
        if (stop.current) return;
        setStatus(`Understanding video · ${index + 1}/${info.parts} · ${info.audio ? 'pictures and speech' : 'pictures, no audio track'}. You can pause and resume.`);
        await call('video_read', { id: task.id, index, note: task.note });
      }
      if (stop.current) return;
      const result = await call<VideoResult>('video_result', { id: task.id });
      if (stop.current) return;
      onResult(task.id, result); setStatus('Video understood. Review the idea and selected pictures before building.');
      setPending(false); try { localStorage.removeItem('diorama-video-upload'); } catch {} work.current = undefined;
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); onBusy(false); }
  };
  const choose = (file?: File) => {
    if (!file) return;
    if (file.size > VIDEO_MAX) { setError('Choose a video up to 2 GB.'); return; }
    let saved;
    try { saved = JSON.parse(localStorage.getItem('diorama-video-upload') ?? 'null'); } catch {}
    setPreview(URL.createObjectURL(file));
    setFilename(file.name);
    work.current = { file, note, ...(saved?.name === file.name && saved?.size === file.size && saved?.modified === file.lastModified ? { id: saved.id, note: saved.note } : {}) };
    void run();
  };
  return <>
    <button type="button" class="ghost bare" disabled={disabled || busy} title="Show your drawings and tell their story in a video. With or without sound, up to 2 GB / 4 hours." onClick={() => picker.current?.click()}><Icon name="film" /> Video</button>
    <input ref={picker} class="video-picker" hidden type="file" aria-label="Choose a video" accept="video/*,.mkv,.m4v,.avi" disabled={disabled || busy} onChange={e => { choose(e.currentTarget.files?.[0]); e.currentTarget.value = ''; }} />
    {(preview || error || status) && <div class="video-status">
    {filename && <p class="video-filename"><Icon name="film" /> {filename}</p>}
    {preview && <video src={preview} controls preload="metadata" style={{ maxWidth: '100%', maxHeight: '300px' }} />}
    {status && <p role="status">{status}</p>}
    {error && <p class="error" role="alert">{error}</p>}
    {busy && <button type="button" class="ghost small" onClick={() => { stop.current = true; setStatus('Pausing after the current interval…'); }}>Pause</button>}
    {!busy && pending && <button type="button" class="ghost small" onClick={() => void run()}>Resume video</button>}
    <details class="detail"><summary>Video tips</summary>Hold each drawing still for at least ten seconds. You can pause and resume processing. Interpreting the video uses model calls.</details>
    </div>}
  </>;
}
