// Speaking instead of typing: the browser records, Muse Voice Transcribe (idea_hear) writes it down.
import { useEffect, useState } from 'preact/hooks';
import { call } from './api.ts';
import { base64 } from './camera.tsx';

/** The mic: press to speak, press again; what was said joins the text (the idea, or the message to the agent). */
export function SayIt({ onText, onError, tip = 'Say the idea instead of typing it. Muse Voice Transcribe writes it here: 1 call', small }: { onText: (text: string) => void; onError: (m: string) => void; tip?: string; small?: boolean }) {
  const [rec, setRec] = useState<MediaRecorder | null>(null);
  const [hearing, setHearing] = useState(false);
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!rec) return;
    const started = Date.now();
    const timer = setInterval(() => setSeconds(Math.round((Date.now() - started) / 1000)), 250);
    return () => clearInterval(timer);
  }, [rec]);
  const start = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const type = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
      const r = new MediaRecorder(stream, type ? { mimeType: type } : {});
      const chunks: Blob[] = [];
      r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      r.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setHearing(true);
        try {
          const said = await call<{ text: string }>('idea_hear', { name: `idea.${r.mimeType.includes('mp4') ? 'm4a' : 'webm'}`, data: await base64(new Blob(chunks, { type: r.mimeType })) });
          if (said.text) onText(said.text);
        } catch (e) {
          onError((e as Error).message);
        } finally {
          setHearing(false);
        }
      };
      r.start(1000);
      setSeconds(0);
      setRec(r);
    } catch (e) {
      onError(`No microphone: ${(e as Error).message}`);
    }
  };
  return (
    <button type="button" class={`ghost ${small ? 'small' : 'bare'}${rec ? ' rec' : ''}`} disabled={hearing} title={rec ? 'Stop: what you said is written in' : tip} onClick={rec ? () => (rec.stop(), setRec(null)) : start}>
      {hearing ? 'Hearing…' : rec ? `■ Stop · ${seconds} s` : '🎙 Say it'}
    </button>
  );
}
