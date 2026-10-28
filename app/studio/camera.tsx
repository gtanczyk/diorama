// Pictures for the agent: a photo or a drawing shrunk to travel light, and the webcam held up to the paper.
import { useEffect, useRef, useState } from 'preact/hooks';

/** A photo shrunk to 1600 px as JPEG, so a phone picture travels light; what the browser cannot read goes as it is. */
export async function shrink(file: Blob): Promise<string> {
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

export function base64(blob: Blob): Promise<string> {
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
