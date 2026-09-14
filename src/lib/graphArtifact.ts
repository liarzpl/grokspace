import { api } from "./api";
import { useDiffStore } from "../stores/diffStore";
import { useUiStore } from "../stores/uiStore";

/**
 * Whether a graph node's `artifactPath` is a file the Diff panel can open.
 *
 * Directories are written with a trailing slash in the sample graphs; those
 * stay as labels. An empty path is not a file either.
 */
export function isFileArtifact(path: string | undefined): boolean {
  if (path === undefined) return false;
  const trimmed = path.trim();
  if (trimmed === "") return false;
  return !trimmed.endsWith("/") && !trimmed.endsWith("\\");
}

const MARKDOWN_EXT = new Set([".md", ".markdown", ".mdown"]);
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

export type ArtifactPreviewKind = "markdown" | "image";

/**
 * What the inspector may preview. Markdown is shown as escaped text; images
 * as `<img>`. HTML, SVG, and everything else stay off the allow-list so an
 * agent's file cannot run in the webview.
 */
export function artifactPreviewKind(path: string | undefined): ArtifactPreviewKind | null {
  if (!isFileArtifact(path) || path === undefined) return null;
  const base = path.trim().split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = base.slice(dot).toLowerCase();
  if (MARKDOWN_EXT.has(ext)) return "markdown";
  if (IMAGE_EXT.has(ext)) return "image";
  return null;
}

/** Unique file paths, first occurrence kept. Directories and empties drop out. */
export function uniqueFileArtifacts(...paths: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of paths) {
    if (!isFileArtifact(path) || path === undefined) continue;
    const trimmed = path.trim();
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/** File `artifactPath`s claimed by the graph, in node order. */
export function claimedArtifactPaths(
  nodes: readonly { data: { artifactPath?: string } }[],
): string[] {
  return uniqueFileArtifacts(...nodes.map((node) => node.data.artifactPath));
}

/**
 * File-looking paths in a Memory artifact entry. URLs stay as prose: they are
 * endpoints, not something Finder or Diff can open.
 */
export function claimedPathsFromMemory(content: string): string[] {
  const trimmed = stripWrappingTicks(content.trim());
  if (looksLikeClaimedPath(trimmed)) return [trimmed];

  const found: string[] = [];
  const rest = trimmed.replace(/`([^`]+)`/g, (_all, inner: string) => {
    found.push(inner);
    return " ";
  });
  for (const token of rest.split(/[\s,;]+/)) {
    found.push(stripWrappingTicks(token));
  }
  return uniqueFileArtifacts(...found.filter(looksLikeClaimedPath));
}

function stripWrappingTicks(token: string): string {
  const trimmed = token.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("`") && trimmed.endsWith("`")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function looksLikeClaimedPath(token: string): boolean {
  if (/\s/.test(token)) return false;
  if (!isFileArtifact(token)) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(token)) return false;
  return token.includes("/") || /\.[A-Za-z0-9]{1,8}$/.test(token);
}

/** Switches to the Diff tab and opens the path in this session's worktree. */
export async function openArtifactInDiff(
  projectId: string,
  sessionId: string | null,
  path: string,
): Promise<void> {
  if (!isFileArtifact(path)) return;
  useUiStore.getState().setTab("diff");
  await useDiffStore.getState().openPath(projectId, sessionId ?? "", path);
}

/** Reveals a confined project (or worktree) path in the OS file manager. */
export async function openArtifactInFinder(
  projectId: string,
  sessionId: string | null,
  path: string,
): Promise<void> {
  if (!isFileArtifact(path)) return;
  await api.revealArtifact(projectId, path, sessionId);
}
