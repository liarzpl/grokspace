/**
 * Enter/Space on a focused button fire `click` with `detail === 0`.
 * A pointer click is `detail >= 1`. Used so inline titles can be renamed
 * from the keyboard without turning a mouse click into an edit.
 */
export function isKeyboardClick(event: { detail: number }): boolean {
  return event.detail === 0;
}
