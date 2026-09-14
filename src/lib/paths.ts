/**
 * Shortens an absolute path for display, the way a shell prompt would.
 * Purely cosmetic: the full path is always kept on the project record.
 */
export function homeRelative(path: string): string {
  const match = /^(\/(?:Users|home)\/[^/]+)(\/.*)?$/.exec(path);
  if (!match) return path;
  return `~${match[2] ?? ""}`;
}
