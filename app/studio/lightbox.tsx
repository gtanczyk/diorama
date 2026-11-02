// Pictures open over the Studio, not in a new tab: any element with data-lightbox="<url>" opens it full size.
// Mounted once, like the tips; Esc, a click outside or ✕ closes it. ← and → go through the other pictures beside it
// (the closest [data-lightbox-group], else the page).
import { useEffect, useRef, useState } from 'preact/hooks';

export function Lightbox() {
  const [shown, setShown] = useState<{ all: string[]; at: number } | null>(null);
  const src = shown?.all[shown.at] ?? null;
  const isOpen = useRef(false);
  isOpen.current = !!src;
  const setSrc = (s: null) => setShown(s);
  const step = (by: number) => setShown((v) => (v && v.all.length > 1 ? { ...v, at: (v.at + by + v.all.length) % v.all.length } : v));
  useEffect(() => {
    const open = (e: MouseEvent) => {
      const el = (e.target as Element | null)?.closest?.('[data-lightbox]');
      if (!el) return;
      e.preventDefault();
      e.stopPropagation();
      const scope = el.closest('[data-lightbox-group]') ?? document;
      const all = [...new Set([...scope.querySelectorAll('[data-lightbox]')].map((x) => x.getAttribute('data-lightbox')!))];
      setShown({ all, at: Math.max(0, all.indexOf(el.getAttribute('data-lightbox')!)) });
    };
    // Captured first and kept to itself while a picture is open: Esc closes the picture only, never also the
    // drawer, view or step it was opened from (their Esc handlers listen after this one).
    const esc = (e: KeyboardEvent) => {
      if (!isOpen.current || !['Escape', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === 'Escape') setSrc(null);
      if (e.key === 'ArrowLeft') step(-1);
      if (e.key === 'ArrowRight') step(1);
    };
    addEventListener('click', open, true);
    addEventListener('keydown', esc, true);
    return () => (removeEventListener('click', open, true), removeEventListener('keydown', esc, true));
  }, []);
  if (!src) return null;
  return (
    <div class="lightbox" role="dialog" aria-label="Picture" onClick={(e) => e.target === e.currentTarget && setSrc(null)}>
      <img src={src} alt="" />
      {shown!.all.length > 1 && <>
        <button type="button" class="prev" aria-label="Previous" title="Previous (←)" onClick={() => step(-1)}>‹</button>
        <button type="button" class="next" aria-label="Next" title="Next (→)" onClick={() => step(1)}>›</button>
        <span class="count">{shown!.at + 1} / {shown!.all.length}</span>
      </>}
      <button type="button" class="close" aria-label="Close" title="Close (Esc)" onClick={() => setSrc(null)}>✕</button>
    </div>
  );
}
