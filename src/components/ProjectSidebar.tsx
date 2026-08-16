import { useState } from "react";

import { homeRelative } from "../lib/paths";
import { useProjectStore } from "../stores/projectStore";
import type { Project } from "../types";

export default function ProjectSidebar() {
  const projects = useProjectStore((state) => state.projects);
  const activeProjectId = useProjectStore((state) => state.activeProjectId);
  const isLoading = useProjectStore((state) => state.isLoading);
  const isOpening = useProjectStore((state) => state.isOpening);
  const pickAndOpenProject = useProjectStore((state) => state.pickAndOpenProject);
  const selectProject = useProjectStore((state) => state.selectProject);
  const renameProject = useProjectStore((state) => state.renameProject);
  const forgetProject = useProjectStore((state) => state.forgetProject);

  const [editingId, setEditingId] = useState<string | null>(null);

  const commitRename = (project: Project, value: string) => {
    setEditingId(null);
    const name = value.trim();
    if (name && name !== project.name) void renameProject(project.id, name);
  };

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-panel">
      <div className="flex items-center justify-between px-3 py-2.5">
        <h2 className="text-[11px] font-semibold tracking-wider text-ink-faint uppercase">
          Projects
        </h2>
        <button
          type="button"
          onClick={() => void pickAndOpenProject()}
          disabled={isOpening}
          title="Open a project folder (⌘O)"
          className="rounded-md border border-line-strong px-2 py-1 text-[11px] text-ink-muted transition-colors hover:border-accent hover:text-ink disabled:opacity-50"
        >
          {isOpening ? "Opening…" : "Open…"}
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 pb-2">
        {isLoading && projects.length === 0 && (
          <p className="px-2 py-3 text-[12px] text-ink-faint">Loading…</p>
        )}

        {!isLoading && projects.length === 0 && (
          <p className="px-2 py-3 text-[12px] leading-relaxed text-ink-faint">
            No projects yet. Open a folder to add one.
          </p>
        )}

        <ul className="flex flex-col gap-0.5">
          {projects.map((project) => {
            const isActive = project.id === activeProjectId;
            return (
              <li key={project.id} className="group relative">
                <button
                  type="button"
                  onClick={() => void selectProject(project.id)}
                  onDoubleClick={() => setEditingId(project.id)}
                  className={`w-full rounded-md px-2 py-1.5 text-left transition-colors ${
                    isActive
                      ? "bg-accent-soft text-ink"
                      : "text-ink-muted hover:bg-elevated hover:text-ink"
                  }`}
                >
                  {editingId === project.id ? (
                    <input
                      autoFocus
                      defaultValue={project.name}
                      onBlur={(event) => commitRename(project, event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.currentTarget.blur();
                        if (event.key === "Escape") setEditingId(null);
                      }}
                      onClick={(event) => event.stopPropagation()}
                      className="w-full rounded-sm border border-accent bg-canvas px-1 py-0.5 text-[13px] text-ink outline-none selectable"
                    />
                  ) : (
                    <span className="block truncate text-[13px] font-medium">{project.name}</span>
                  )}
                  <span
                    title={project.path}
                    className="mt-0.5 block truncate pr-5 font-mono text-[10px] text-ink-faint"
                  >
                    {homeRelative(project.path)}
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => void forgetProject(project.id)}
                  title="Remove from GrokSpace (the folder is left untouched)"
                  aria-label={`Remove ${project.name} from GrokSpace`}
                  className="absolute top-1.5 right-1.5 hidden size-5 items-center justify-center rounded-sm text-ink-faint hover:bg-line-strong hover:text-danger group-hover:flex"
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      <footer className="border-t border-line px-3 py-2">
        <p className="font-mono text-[10px] text-ink-faint">~/.grokspace/grokspace.db</p>
      </footer>
    </aside>
  );
}
