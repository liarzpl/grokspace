/**
 * Graph tab heat is a count of host-written sidecar asks. Chip colour is not
 * a trust score — the badge stays a number.
 */

export function heatBadgeLabel(count: number): string {
  if (count <= 0) return "";
  return count === 1 ? "1 permission answer" : `${count} permission answers`;
}
