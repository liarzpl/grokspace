import type { DiffState, OverlapPeer, PathOverlap } from "../types";

/** Overlaps ride on the diff payload; git-missing / not-a-repo have none. */
export function overlapsOf(diff: DiffState): PathOverlap[] {
  if (diff.state === "clean" || diff.state === "changed") {
    return diff.overlaps ?? [];
  }
  return [];
}

/** Paths from a loaded diff that another tree also touched. */
export function overlapPathsOf(diff: DiffState): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const item of overlapsOf(diff)) {
    const path = item.path.trim();
    if (path === "" || seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }
  return paths;
}

export function overlapFor(overlaps: PathOverlap[], path: string): PathOverlap | undefined {
  return overlaps.find((item) => item.path === path);
}

function peerName(peer: OverlapPeer): string {
  if (peer.sessionId === null) return "the project";
  const title = peer.title?.trim();
  return title !== undefined && title !== "" ? title : "Agent";
}

function uniquePeerNames(overlaps: PathOverlap[]): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const item of overlaps) {
    for (const peer of item.peers) {
      const key = peer.sessionId ?? "";
      if (seen.has(key)) continue;
      seen.add(key);
      names.push(peerName(peer));
    }
  }
  return names;
}

function joinNames(names: string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

function basename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? path;
}

function hotspotLabels(overlaps: PathOverlap[]): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const item of overlaps) {
    if (!item.hotspot) continue;
    const name = basename(item.path);
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

function joinFiles(names: string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]} and ${names.length - 1} other generated files`;
}

/** Tooltip on a file row's red mark. */
export function overlapMarkTitle(overlap: PathOverlap): string {
  const who = joinNames(uniquePeerNames([overlap]));
  if (overlap.hotspot) {
    return `${who} also touched this lockfile or migration`;
  }
  return `Also touched by ${who}`;
}

/**
 * Merge-strip copy. Warns; it does not refuse Merge.
 * Hotspots (lockfiles, migrations) get a louder sentence.
 */
export function overlapStrip(overlaps: PathOverlap[]): string | null {
  if (overlaps.length === 0) return null;
  const who = joinNames(uniquePeerNames(overlaps));
  const hotspots = hotspotLabels(overlaps);
  if (hotspots.length === 0) {
    return `Also touched by ${who}.`;
  }
  const files = joinFiles(hotspots);
  const verb = hotspots.length === 1 ? "is" : "are";
  return `${files} ${verb} also touched by ${who}. Lockfiles and migrations conflict more often.`;
}

/** Toggle label. Off keeps git's list order. */
export const WALK_ORDER_LABEL = "Walk: hotspots → overlap → rest";

/**
 * Walk is on by default for an isolated scope that has overlaps.
 * Project view, no overlaps, or an explicit off all keep git order.
 */
export function walkEnabled(
  isolated: boolean,
  overlaps: readonly PathOverlap[],
  walkOn: boolean,
): boolean {
  return isolated && overlaps.length > 0 && walkOn;
}

/**
 * Reorder a file list: hotspots, then other overlaps, then the rest.
 * Off (or nothing to walk) returns the input order. Within a bucket,
 * the original order is kept.
 */
export function walkFiles<T extends { path: string }>(
  files: readonly T[],
  overlaps: readonly PathOverlap[],
  enabled: boolean,
): T[] {
  if (!enabled) return files.slice();

  const byPath = new Map(overlaps.map((item) => [item.path, item]));
  const hotspots: T[] = [];
  const shared: T[] = [];
  const rest: T[] = [];

  for (const file of files) {
    const overlap = byPath.get(file.path);
    if (overlap === undefined) {
      rest.push(file);
    } else if (overlap.hotspot) {
      hotspots.push(file);
    } else {
      shared.push(file);
    }
  }

  return [...hotspots, ...shared, ...rest];
}
