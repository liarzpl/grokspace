import { homeRelative } from "../lib/paths";
import type { Project } from "../types";

/** Placeholder for a capability that a later phase fills in. */
function UpcomingPane({ phase, title, description }: { phase: string; title: string; description: string }) {
  return (
    <section className="flex flex-1 flex-col rounded-lg border border-dashed border-line-strong bg-panel/60 p-5">
      <span className="text-[10px] font-semibold tracking-wider text-ink-faint uppercase">
        {phase}
      </span>
      <h3 className="mt-1.5 text-[14px] font-medium">{title}</h3>
      <p className="mt-1.5 max-w-prose text-[12px] leading-relaxed text-ink-muted">{description}</p>
    </section>
  );
}

export default function WorkspaceShell({ project }: { project: Project }) {
  const opened = project.lastOpened ?? project.createdAt;

  return (
    <div className="flex flex-1 flex-col overflow-y-auto p-5">
      <div className="flex items-baseline gap-3">
        <h1 className="text-[17px] font-semibold tracking-tight">{project.name}</h1>
        <span title={project.path} className="truncate font-mono text-[11px] text-ink-faint">
          {homeRelative(project.path)}
        </span>
      </div>
      <p className="mt-1 text-[12px] text-ink-muted">
        Last opened {new Date(opened).toLocaleString()}
      </p>

      <div className="mt-5 flex flex-1 flex-col gap-3">
        <UpcomingPane
          phase="Phase 1"
          title="Terminal grid"
          description="Independent Grok Build sessions in a resizable pane grid, each running the real interactive TUI over a PTY."
        />
        <UpcomingPane
          phase="Phase 2"
          title="Kanban board"
          description="Backlog through Done, with drag-to-dispatch that hands a task to a free terminal or spawns a new session for it."
        />
      </div>
    </div>
  );
}
