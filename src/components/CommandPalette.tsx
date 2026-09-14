import { useEffect, useMemo, useRef, useState } from "react";

import { commands, matching } from "../lib/commands";
import { optionDomId, subscribeOverlay } from "../lib/overlay";
import { shortcutLabel } from "../lib/shortcuts";
import { useActiveProject } from "../stores/projectStore";
import { useSkillStore } from "../stores/skillStore";
import { useUiStore } from "../stores/uiStore";

/**
 * The app's first overlay.
 *
 * Escape, arrows, Enter, and click-away are the same as before; Tab and a
 * screen reader now see a modal combobox rather than a div sitting on the
 * workspace. Result rows stay out of the tab order so focus never leaves the
 * search field — that is what used to make Escape stop working.
 */
export default function CommandPalette() {
  const isOpen = useUiStore((state) => state.isPaletteOpen);
  const closePalette = useUiStore((state) => state.closePalette);
  const project = useActiveProject();
  const skillById = useSkillStore((state) => state.byId);
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Rebuilt per open, not memoised across them: which projects exist and which panes
  // are free both change, and a stale list would offer a project that has been
  // forgotten. Skill slots are in the deps so installed vs missing updates after
  // a refresh without closing.
  const all = useMemo(
    () => (isOpen ? commands(project) : []),
    [isOpen, project, skillById],
  );
  const shown = useMemo(() => matching(all, query), [all, query]);

  // A query that narrows the list can leave the cursor past its end.
  const selected = Math.min(at, Math.max(shown.length - 1, 0));
  const active = shown[selected];

  useEffect(() => {
    if (!isOpen) {
      setQuery("");
      setAt(0);
      return;
    }
    if (project === null) return;
    void useSkillStore.getState().refreshAll();
  }, [isOpen, project]);

  // Keeps the highlighted row visible when the arrows walk past the fold.
  useEffect(() => {
    listRef.current?.children[selected]?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  useEffect(() => {
    if (!isOpen) return;
    return subscribeOverlay(true, dialogRef.current, closePalette);
  }, [isOpen, closePalette]);

  if (!isOpen) return null;

  const run = () => {
    if (active === undefined) return;
    // The command closes the palette itself. Which sounds like a detail and is not:
    // several of them open something, and closing here as well would fight whatever
    // they just opened.
    active.run();
  };

  return (
    <div
      // Clicking the backdrop closes; the panel below stops the click reaching here.
      onMouseDown={closePalette}
      className="fixed inset-0 z-50 flex items-start justify-center bg-canvas/70 pt-[12vh]"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(event) => event.stopPropagation()}
        className="flex max-h-[60vh] w-[32rem] flex-col overflow-hidden rounded-lg border border-line-strong bg-panel shadow-2xl shadow-black/60"
      >
        <input
          autoFocus
          role="combobox"
          aria-label="Filter commands"
          aria-expanded="true"
          aria-controls="command-palette-results"
          aria-autocomplete="list"
          aria-activedescendant={
            active === undefined ? undefined : optionDomId("cmd", active.id)
          }
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setAt(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              run();
            }
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setAt(Math.min(selected + 1, shown.length - 1));
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setAt(Math.max(selected - 1, 0));
            }
          }}
          placeholder="What would you like to do?"
          className="selectable shrink-0 border-b border-line bg-transparent px-3 py-2.5 text-[13px] text-ink placeholder:text-ink-faint focus:border-accent"
        />

        <div
          ref={listRef}
          id="command-palette-results"
          role={shown.length === 0 ? undefined : "listbox"}
          aria-label={shown.length === 0 ? undefined : "Commands"}
          className="min-h-0 flex-1 overflow-y-auto p-1"
        >
          {shown.length === 0 ? (
            <p role="status" className="px-2 py-3 text-[11px] text-ink-faint">
              Nothing matches that.
            </p>
          ) : (
            shown.map((command, index) => (
              <button
                key={command.id}
                id={optionDomId("cmd", command.id)}
                type="button"
                role="option"
                aria-selected={index === selected}
                tabIndex={-1}
                // Mouse down rather than click, so the run happens before the input
                // loses focus and takes the palette with it.
                onMouseDown={(event) => {
                  event.preventDefault();
                  setAt(index);
                  command.run();
                }}
                onMouseEnter={() => setAt(index)}
                className={`flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${
                  index === selected ? "bg-accent-soft" : ""
                }`}
              >
                <span
                  className={`flex-1 truncate text-[12px] ${
                    index === selected ? "text-ink" : "text-ink-muted"
                  }`}
                >
                  {command.label}
                </span>
                <span className="shrink-0 text-[10px] text-ink-faint">{command.group}</span>
                {command.shortcut !== undefined && (
                  <span className="shrink-0 font-mono text-[10px] text-ink-faint">
                    {shortcutLabel(command.shortcut)}
                  </span>
                )}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
