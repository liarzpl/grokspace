import { layoutOf, useProjectStore } from "../stores/projectStore";
import { sessionForPane, useSessionStore } from "../stores/sessionStore";
import { PANE_LAYOUTS, paneCount, type PaneLayout, type Project } from "../types";
import TerminalPane from "./TerminalPane";

/** Spelled out so Tailwind can see the class names in the source. */
const GRID_CLASS: Record<PaneLayout, string> = {
  "1x1": "grid-cols-1 grid-rows-1",
  "2x1": "grid-cols-2 grid-rows-1",
  "2x2": "grid-cols-2 grid-rows-2",
  "3x2": "grid-cols-3 grid-rows-2",
};

export function LayoutPicker({ project }: { project: Project }) {
  const active = layoutOf(project);
  const setLayout = useProjectStore((state) => state.setLayout);

  return (
    <div className="flex items-center gap-0.5 rounded-md border border-line p-0.5">
      {PANE_LAYOUTS.map((layout) => (
        <button
          key={layout}
          type="button"
          onClick={() => void setLayout(project.id, layout)}
          title={`${paneCount(layout)} panes`}
          className={`rounded-sm px-1.5 py-0.5 font-mono text-[10px] transition-colors ${
            layout === active
              ? "bg-accent-soft text-ink"
              : "text-ink-faint hover:bg-elevated hover:text-ink-muted"
          }`}
        >
          {layout}
        </button>
      ))}
    </div>
  );
}

export default function PaneGrid({ project }: { project: Project }) {
  const layout = layoutOf(project);
  const sessions = useSessionStore((state) => state.sessions);
  const maximizedPane = useSessionStore((state) => state.maximizedPane);

  const panes = Array.from({ length: paneCount(layout) }, (_, index) => String(index));
  const isMaximized = maximizedPane !== null && panes.includes(maximizedPane);
  const visible = isMaximized ? [maximizedPane] : panes;

  // Shrinking the layout does not stop the sessions it covers up, so say so
  // rather than letting them look as though they vanished.
  const hidden = sessions.filter(
    (session) => session.paneId !== null && !panes.includes(session.paneId),
  ).length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className={`grid min-h-0 flex-1 gap-2 p-2 ${
          isMaximized ? "grid-cols-1 grid-rows-1" : GRID_CLASS[layout]
        }`}
      >
        {visible.map((paneId) => (
          <TerminalPane
            key={paneId}
            paneId={paneId}
            projectId={project.id}
            session={sessionForPane(sessions, paneId)}
          />
        ))}
      </div>

      {hidden > 0 && (
        <p className="shrink-0 px-3 pb-2 text-[11px] text-ink-faint">
          {hidden} session{hidden === 1 ? "" : "s"} still running in panes this layout hides.
        </p>
      )}
    </div>
  );
}
