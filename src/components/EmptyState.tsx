import { useProjectStore } from "../stores/projectStore";

export default function EmptyState() {
  const pickAndOpenProject = useProjectStore((state) => state.pickAndOpenProject);
  const isOpening = useProjectStore((state) => state.isOpening);

  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="max-w-sm text-center">
        <h1 className="text-[17px] font-semibold tracking-tight">No project open</h1>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-muted">
          Open a folder to make it a GrokSpace project. Everything stays on this machine, in
          <span className="font-mono text-ink-faint"> ~/.grokspace</span>.
        </p>

        <button
          type="button"
          onClick={() => void pickAndOpenProject()}
          disabled={isOpening}
          className="mt-5 rounded-md bg-accent px-3.5 py-2 text-[13px] font-medium text-canvas transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {isOpening ? "Opening…" : "Open Project…"}
        </button>

        <p className="mt-3 text-[11px] text-ink-faint">
          or press <kbd className="font-mono">⌘O</kbd>
        </p>
      </div>
    </div>
  );
}
