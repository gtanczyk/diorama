// Asking before something big or hard to take back, in the Studio's own dialog instead of the browser's confirm.
// `type` makes the person type a word (the world's slug) before the button wakes up, as GitHub does for deletes.
import { signal } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';

type Ask = { title: string; body: string; go: string; danger?: boolean; type?: string; answer: (yes: boolean) => void };
const asking = signal<Ask | null>(null);

/** Resolves true when the person presses `go`, false on Cancel, Esc or a click outside. */
export function askSure(o: Omit<Ask, 'answer'>): Promise<boolean> {
  return new Promise((answer) => {
    asking.value?.answer(false);
    asking.value = { ...o, answer };
  });
}

/** Mounted once, like the lightbox. */
export function Sure() {
  const a = asking.value;
  const [typed, setTyped] = useState('');
  const box = useRef<HTMLInputElement>(null);
  const done = (yes: boolean) => {
    a?.answer(yes);
    asking.value = null;
    setTyped('');
  };
  useEffect(() => {
    if (!a) return;
    box.current?.focus();
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && (e.stopPropagation(), done(false));
    addEventListener('keydown', esc, true);
    return () => removeEventListener('keydown', esc, true);
  }, [a]);
  if (!a) return null;
  const ok = !a.type || typed.trim() === a.type;
  return (
    <div class="sure-back" onClick={(e) => e.target === e.currentTarget && done(false)}>
      <form class="sure" role="alertdialog" aria-label={a.title} onSubmit={(e) => (e.preventDefault(), ok && done(true))}>
        <h2>{a.title}</h2>
        <p>{a.body}</p>
        {a.type && (
          <label><span>Type <code>{a.type}</code> to confirm</span>
            <input ref={box} value={typed} autoComplete="off" spellcheck={false} onInput={(e) => setTyped(e.currentTarget.value)} />
          </label>
        )}
        <div class="row">
          <span class="grow" />
          <button type="button" class="ghost" onClick={() => done(false)}>Cancel</button>
          <button type="submit" class={a.danger ? 'danger-fill' : 'primary'} disabled={!ok}>{a.go}</button>
        </div>
      </form>
    </div>
  );
}
