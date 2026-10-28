// Tooltips for the whole Studio: any element with a title gets a styled tip instead of the browser's slow grey
// one. Mounted once; it watches the pointer and keyboard focus, so a screen just writes title="what it does".
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

type Shown = { text: string; rect: DOMRect };

/** The game's frame and a select's options keep their own title. */
const SKIP = new Set(['IFRAME', 'OPTION']);
const WAIT_MS = 350;

/** Moves an element's title into data-tip (so the browser's own tip stays away) and returns the text. */
function tipOf(el: Element): string {
  const title = el.getAttribute('title');
  if (title) {
    el.setAttribute('data-tip', title);
    el.removeAttribute('title');
    if (!el.hasAttribute('aria-label') && !el.textContent?.trim()) el.setAttribute('aria-label', title);
  }
  return el.getAttribute('data-tip') ?? '';
}

function target(from: EventTarget | null): Element | null {
  const el = from instanceof Element ? from.closest('[title], [data-tip]') : null;
  return el && !SKIP.has(el.tagName) ? el : null;
}

export function Tips() {
  const [shown, setShown] = useState<Shown | null>(null);
  const tip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let over: Element | null = null;
    let timer = 0;
    // Right after one tip, the next shows at once: running along a row of buttons reads them all.
    let warmUntil = 0;
    const enter = (el: Element | null) => {
      if (el === over) return;
      clearTimeout(timer);
      if (over && !el) warmUntil = Date.now() + 500;
      over = el;
      if (!el) return setShown(null);
      tipOf(el);
      timer = window.setTimeout(() => {
        const text = over === el && el.isConnected ? tipOf(el) : '';
        setShown(text ? { text, rect: el.getBoundingClientRect() } : null);
      }, Date.now() < warmUntil ? 0 : WAIT_MS);
    };
    const onOver = (e: PointerEvent) => e.pointerType !== 'touch' && enter(target(e.target));
    const onFocus = (e: FocusEvent) => (e.target as Element)?.matches?.(':focus-visible') && enter(target(e.target));
    const hide = () => enter(null);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && hide();
    const on: Array<[EventTarget, string, EventListener, boolean?]> = [
      [document, 'pointerover', onOver as EventListener], [document, 'focusin', onFocus as EventListener], [document, 'focusout', hide],
      [document, 'pointerdown', hide, true], [document, 'keydown', onKey as EventListener], [window, 'scroll', hide, true], [window, 'blur', hide],
    ];
    for (const [t, name, fn, capture] of on) t.addEventListener(name, fn, capture);
    return () => {
      clearTimeout(timer);
      for (const [t, name, fn, capture] of on) t.removeEventListener(name, fn, capture);
    };
  }, []);
  // Above the element, or below it when there is no room; the edges stay 8 px inside the window.
  useLayoutEffect(() => {
    const el = tip.current;
    if (!el || !shown) return;
    const { rect } = shown;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const below = rect.top - h - 8 < 0;
    el.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, rect.left + rect.width / 2 - w / 2))}px`;
    el.style.top = `${below ? rect.bottom + 8 : rect.top - h - 8}px`;
    el.classList.add('on');
  }, [shown]);
  return shown ? <div ref={tip} class="tip" role="tooltip" key={shown.text}>{shown.text}</div> : null;
}
