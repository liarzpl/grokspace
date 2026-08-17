import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";

import EmptyState from "./components/EmptyState";
import ProjectSidebar from "./components/ProjectSidebar";
import TitleBar from "./components/TitleBar";
import WorkspaceShell from "./components/WorkspaceShell";
import { useGraphStore } from "./stores/graphStore";
import { useActiveProject, useProjectStore } from "./stores/projectStore";
import { useSessionStore } from "./stores/sessionStore";
import { useTaskStore } from "./stores/taskStore";

interface SessionExited {
  id: string;
  exitCode: number | null;
}

/** The backend also reports `path` and `removed`; the re-read covers both. */
interface GraphChanged {
  sessionId: string;
}

export default function App() {
  const activeProject = useActiveProject();
  const projectError = useProjectStore((state) => state.error);
  const sessionError = useSessionStore((state) => state.error);
  const taskError = useTaskStore((state) => state.error);
  const clearProjectError = useProjectStore((state) => state.clearError);
  const clearSessionError = useSessionStore((state) => state.clearError);
  const clearTaskError = useTaskStore((state) => state.clearError);
  const loadProjects = useProjectStore((state) => state.loadProjects);
  const pickAndOpenProject = useProjectStore((state) => state.pickAndOpenProject);

  // Every store that can fail has to be named here or its errors are written to a
  // field nothing reads. One banner, so a failure cannot arrive twice.
  const error = projectError ?? sessionError ?? taskError;

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "o") {
        event.preventDefault();
        void pickAndOpenProject();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pickAndOpenProject]);

  useEffect(() => {
    // Terminal output streams over a channel; exits are infrequent enough to
    // belong on the event system.
    const unlisten = listen<SessionExited>("session-exited", (event) => {
      useSessionStore.getState().markExited(event.payload.id, event.payload.exitCode);
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);

  useEffect(() => {
    // Graph files are watched by the backend; the event says which session's file
    // moved and the store re-reads it. A removal is refreshed rather than dropped:
    // the pane is still there, and the re-read is what reports the file as gone.
    // Whether the session is still open is answered here, since the watch outlives
    // the sessions it was started for.
    const unlisten = listen<GraphChanged>("graph-changed", (event) => {
      const { sessionId } = event.payload;
      const isOpen = useSessionStore
        .getState()
        .sessions.some((session) => session.id === sessionId);
      useGraphStore.getState().refresh(sessionId, isOpen);
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);

  return (
    <div className="flex h-full flex-col bg-canvas text-ink">
      <TitleBar />

      <div className="flex min-h-0 flex-1">
        <ProjectSidebar />
        <main className="flex min-w-0 flex-1 flex-col">
          {activeProject ? <WorkspaceShell project={activeProject} /> : <EmptyState />}
        </main>
      </div>

      {error && (
        <div
          role="alert"
          className="flex shrink-0 items-center gap-3 border-t border-danger/40 bg-danger/10 px-4 py-2"
        >
          <span className="flex-1 text-[12px] text-danger selectable">{error}</span>
          <button
            type="button"
            onClick={() => {
              clearProjectError();
              clearSessionError();
              clearTaskError();
            }}
            className="rounded-sm px-2 py-0.5 text-[11px] text-ink-muted hover:text-ink"
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}
