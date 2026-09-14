/**
 * Whether the user asked the OS to cut motion.
 *
 * Graph pulse already dies in CSS. The other two movers — xterm's blinking
 * caret and React Flow's animated edges — are constructed in JS and never see
 * that media query unless we read it here.
 */

const QUERY = "(prefers-reduced-motion: reduce)";

export function prefersReducedMotion(
  media: Pick<MediaQueryList, "matches"> | null = defaultMedia(),
): boolean {
  return media?.matches === true;
}

function defaultMedia(): Pick<MediaQueryList, "matches"> | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return null;
  }
  return window.matchMedia(QUERY);
}
