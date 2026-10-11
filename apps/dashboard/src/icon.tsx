import { ICON_GRID, ICON_STROKE, ICONS, type IconName } from "./icons.ts";

/**
 * One icon from the set, drawn in `currentColor` so it takes the colour of the text beside it.
 * Beside a visible label it is hidden from assistive technology. Standing alone it needs `label`,
 * which names it as an image.
 */
export function Icon({ name, label }: { name: IconName; label?: string }) {
  const { d, filled } = ICONS[name];
  const named = label === undefined ? { "aria-hidden": true } : { role: "img", "aria-label": label };
  return (
    <svg
      className="icon"
      viewBox={`0 0 ${ICON_GRID} ${ICON_GRID}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={ICON_STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...named}
    >
      <path d={d} fill={filled ? "currentColor" : undefined} />
    </svg>
  );
}
