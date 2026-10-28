// Where the page is, and whether it follows the agent: shared by the atelier's rail, the bell and the world.
import { signal } from '@preact/signals';

export const route = signal(location.pathname);
export const followAgent = signal(true);
/** The world the agent moved the view away from, so the person can go back. */
export const movedFrom = signal<string | null>(null);

export function go(path: string) {
  if (path === route.value) return;
  history.pushState(null, '', path);
  route.value = path;
}
addEventListener('popstate', () => (route.value = location.pathname));
