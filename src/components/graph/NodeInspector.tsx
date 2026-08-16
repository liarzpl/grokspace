import type { GraphNode } from "../../lib/graph";
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
  compact = false,
}: {
  node: GraphNode;
  onClose: () => void;
  /** Fills a floating container instead of claiming a column of its own. */
  compact?: boolean;
}) {
  const status = STATUS_META[node.status];

  return (
    <aside
      className={`flex flex-col overflow-y-auto border-l border-line bg-panel ${
        compact ? "w-full" : "w-68 shrink-0"
      }`}
    >
      <header className="flex items-start gap-2 border-b border-line px-3 py-2.5">
        <span className={`mt-1.5 size-1.5 shrink-0 rounded-full ${status.dot}`} />
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
        {node.data.artifactPath !== undefined && (
          <Field label="Artifact" value={node.data.artifactPath} mono />
        )}
        <Field label="Node id" value={node.id} mono />
      </dl>
    </aside>
  );
}
