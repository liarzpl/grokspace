import ArtifactPathList from "./ArtifactPathList";
import { isFileArtifact, uniqueFileArtifacts } from "../../lib/graphArtifact";
import type { GraphNode } from "../../lib/graph";
import { QuietButton } from "../ui";
import { STATUS_META } from "./GraphNode";

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-[10px] font-semibold tracking-wider text-ink-faint uppercase">{label}</dt>
      <dd
        className={`mt-0.5 text-[12px] leading-relaxed break-words text-ink-muted selectable ${
          mono ? "font-mono text-[11px]" : ""
        }`}
      >
        {value}
      </dd>
    </div>
  );
}

export default function NodeInspector({
  node,
  onClose,
  onOpenArtifact,
  onRevealArtifact,
  claimedPaths = [],
  compact = false,
  onFork,
}: {
  node: GraphNode;
  onClose: () => void;
  /** Opens a file artifact in the Diff panel. Directories are left as labels. */
  onOpenArtifact?: (path: string) => void;
  /** Reveals a file in the OS file manager. */
  onRevealArtifact?: (path: string) => void;
  /** Other file paths this graph has claimed, listed with this node's. */
  claimedPaths?: string[];
  /** Fills a floating container instead of claiming a column of its own. */
  compact?: boolean;
  /** Starts a new isolated session from this node. Parent stays as it is. */
  onFork?: () => void;
}) {
  const status = STATUS_META[node.status] ?? STATUS_META.pending;
  const artifactPath = node.data.artifactPath;
  const files = uniqueFileArtifacts(artifactPath, ...claimedPaths);
  const directoryLabel =
    artifactPath !== undefined && !isFileArtifact(artifactPath) ? artifactPath : undefined;

  return (
    <aside
      className={`flex flex-col overflow-y-auto border-l border-line bg-panel ${
        compact ? "w-full" : "w-68 shrink-0"
      }`}
    >
      <header className="flex items-start gap-2 border-b border-line px-3 py-2.5">
        <span aria-hidden="true" className={`mt-1.5 size-1.5 shrink-0 rounded-full ${status.dot}`} />
        <div className="min-w-0 flex-1">
          <h3 className="text-[13px] font-semibold tracking-tight break-words">{node.label}</h3>
          <p className="mt-0.5 font-mono text-[10px] text-ink-faint">
            {node.type} · {status.label.toLowerCase()}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close details"
          className="shrink-0 rounded-sm px-1 text-ink-faint hover:text-ink"
        >
          ×
        </button>
      </header>

      <dl className="flex flex-col gap-3 px-3 py-3">
        {node.data.description !== undefined && (
          <Field label="Description" value={node.data.description} />
        )}
        {node.role !== undefined && <Field label="Role" value={node.role} />}
        {node.data.model !== undefined && <Field label="Model" value={node.data.model} mono />}
        {node.data.effort !== undefined && <Field label="Effort" value={node.data.effort} />}
        {node.data.parallelism !== undefined && (
          <Field label="Parallelism" value={String(node.data.parallelism)} />
        )}
        {node.data.worktree !== undefined && (
          <Field label="Worktree" value={node.data.worktree ? "yes" : "no"} />
        )}
        {directoryLabel !== undefined && <Field label="Artifact" value={directoryLabel} mono />}
        {files.length > 0 && (
          <dd>
            <ArtifactPathList
              paths={files}
              onOpenDiff={onOpenArtifact}
              onReveal={onRevealArtifact}
            />
          </dd>
        )}
        <Field label="Node id" value={node.id} mono />
      </dl>
      {onFork !== undefined && (
        <div className="mt-auto border-t border-line px-3 py-2.5">
          <QuietButton
            label="Fork from here"
            title="New session and worktree at project HEAD. Parent is unchanged."
            onClick={onFork}
          />
        </div>
      )}
    </aside>
  );
}
