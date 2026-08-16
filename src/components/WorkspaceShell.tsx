import { useEffect } from "react";

import { homeRelative } from "../lib/paths";
import { useSessionStore } from "../stores/sessionStore";
import type { Project } from "../types";
import PaneGrid, { LayoutPicker } from "./PaneGrid";

export default function WorkspaceShell({ project }: { project: Project }) {
  const loadSessions = useSessionStore((state) => state.loadSessions);

  useEffect(() => {
    void loadSessions(project.id);
  }, [project.id, loadSessions]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-2">
        <h1 className="shrink-0 text-[14px] font-semibold tracking-tight">{project.name}</h1>
        <span
          title={project.path}
          className="min-w-0 truncate font-mono text-[11px] text-ink-faint"
        >
          {homeRelative(project.path)}
        </span>
        <div className="flex-1" />
        <LayoutPicker project={project} />
      </header>

      <PaneGrid project={project} />
    </div>
  );
}
