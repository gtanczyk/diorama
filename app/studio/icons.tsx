// The Studio's signs: small line drawings in the logo's stroke, not emoji. Each takes the text colour; a title on
// the element around it says what it means.
import type { JSX } from 'preact';

const PATHS = {
  pin: 'M12 21s-6-5.6-6-10.5a6 6 0 0 1 12 0C18 15.4 12 21 12 21Z M12 12.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z',
  zoom: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13Z M15.3 15.3L20 20 M10.5 8v5 M8 10.5h5',
  pencil: 'M4 20l1-4L15.5 5.5a2.1 2.1 0 0 1 3 3L8 19l-4 1Z M13.5 7.5l3 3',
  mic: 'M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3Z M6 11a6 6 0 0 0 12 0 M12 17v4',
  camera: 'M4 8h3l2-3h6l2 3h3v11H4Z M12 16.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z',
  undo: 'M9 7L4 12l5 5 M4 12h10a6 6 0 0 1 0 12',
  repair: 'M20 12a8 8 0 1 1-2.3-5.6 M20 4v5h-5',
  paw: 'M8 10.5a1.8 2.2 0 1 0 0-.1Z M16 10.5a1.8 2.2 0 1 0 0-.1Z M11 7.5a1.6 2 0 1 0 0-.1Z M13 7.5a1.6 2 0 1 0 0-.1Z M12 13c-2.5 0-4.5 2.6-4.5 4.4 0 1.4 1.2 2.1 2.5 1.8 1.3-.3 2.7-.3 4 0 1.3.3 2.5-.4 2.5-1.8 0-1.8-2-4.4-4.5-4.4Z',
  figure: 'M4 5h16v14H4Z M4 16l5-5 4 4 2-2 5 5 M15.5 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z',
  bone: 'M8 5.5a2 2 0 1 0-3 2.6 2 2 0 1 0 2.6 3L13 16.4a2 2 0 1 0 3 2.6 2 2 0 1 0-2.6-3L8 10.6',
  cube: 'M12 3l8 4.5v9L12 21l-8-4.5v-9Z M4 7.5l8 4.5 8-4.5 M12 12v9',
  film: 'M4 5h16v14H4Z M8 5v14 M16 5v14 M4 9h4 M4 15h4 M16 9h4 M16 15h4',
  build: 'M4 20h16 M6 20V10l6-5 6 5v10 M10 20v-5h4v5',
  person: 'M12 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z M8 21l1-7-2-1 2-4h6l2 4-2 1 1 7',
  book: 'M4 5c3-1 6-1 8 1 2-2 5-2 8-1v14c-3-1-6-1-8 1-2-2-5-2-8-1Z M12 6v14',
  brush: 'M14 4l6 6-7 7-6-6Z M7 11c-2 0-3 1.5-3 3.5 0 2.5-1 4.5-1 4.5s3.5 0 5.5-1.5C10 16 10 14 10 14',
  scissors: 'M6 8.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z M6 20.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z M8 7l12 10 M8 17L20 7',
  ruler: 'M3 17L17 3l4 4L7 21Z M7 13l2 2 M10 10l2 2 M13 7l2 2',
  sound: 'M4 9h4l5-4v14l-5-4H4Z M16.5 8.5a5 5 0 0 1 0 7 M19 6a8.5 8.5 0 0 1 0 12',
  bag: 'M5 8h14l-1 12H6Z M9 8V6a3 3 0 0 1 6 0v2',
  box: 'M3 7.5L12 3l9 4.5v9L12 21l-9-4.5Z M3 7.5L12 12l9-4.5 M12 12v9 M7.5 5.2l9 4.5',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M12 2.5v3 M12 18.5v3 M2.5 12h3 M18.5 12h3 M5.3 5.3l2.1 2.1 M16.6 16.6l2.1 2.1 M5.3 18.7l2.1-2.1 M16.6 7.4l2.1-2.1',
  warning: 'M12 4l9 16H3Z M12 10v4 M12 17v.5',
  agent: 'M6 9h12v10H6Z M12 9V5 M12 4.5a1 1 0 1 0 0-.1Z M9.5 13.5v1 M14.5 13.5v1 M3 13v3 M21 13v3',
  hand: 'M9 12V5.5a1.5 1.5 0 0 1 3 0V11 M12 10V4.5a1.5 1.5 0 0 1 3 0V11 M15 10.5V6a1.5 1.5 0 0 1 3 0v7c0 4-2.5 7-6 7-2.5 0-4-1-5.5-3L4 13.5a1.5 1.5 0 0 1 2.3-2L9 14',
  play: 'M5 9a4 4 0 0 1 4-3h6a4 4 0 0 1 4 3l1.5 6.5a2 2 0 0 1-3.6 1.5L15 15H9l-1.9 2a2 2 0 0 1-3.6-1.5Z M8 9.5v3 M6.5 11h3 M15.5 10.5h.1 M17 12h.1',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, ...rest }: { name: IconName; size?: number } & JSX.SVGAttributes<SVGSVGElement>) {
  return (
    <svg class="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={1.6} stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" {...rest}>
      <path d={PATHS[name]} />
    </svg>
  );
}
