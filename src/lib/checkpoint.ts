/**
 * Named checkpoint copy for a worktree. The checkpoint is git HEAD of that
 * tree — Discard reverts it. There is no shadow-git and no second snapshot.
 */

/** Visible on Diff when a worktree is scoped; Close chrome when a tree exists. */
export const CHECKPOINT_EQUALS_HEAD = "Checkpoint = this worktree's HEAD";

/** Tooltip on Discard. Force-remove is revert, not a Cline-style undo stack. */
export const DISCARD_REVERTS_CHECKPOINT = "Discard reverts this checkpoint";
