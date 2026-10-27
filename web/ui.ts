// The play page's HTML layer over the canvas: the courier's bag of painted items, the item held as the
// cursor, the flight of a picked-up item into the bag, and the conversation's answer cards.
import { words } from './words.ts';

/** What the page knows about an item: its name and its icon (diorama icons), if it has one. */
export type ItemLook = { name: string; icon?: string };

const PICKUP_MS = 900;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
};

/** A key like "ornitolog-mila" as a name to show: "Ornitolog Mila". */
export const displayName = (key: string) => key.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

export class Bag {
  private readonly root = document.getElementById('inventory')!;
  private readonly slots = el('div', 'slots');
  private readonly toast = el('div', 'toast');
  private readonly cursor = el('div', 'held-cursor');
  private readonly cursorImg = el('img');
  private readonly cursorLabel = el('div', 'label');
  /** Items on their way into the bag: their slot stays empty until they land. */
  private flying = new Set<string>();
  private shown: string[] = [];
  private holding: string | undefined;

  /** `pointer` false (recordings, cursor=0): the held item does not follow a pointer. */
  constructor(private readonly look: (key: string) => ItemLook, private readonly onPick: (key: string) => void, private readonly pointer = true) {
    const bag = el('div', 'bag');
    bag.innerHTML = '<svg width="38" height="38" viewBox="0 0 42 42" aria-hidden="true"><path d="M7 14 h28 v20 a3 3 0 0 1 -3 3 h-22 a3 3 0 0 1 -3 -3 z" fill="#5f8f8a" stroke="#2b2118" stroke-width="2.2"/><path d="M7 14 l4 -7 h20 l4 7" fill="#7aa9a2" stroke="#2b2118" stroke-width="2.2" stroke-linejoin="round"/><rect x="17" y="18" width="8" height="8" rx="1.5" fill="#c9774a" stroke="#2b2118" stroke-width="2"/></svg>';
    this.root.replaceChildren(bag, this.slots);
    this.cursorImg.alt = '';
    this.cursor.append(this.cursorImg, this.cursorLabel);
    this.cursor.hidden = true;
    // Off the page until the pointer first moves.
    this.cursor.style.transform = 'translate(-300px, -300px)';
    document.getElementById('hud')!.append(this.toast);
    document.body.append(this.cursor);
  }

  /** Redraws the slots for the items carried now; `holding` is lifted and becomes the cursor. */
  show(items: string[], holding: string | undefined) {
    this.shown = items;
    this.holding = holding;
    this.root.hidden = items.length === 0;
    this.slots.replaceChildren(...items.map((key) => {
      const item = this.look(key);
      const b = el('button', `slot${key === holding ? ' held' : ''}${this.flying.has(key) ? ' arriving' : ''}`);
      b.dataset.item = key;
      b.title = item.name;
      b.setAttribute('aria-label', item.name);
      if (item.icon) {
        const img = el('img');
        img.src = item.icon;
        img.alt = '';
        b.append(img);
      } else b.append(el('span', 'name', item.name));
      b.onclick = (e) => {
        e.stopPropagation();
        this.onPick(key);
      };
      return b;
    }));
    const held = holding ? this.look(holding) : undefined;
    this.cursor.hidden = !held || !this.pointer;
    if (held) {
      this.cursorImg.hidden = !held.icon;
      if (held.icon) this.cursorImg.src = held.icon;
    }
  }

  /** Dims the bag while a conversation has the floor. */
  quiet(on: boolean) {
    this.root.classList.toggle('quiet', on);
  }

  /** Moves the held item with the pointer; `over` names what it would be used on. */
  point(x: number, y: number, over: string | undefined) {
    if (!this.holding) return;
    this.cursor.style.transform = `translate(${x}px, ${y}px)`;
    const name = this.look(this.holding).name;
    this.cursorLabel.textContent = over ? words.useOn(name, over) : name;
  }

  /** A new item flies from where it was (a page rect) into its slot, then the slot pops and its name shows. */
  async pickUp(key: string, from: DOMRect | undefined) {
    const item = this.look(key);
    this.flying.add(key);
    this.show(this.shown.includes(key) ? this.shown : [...this.shown, key], this.holding);
    const slot = this.slots.querySelector<HTMLElement>(`[data-item="${CSS.escape(key)}"]`);
    if (slot && from && item.icon) {
      const to = slot.getBoundingClientRect();
      const ghost = el('img', 'flying');
      ghost.src = item.icon;
      document.body.append(ghost);
      // The icon is square and the item fills most of it, so it starts as big as the thing it was; an item found in
      // something big (a fish from the stalls) comes out of its middle at a few slots' size.
      const size = Math.min(Math.max(from.width, from.height) * 1.12, to.width * 2.5);
      const start = { x: from.left + from.width / 2 - size / 2, y: from.top + from.height / 2 - size / 2 };
      const end = { x: to.left + to.width / 2 - size / 2, y: to.top + to.height / 2 - size / 2 };
      const scale = (to.width * 0.8) / size;
      Object.assign(ghost.style, { width: `${size}px`, height: `${size}px`, left: `${start.x}px`, top: `${start.y}px` });
      const lift = { x: (end.x - start.x) * 0.35, y: Math.min(0, end.y - start.y) * 0.3 - 80 };
      await ghost.animate([
        { transform: 'translate(0, 0) scale(1)', filter: 'drop-shadow(0 0 0 #ffd37a)' },
        { transform: 'translate(0, -18px) scale(1.08)', filter: 'drop-shadow(0 0 12px #ffd37a)', offset: 0.18 },
        { transform: `translate(${lift.x}px, ${lift.y}px) scale(${(1 + scale) / 2})`, filter: 'drop-shadow(0 0 10px #ffd37a)', offset: 0.55 },
        { transform: `translate(${end.x - start.x}px, ${end.y - start.y}px) scale(${scale})`, filter: 'drop-shadow(0 2px 1px #2b211855)' },
      ], { duration: PICKUP_MS, easing: 'cubic-bezier(.45,.05,.4,1)' }).finished.catch(() => undefined);
      ghost.remove();
    }
    this.flying.delete(key);
    this.show(this.shown, this.holding);
    this.slots.querySelector(`[data-item="${CSS.escape(key)}"]`)?.animate(
      [{ transform: 'scale(1)' }, { transform: 'scale(1.18)', background: '#ffe7a8' }, { transform: 'scale(1)' }],
      { duration: 360, easing: 'ease-out' },
    );
    this.toast.textContent = `+ ${item.name}`;
    this.toast.animate([{ opacity: 0, transform: 'translate(-50%, 8px)' }, { opacity: 1, transform: 'translate(-50%, 0)', offset: 0.15 }, { opacity: 1, offset: 0.8 }, { opacity: 0 }], { duration: 1800 });
  }
}

/** The hero's answers as numbered cards; keys 1 to 4 pick them too, and a gamepad moves a lit card and picks it. */
export class Answers {
  private readonly root = document.getElementById('talk')!;
  private picks: Array<() => void> = [];
  private cards: HTMLButtonElement[] = [];
  private texts = '';
  /** The card a gamepad would pick; lit only once a pad has been used. */
  private focus = 0;

  constructor() {
    addEventListener('keydown', (e) => {
      const n = Number(e.key);
      if (n >= 1 && n <= this.picks.length) this.picks[n - 1]();
    });
  }

  show(options: Array<{ text: string; pick: () => void }>, hero?: { name: string; portrait?: string }) {
    this.picks = options.map((o) => o.pick);
    this.root.hidden = options.length === 0;
    // New answers start from the first card; the same ones redrawn keep the lit one.
    const texts = options.map((o) => o.text).join('\n');
    if (texts !== this.texts) [this.texts, this.focus] = [texts, 0];
    this.cards = [];
    if (!options.length) return this.root.replaceChildren();
    const who = el('div', 'who');
    if (hero?.portrait) {
      const face = el('div', 'face');
      const img = el('img');
      img.src = hero.portrait;
      img.alt = '';
      face.append(img);
      who.append(face);
    }
    if (hero) who.append(el('span', 'tag', hero.name));
    this.cards = options.map((o, i) => {
      const b = el('button', 'answer');
      b.append(el('span', 'key', String(i + 1)), document.createTextNode(o.text));
      b.onclick = o.pick;
      return b;
    });
    this.root.replaceChildren(who, ...this.cards);
    this.light();
  }

  /** Moves the lit card up (-1) or down (1), round from the last to the first. */
  move(by: number) {
    if (!this.picks.length) return;
    this.focus = (this.focus + by + this.picks.length) % this.picks.length;
    this.light();
  }

  /** Picks the lit card; false when no answers are up. */
  pick(): boolean {
    const card = this.cards[this.focus];
    if (!card) return false;
    card.click();
    return true;
  }

  private light() {
    this.cards.forEach((c, i) => c.classList.toggle('focus', i === this.focus));
  }
}

/** The ending as a paper card over the dimmed scene: its title, its text, what the hero carried, and a way to play again. */
export function showEnding(ending: { title: string; text: string } | undefined, carried: ItemLook[]) {
  const root = document.getElementById('ending')!;
  root.hidden = !ending;
  if (!ending) return root.replaceChildren();
  const card = el('div', 'card');
  const icons = el('div', 'carried');
  for (const item of carried.filter((i) => i.icon)) {
    const img = el('img');
    img.src = item.icon!;
    img.alt = item.name;
    img.title = item.name;
    icons.append(img);
  }
  const again = el('button', 'again', words.again);
  again.onclick = () => {
    // From the start: drop a place= the page may have been opened with.
    const url = new URL(location.href);
    url.searchParams.delete('place');
    location.href = url.toString();
  };
  card.append(el('div', 'over', words.end), el('h1', '', ending.title), el('p', '', ending.text), ...(icons.childElementCount ? [icons] : []), again);
  root.replaceChildren(card);
  card.animate([{ opacity: 0, transform: 'translateY(16px) scale(.97)' }, { opacity: 1, transform: 'none' }], { duration: 700, easing: 'ease-out' });
}

/** Lays the HTML layer over the canvas as drawn (letterboxed, scaled): 1 CSS px of it is 1 px of the frame. */
export function fitHud(canvas: HTMLCanvasElement) {
  const hud = document.getElementById('hud')!;
  const r = canvas.getBoundingClientRect();
  const k = r.width / canvas.width;
  const t = `translate(${r.left}px, ${r.top}px) scale(${k})`;
  if (hud.style.transform !== t) hud.style.transform = t;
}
