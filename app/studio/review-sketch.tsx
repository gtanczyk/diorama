import { useId } from 'preact/hooks';

/** A small paper theatre while the model works, not a preview of the user's game. */
export function ReviewSketch({ compact = false }: { compact?: boolean }) {
  const clip = useId();
  return <span class={`review-sketch${compact ? ' compact' : ''}`} aria-hidden="true">
    <svg viewBox="0 0 440 320" fill="none">
      <defs><clipPath id={clip}><path d="M130 256V131a90 90 0 0 1 180 0v125Z" /></clipPath></defs>
      <ellipse cx="224" cy="284" rx="139" ry="11" fill="#746448" opacity=".07" />
      <g class="sketch-leaf sketch-leaf-left">
        <path d="m57 99 94-17 26 161-94 17Z" fill="#e4d9c5" />
        <path d="m53 93 94-17 26 161-94 17Z" fill="#fbf7ed" stroke="#d8cbb5" />
        <path d="m85 207 12-69 21-5 21 63M89 180l39-7m-23-42-3-17m-12 9 23-4" stroke="#716e58" stroke-width="1.5" stroke-linecap="round" class="sketch-ink" pathLength="1" />
        <circle cx="106" cy="112" r="11" stroke="#716e58" stroke-width="1.5" />
        <path d="m90 228 48-9m-45 15 28-5" stroke="#d8cbb5" stroke-width="2" stroke-linecap="round" />
      </g>
      <g class="sketch-leaf sketch-leaf-right">
        <path d="m287 96 100 19-28 145-100-19Z" fill="#e4d9c5" />
        <path d="m291 89 100 19-28 145-100-19Z" fill="#fbf7ed" stroke="#d8cbb5" />
        <circle cx="345" cy="137" r="17" fill="#d4a659" opacity=".6" />
        <path d="m290 193 29-29 15 20 15-7 16 30m-69-58 12 3m-25 62 63 12m-66-4 44 9" stroke="#8e9986" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
      </g>
      <g class="sketch-theatre">
        <path d="M116 274V131a104 104 0 0 1 208 0v143Z" fill="#dacbb3" opacity=".5" transform="translate(3 5)" />
        <path d="M116 274V131a104 104 0 0 1 208 0v143Z" fill="#fbf7ed" stroke="#cdbc9f" />
        <g clip-path={`url(#${clip})`}>
          <path d="M130 40h180v216H130Z" fill="#dce3df" />
          <circle class="sketch-sun" cx="258" cy="107" r="24" fill="#c88b39" opacity=".8" />
          <path d="M114 199q50-61 105-15t105-22v101H114Z" fill="#a7b3a0" />
          <path d="M114 231q71-66 133-17t80-7v62H114Z" fill="#768778" />
          <path d="M159 258q90-50 51-67-18-11 7-19" stroke="#efe6cf" stroke-width="15" />
          <path d="M146 228q46-30 82-12m13 13 49 18" stroke="#526654" opacity=".35" stroke-linecap="round" />
          <path d="M166 191v-48l20-15 20 15v45m-29 0v-26h13v26m-29-43 25-22 26 22" stroke="#4e584b" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" class="sketch-ink" pathLength="1" />
          <path d="m275 222-1-55m-17 25q-8-16 5-23-1-22 15-23 22 2 14 23 15 10 3 25-20 14-37-2Z" stroke="#4e584b" stroke-width="1.6" stroke-linejoin="round" class="sketch-ink sketch-ink-late" pathLength="1" />
        </g>
        <path d="M130 256V131a90 90 0 0 1 180 0v125Z" stroke="#cabba3" />
        <path d="M201 265h38" stroke="#cdbc9f" stroke-linecap="round" />
      </g>
      <g class="sketch-pencil" transform="translate(307 238) rotate(32)">
        <path d="M0-59h7v68H0Z" fill="#bd7b2b" /><path d="M0-59h2v68H0Z" fill="#e1b571" />
        <path d="m0 9 3.5 13L7 9Z" fill="#dfc8a2" /><path d="m2 17 1.5 5L5 17Z" fill="#484336" />
        <path d="M0-61q3.5-4 7 0v5H0Z" fill="#7c8370" />
      </g>
      <path d="m350 58 1 12m-6-6 12-1m-281 2 2 9m-6-4 10-1" stroke="#c39a5e" stroke-width="1.5" stroke-linecap="round" opacity=".7" />
    </svg>
  </span>;
}
