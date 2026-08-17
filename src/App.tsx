import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";

import CommandPalette from "./components/CommandPalette";
import SettingsPanel from "./components/SettingsPanel";
import EmptyState from "./components/EmptyState";
import ProjectSidebar from "./components/ProjectSidebar";
import TitleBar from "./components/TitleBar";
import WorkspaceShell from "./components/WorkspaceShell";
import { useGraphStore } from "./stores/graphStore";
import { useActiveProject, useProjectStore } from "./stores/projectStore";
import { useMemoryStore } from "./stores/memoryStore";
import { useSessionStore } from "./stores/sessionStore";
import { useTaskStore } from "./stores/taskStore";
import { useSettingsStore } from "./stores/settingsStore";
import { useUiStore } from "./stores/uiStore";
import { shortcutFor } from "./lib/shortcuts";
import type { SessionStatus } from "./types";

interface SessionExited {
  id: string;
  exitCode: number | null;
}

/** The backend also reports `path` and `removed`; the re-read covers both. */
interface GraphChanged {
  sessionId: string;
}

interface SessionStatusChanged {
  id: string;
  status: SessionStatus;
}

interface PermissionAsked {
  id: string;
  requestId: number;
  summary: string;
}

export default function App() {
  const activeProject = useActiveProject();
  const projectError = useProjectStore((state) => state.error);
  const sessionError = useSessionStore((state) => state.error);
  const taskError = useTaskStore((state) => state.error);
  const memoryError = useMemoryStore((state) => state.error);
  const settingsError = useSettingsStore((state) => state.error);
  const clearProjectError = useProjectStore((state) => state.clearError);
  const clearSessionError = useSessionStore((state) => state.clearError);
  const clearTaskError = useTaskStore((state) => state.clearError);
  const clearMemoryError = useMemoryStore((state) => state.clearError);
  const clearSettingsError = useSettingsStore((state) => state.clearError);
  const loadProjects = useProjectStore((state) => state.loadProjects);
  const pickAndOpenProject = useProjectStore((state) => state.pickAndOpenProject);
  const togglePalette = useUiStore((state) => state.togglePalette);

  // Every store that can fail has to be named here or its errors are written to a
  // field nothing reads. One banner, so a failure cannot arrive twice.
  const error = projectError ?? sessionError ?? taskError ?? memoryError ?? settingsError;

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    // The opening tab is applied once, here, rather than by the settings store on
    // every load: changing the preference should take effect next launch, not yank
    // you to another panel while you are reading this one.
    void useSettingsStore
      .getState()
      .loadSettings()
      .then((settings) => useUiStore.getState().setTab(settings.openingTab));
  }, []);

  useEffect(() => {
    // One listener for every shortcut, which is what lib/shortcuts.ts exists for.
    //
    // Registered in the capture phase on purpose: a focused terminal hands every
    // keystroke to xterm, and xterm's own handler sits on its textarea. Capturing
    // means this runs first and preventDefault stops the terminal seeing it, so
    // Cmd+K opens the palette instead of being swallowed by whatever the shell
    // thinks Cmd+K means.
    const onKeyDown = (event: KeyboardEvent) => {
      const shortcut = shortcutFor(event);
      if (shortcut === undefined) return;
      event.preventDefault();
      if (shortcut === "open-project") void pickAndOpenProject();
      if (shortcut === "command-palette") togglePalette();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [pickAndOpenProject, togglePalette]);

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
    // Only agents report these: a terminal cannot say what the process inside it
    // is doing. The backend has already written the status to the database, so this
    // is the live path rather than the only one.
    const unlisten = listen<SessionStatusChanged>("session-status", (event) => {
      useSessionStore.getState().markStatus(event.payload.id, event.payload.status);
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);

  useEffect(() => {
    // An agent blocked on a permission does nothing until it is answered, which is
    // why this is an event rather than something to be polled for.
    const unlisten = listen<PermissionAsked>("session-permission", (event) => {
      const { id, requestId, summary } = event.payload;
      useSessionStore.getState().askPermission(id, { requestId, summary });
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

      <CommandPalette />
      <SettingsPanel />

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
              clearMemoryError();
              clearSettingsError();
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
