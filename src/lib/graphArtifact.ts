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

/** Switches to the Diff tab and opens the path in this session's worktree. */
export async function openArtifactInDiff(
  projectId: string,
  sessionId: string,
  path: string,
): Promise<void> {
  if (!isFileArtifact(path)) return;
  useUiStore.getState().setTab("diff");
  await useDiffStore.getState().openPath(projectId, sessionId, path);
}
