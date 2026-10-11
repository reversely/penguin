// The dashboard's icon set (identity plan D6, option A): ten icons drawn for Penguin, with no icon
// library and no copied third-party shapes. Each icon is one path on a 16-unit grid. Every point sits
// on a whole unit inside the live area from 2 to 14, so the set shares one optical size. One stroke
// weight constant serves the whole set. `icon.tsx` renders the icons in `currentColor`.

export const ICON_GRID = 16;
export const ICON_STROKE = 1.5;

export type IconName =
  | "back"
  | "chevron"
  | "send"
  | "check"
  | "close"
  | "copy"
  | "collapse-panel"
  | "external"
  | "more"
  | "clock";

export interface IconShape {
  /** One path in the 16-unit grid, drawn with round caps and joins. */
  readonly d: string;
  /** Whether the path also fills, for the dots of "more", which a stroke alone draws too small. */
  readonly filled?: true;
}

export const ICONS: Readonly<Record<IconName, IconShape>> = {
  back: { d: "M13 8H3M7 4L3 8l4 4" },
  chevron: { d: "M4 6l4 4l4-4" },
  send: { d: "M14 2L2 7l5 2l2 5zM14 2L7 9" },
  check: { d: "M3 8l3 3l7-7" },
  close: { d: "M4 4l8 8M12 4l-8 8" },
  copy: { d: "M3 10V4a1 1 0 0 1 1-1h6M7 6h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z" },
  "collapse-panel": { d: "M4 3h8a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM10 3v10M5 6l2 2l-2 2" },
  external: { d: "M12 9v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3M9 3h4v4M13 3L8 8" },
  more: { d: "M5 8a1 1 0 1 1-2 0a1 1 0 1 1 2 0zM9 8a1 1 0 1 1-2 0a1 1 0 1 1 2 0zM13 8a1 1 0 1 1-2 0a1 1 0 1 1 2 0z", filled: true },
  clock: { d: "M14 8a6 6 0 1 1-12 0a6 6 0 1 1 12 0M8 5v3l2 2" },
};
