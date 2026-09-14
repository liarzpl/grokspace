/**
 * Roving index for a tablist or radiogroup. Returns null when the key is
 * not a move, so the caller can leave the event alone.
 */
export function adjacentIndex(current: number, key: string, length: number): number | null {
  if (length <= 0 || current < 0) return null;
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return (current + 1) % length;
    case "ArrowLeft":
    case "ArrowUp":
      return (current - 1 + length) % length;
    case "Home":
      return 0;
    case "End":
      return length - 1;
    default:
      return null;
  }
}

export function moveSegmented<T>(
  event: { key: string; preventDefault: () => void },
  options: readonly T[],
  current: T,
  choose: (option: T) => void,
  focusId?: (option: T) => string,
): void {
  const index = options.indexOf(current);
  const next = adjacentIndex(index, event.key, options.length);
  if (next === null) return;
  event.preventDefault();
  const option = options[next];
  if (option === undefined) return;
  choose(option);
  if (focusId !== undefined && typeof document !== "undefined") {
    document.getElementById(focusId(option))?.focus();
  }
}
