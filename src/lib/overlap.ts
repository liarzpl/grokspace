import type { DiffState, OverlapPeer, PathOverlap } from "../types";

/** Overlaps ride on the diff payload; git-missing / not-a-repo have none. */
export function overlapsOf(diff: DiffState): PathOverlap[] {
  if (diff.state === "clean" || diff.state === "changed") {
    return diff.overlaps ?? [];
  }
  return [];
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
