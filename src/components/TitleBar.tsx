import { getCurrentWindow } from "@tauri-apps/api/window";

import { beginWindowDrag } from "../lib/windowDrag";
import { useActiveProject } from "../stores/projectStore";
import { homeRelative } from "../lib/paths";

/**
 * The window uses `titleBarStyle: "Overlay"` with a hidden title, so the traffic
 * lights float over this bar and the left padding reserves room for them.
 *
 * Dragging is started from here rather than relying only on Tauri's injected
 * listener: that listener requires the click target itself to be marked, and
 * `startDragging` is denied unless the capability allows it.
 */
export default function TitleBar() {
  const project = useActiveProject();

  return (
    <header
      data-tauri-drag-region
      onMouseDown={(event) =>
        beginWindowDrag(event, () => getCurrentWindow().startDragging())
      }
      className="flex h-11 shrink-0 items-center gap-3 border-b border-line bg-panel pr-3 pl-20"
    >
      <div data-tauri-drag-region className="flex min-w-0 items-baseline gap-2">
        <span data-tauri-drag-region className="text-[13px] font-semibold tracking-tight">
          GrokSpace
        </span>
        {project && (
          <>
            <span data-tauri-drag-region className="text-ink-faint">
              /
            </span>
            <span data-tauri-drag-region className="truncate text-[13px] text-ink-muted">
              {project.name}
            </span>
          </>
        )}
      </div>

      <div data-tauri-drag-region className="flex-1" />

      {project && (
        <span
          data-tauri-drag-region
          title={project.path}
          className="max-w-[42ch] truncate font-mono text-[11px] text-ink-faint"
        >
          {homeRelative(project.path)}
        </span>
      )}
    </header>
  );
}
