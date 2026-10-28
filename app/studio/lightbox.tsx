// Pictures open over the Studio, not in a new tab: any element with data-lightbox="<url>" opens it full size.
// Mounted once, like the tips; Esc, a click outside or ✕ closes it.
import { useEffect, useState } from 'preact/hooks';

export function Lightbox() {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    const open = (e: MouseEvent) => {
      const el = (e.target as Element | null)?.closest?.('[data-lightbox]');
      if (!el) return;
      e.preventDefault();
      e.stopPropagation();
      setSrc(el.getAttribute('data-lightbox'));
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setSrc(null);
    addEventListener('click', open, true);
    addEventListener('keydown', esc);
    return () => (removeEventListener('click', open, true), removeEventListener('keydown', esc));
  }, []);
  if (!src) return null;
  return (
    <div class="lightbox" role="dialog" aria-label="Picture" onClick={(e) => e.target === e.currentTarget && setSrc(null)}>
      <img src={src} alt="" />
      <button type="button" class="close" aria-label="Close" title="Close (Esc)" onClick={() => setSrc(null)}>✕</button>
    </div>
  );
}
