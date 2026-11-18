// The OPAC's icons: a handful of line drawings on a 24 px grid, written here as inline SVG (no file is fetched, and an
// SVG element needs nothing of the Content-Security-Policy). An icon never stands alone: it sits beside its word, or in
// a control whose `aria-label` says what it does, so every one is hidden from assistive technology.

const SHAPES = {
  search: ['M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z', 'M15.5 15.5 20 20'],
  phone: ['M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z', 'M11 18h2'],
  mail: ['M4 6h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z', 'm3.5 7.5 8.5 6 8.5-6'],
  user: ['M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8z', 'M4.5 20.5c.6-3.6 3.7-6 7.5-6s6.9 2.4 7.5 6'],
  menu: ['M4 7h16', 'M4 12h16', 'M4 17h16'],
  check: ['m5 12.5 4.5 4.5L19 7.5'],
  clock: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M12 7.5V12l3 2'],
  info: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M12 11v5', 'M12 8h.01'],
  external: ['M14 4h6v6', 'm20 4-9 9', 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'],
  right: ['m9.5 6 6 6-6 6'],
  left: ['m14.5 6-6 6 6 6'],
  pause: ['M8 5v14', 'M16 5v14'],
  play: ['M8 5v14l11-7z'],
  x: ['M6 6l12 12', 'M18 6 6 18'],
} as const;

export type IconName = keyof typeof SHAPES;

/** The paths of `name`, for a script that swaps one icon for another without building markup from text. */
export function iconPaths(name: IconName): readonly string[] {
  return SHAPES[name];
}

/** The icon `name`, 18 px beside text (the stylesheet's `.ico`); always decorative. */
export function Icon(props: { name: IconName; class?: string }) {
  return (
    <svg
      class={props.class === undefined ? 'ico' : `ico ${props.class}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {SHAPES[props.name].map((d) => (
        <path d={d} />
      ))}
    </svg>
  );
}
