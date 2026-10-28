// The agent's side of the Workshop: docked right or left at a width you drag, floating as a window you move and
// resize, or folded to a thin bar. Kept per machine (localStorage), so the next visit opens it the same way.
import type { ComponentChildren } from 'preact';
import { useRef, useState } from 'preact/hooks';

export type DockState = { side: 'right' | 'left' | 'float'; width: number; folded: boolean; box: { x: number; y: number; w: number; h: number } };

const KEY = 'diorama.dock';
const START: DockState = { side: 'right', width: 380, folded: false, box: { x: 0, y: 80, w: 420, h: 620 } };
const [MIN_W, MIN_H] = [320, 280];
// The Workshop keeps at least MAIN px beside the panel: a wide agent never squeezes the build under itself.
const MAIN = 600;
export const clampWidth = (w: number) => Math.round(Math.min(Math.max(w, 300), Math.max(320, Math.min(innerWidth * 0.6, innerWidth - MAIN))));

export function useDock(): [DockState, (d: Partial<DockState>) => void] {
  const [dock, setDock] = useState<DockState>(() => {
    try {
      return { ...START, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<DockState>) };
    } catch {
      return START;
    }
  });
  const change = (d: Partial<DockState>) => setDock((old) => {
    const next = { ...old, ...d };
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // A private window keeps it for this visit only.
    }
    return next;
  });
  return [dock, change];
}

/** Starts a drag; `move` gets how far the pointer went since it began. */
function drag(e: PointerEvent, move: (dx: number, dy: number) => void) {
  e.preventDefault();
  const [x0, y0] = [e.clientX, e.clientY];
  const on = (m: PointerEvent) => move(m.clientX - x0, m.clientY - y0);
  const off = () => (removeEventListener('pointermove', on), removeEventListener('pointerup', off), document.body.classList.remove('dragging'));
  document.body.classList.add('dragging');
  addEventListener('pointermove', on);
  addEventListener('pointerup', off);
}

export function Dock({ dock, onChange, title, children }: { dock: DockState; onChange: (d: Partial<DockState>) => void; title: string; children: ComponentChildren }) {
  const panel = useRef<HTMLElement>(null);
  const float = dock.side === 'float';
  // Off screen after the window got smaller: back inside.
  const fitW = Math.min(dock.box.w, innerWidth - 16);
  const fitH = Math.min(dock.box.h, innerHeight - 16);
  const box = { w: fitW, h: fitH, x: Math.min(Math.max(0, dock.box.x || innerWidth - fitW - 24), innerWidth - fitW - 8), y: Math.min(Math.max(0, dock.box.y), innerHeight - fitH - 8) };
  const style = float && !dock.folded ? { left: `${box.x}px`, top: `${box.y}px`, width: `${box.w}px`, height: `${box.h}px` } : float ? { left: `${box.x}px`, top: `${box.y}px` } : undefined;
  const resize = (e: PointerEvent) => {
    const w0 = dock.width;
    drag(e, (dx) => onChange({ width: clampWidth(w0 + (dock.side === 'right' ? -dx : dx)) }));
  };
  // A floating window resizes from any edge or corner; the opposite side stays where it is.
  const stretch = (edge: string) => (e: PointerEvent) => {
    const b0 = box;
    drag(e, (dx, dy) => {
      let { x, y, w, h } = b0;
      if (edge.includes('e')) w = b0.w + dx;
      if (edge.includes('s')) h = b0.h + dy;
      if (edge.includes('w')) (w = b0.w - dx, x = b0.x + dx);
      if (edge.includes('n')) (h = b0.h - dy, y = b0.y + dy);
      // Never smaller than a usable chat: the far edge holds still.
      if (w < MIN_W) (edge.includes('w') && (x -= MIN_W - w), w = MIN_W);
      if (h < MIN_H) (edge.includes('n') && (y -= MIN_H - h), h = MIN_H);
      onChange({ box: { x, y: Math.max(0, y), w, h } });
    });
  };
  const move = (e: PointerEvent) => {
    if (!float || (e.target as HTMLElement).closest('button')) return;
    const b0 = box;
    drag(e, (dx, dy) => onChange({ box: { ...b0, x: b0.x + dx, y: b0.y + dy } }));
  };
  return (
    <aside ref={panel} class={`right dock ${dock.side}${dock.folded ? ' folded' : ''}`} style={style}>
      <div class="dockbar" onPointerDown={move} onMouseDown={(e) => float && !(e.target as HTMLElement).closest('button') && e.preventDefault()}>
        <span class="dock-title">{title}</span>
        <span class="grow" />
        {!dock.folded && <>
          <button type="button" class={`ghost tiny${dock.side === 'left' ? ' on' : ''}`} title="Dock on the left" aria-label="Dock on the left" onClick={() => onChange({ side: 'left' })}>⇤</button>
          <button type="button" class={`ghost tiny${float ? ' on' : ''}`} title="Float as a window" aria-label="Float as a window" onClick={() => onChange({ side: 'float', box: { ...dock.box, x: dock.box.x || innerWidth - dock.box.w - 24 } })}>⧉</button>
          <button type="button" class={`ghost tiny${dock.side === 'right' ? ' on' : ''}`} title="Dock on the right" aria-label="Dock on the right" onClick={() => onChange({ side: 'right' })}>⇥</button>
        </>}
        <button type="button" class="ghost tiny" title={dock.folded ? 'Open the panel' : 'Fold the panel'} aria-label={dock.folded ? 'Open the panel' : 'Fold the panel'} aria-expanded={!dock.folded} onClick={() => onChange({ folded: !dock.folded })}>{dock.folded ? '+' : '–'}</button>
      </div>
      {/* Folded, the agent keeps running and keeps its conversation: only hidden. */}
      <div class="dock-body" hidden={dock.folded}>{children}</div>
      {float && !dock.folded && ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map((edge) => <div key={edge} class={`grip ${edge}`} onPointerDown={stretch(edge)} onMouseDown={(e) => e.preventDefault()} />)}
      {!float && !dock.folded && <div class="dock-edge" title="Drag to resize" onPointerDown={resize} onMouseDown={(e) => e.preventDefault()} />}
    </aside>
  );
}
