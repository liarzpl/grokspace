import { lazy, Suspense, useEffect } from "react";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";

import CommandPalette from "./components/CommandPalette";
import ErrorBoundary from "./components/ErrorBoundary";
import IsolationConfirm from "./components/IsolationConfirm";
import SettingsPanel from "./components/SettingsPanel";
import EmptyState from "./components/EmptyState";
import ProjectSidebar from "./components/ProjectSidebar";
import TitleBar from "./components/TitleBar";
import { useGraphStore } from "./stores/graphStore";
import { useActiveProject, useProjectStore } from "./stores/projectStore";
import { useMemoryStore } from "./stores/memoryStore";
import { useSessionStore } from "./stores/sessionStore";
import { useStepStore } from "./stores/stepStore";
import { useTaskStore } from "./stores/taskStore";
import { useDiffStore } from "./stores/diffStore";
import { firstSkillError, useSkillStore } from "./stores/skillStore";
import { useSettingsStore } from "./stores/settingsStore";
import { useUiStore } from "./stores/uiStore";
import {
  answerInboxPermission,
  openInboxSession,
  showInboxGraph,
} from "./lib/commands";
import { createDockTracker, type DockNative } from "./lib/dockAttention";
import { hydrateInboxSnooze } from "./lib/inboxSnooze";
import { listenBackendEvents } from "./lib/events";
import { listenLogged, logClientError } from "./lib/log";
import { runGlobalShortcut, runInboxShortcut, shortcutFor } from "./lib/shortcuts";

const WorkspaceShell = lazy(() => import("./components/WorkspaceShell"));

const dockAttention = createDockTracker();

function dockNative(): DockNative {
  const current = getCurrentWindow();
  return {
    setBadgeCount: (count) => {
      void current.setBadgeCount(count);
    },
    requestUserAttention: () => {
      void current.requestUserAttention(UserAttentionType.Informational);
    },
  };
}

export default function App() {
  const activeProject = useActiveProject();
  const projectError = useProjectStore((state) => state.error);
  const sessionError = useSessionStore((state) => state.error);
  const taskError = useTaskStore((state) => state.error);
  const memoryError = useMemoryStore((state) => state.error);
  const graphError = useGraphStore((state) => state.error);
  const stepError = useStepStore((state) => state.error);
  const settingsError = useSettingsStore((state) => state.error);
  const diffError = useDiffStore((state) => state.error);
  const skillError = useSkillStore((state) => firstSkillError(state.byId));
  const clearProjectError = useProjectStore((state) => state.clearError);
  const clearSessionError = useSessionStore((state) => state.clearError);
  const clearTaskError = useTaskStore((state) => state.clearError);
  const clearMemoryError = useMemoryStore((state) => state.clearError);
  const clearGraphError = useGraphStore((state) => state.clearError);
  const clearStepError = useStepStore((state) => state.clearError);
  const clearSettingsError = useSettingsStore((state) => state.clearError);
  const clearDiffError = useDiffStore((state) => state.clearError);
  const clearSkillError = useSkillStore((state) => state.clearError);
  const loadProjects = useProjectStore((state) => state.loadProjects);
  const pickAndOpenProject = useProjectStore((state) => state.pickAndOpenProject);
  const togglePalette = useUiStore((state) => state.togglePalette);
  const closePalette = useUiStore((state) => state.closePalette);

  // Every store that can fail has to be named here or its errors are written to a
  // field nothing reads. One banner, so a failure cannot arrive twice.
  const error =
    projectError ??
    sessionError ??
    taskError ??
    memoryError ??
    graphError ??
    stepError ??
    settingsError ??
    diffError ??
    skillError;

  useEffect(() => {
    if (error) logClientError("banner", error);
  }, [error]);

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
      .then((settings) => {
        useUiStore.getState().applyOpeningTab(settings.openingTab);
      });
    void hydrateInboxSnooze();
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
      if (shortcut !== undefined) {
        event.preventDefault();
        runGlobalShortcut(shortcut, {
          closePalette,
          togglePalette,
          openProject: () => void pickAndOpenProject(),
        });
        return;
      }
      // Inbox keys are not global: a focused xterm keeps A/D/O/G for grok.
      runInboxShortcut(event, {
        allowOnce: (sessionId) => answerInboxPermission(sessionId, true),
        deny: (sessionId) => answerInboxPermission(sessionId, false),
        openPane: (sessionId) => {
          const projectId = useProjectStore.getState().activeProjectId;
          if (projectId === null) return;
          openInboxSession(projectId, sessionId);
        },
        showGraph: showInboxGraph,
      });
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [closePalette, pickAndOpenProject, togglePalette]);

  useEffect(() => {
    // Badge follows the session list; bounce is a transition, handled on the
    // status and permission events. Focus only changes whether the badge is
    // shown — the card already has Allow/Deny when this window is in front.
    const current = getCurrentWindow();
    const native = dockNative();
    const unsubscribe = useSessionStore.subscribe((state) => {
      dockAttention.apply(state.sessions, native);
    });
    const unlisten = current.onFocusChanged(({ payload: focused }) => {
      dockAttention.setFocused(focused, useSessionStore.getState().sessions, native);
    });
    void current.isFocused().then((focused) => {
      dockAttention.setFocused(focused, useSessionStore.getState().sessions, native);
    });
    return () => {
      unsubscribe();
      void unlisten.then((stop) => stop());
    };
  }, []);

  useEffect(() => {
    // Terminal output streams over a channel; these eight events are infrequent
    // enough to belong on the event system. Names and payloads live in events.ts.
    const unlisten = listenBackendEvents(listenLogged, {
      markExited: (id, exitCode) => useSessionStore.getState().markExited(id, exitCode),
      markStatus: (id, status) => useSessionStore.getState().markStatus(id, status),
      askPermission: (id, request) => useSessionStore.getState().askPermission(id, request),
      noteIsolation: (id, reason) => useSessionStore.getState().noteIsolation(id, reason),
      appendUpdate: (id, update) => useSessionStore.getState().appendUpdate(id, update),
      sessions: () => useSessionStore.getState().sessions,
      refreshGraph: (sessionId, isOpen) => useGraphStore.getState().refresh(sessionId, isOpen),
      refreshSteps: (sessionId, isOpen) => useStepStore.getState().refresh(sessionId, isOpen),
      activeProjectId: () => useProjectStore.getState().activeProjectId,
      loadTasks: (projectId) => {
        void useTaskStore.getState().loadTasks(projectId);
      },
      noteDock: (id, status) => {
        dockAttention.note(id, status, useSessionStore.getState().sessions, dockNative());
      },
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
          <ErrorBoundary>
            {activeProject ? (
              <Suspense fallback={<div className="min-h-0 flex-1" />}>
                <WorkspaceShell project={activeProject} />
              </Suspense>
            ) : (
              <EmptyState />
            )}
          </ErrorBoundary>
        </main>
      </div>

      <CommandPalette />
      <SettingsPanel />
      <IsolationConfirm />

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
              clearGraphError();
              clearStepError();
              clearSettingsError();
              clearDiffError();
              clearSkillError();
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
