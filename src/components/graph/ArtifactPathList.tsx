import { useState } from "react";

import { artifactPreviewKind } from "../../lib/graphArtifact";
import { QuietButton } from "../ui";

export function ArtifactPreview({
  path,
  text,
  imageSrc,
}: {
  path: string;
  text?: string;
  imageSrc?: string;
}) {
  const kind = artifactPreviewKind(path);
  if (kind === "markdown") {
    if (text === undefined) {
      return (
        <p data-testid="artifact-preview-markdown" className="mt-1 text-[11px] text-ink-faint">
          Markdown — open in Diff to view.
        </p>
      );
    }
    return (
      <pre
        data-testid="artifact-preview-markdown"
        className="selectable mt-1 max-h-36 overflow-auto whitespace-pre-wrap rounded-sm bg-canvas px-1.5 py-1 font-mono text-[11px] leading-snug text-ink-muted"
      >
        {text}
      </pre>
    );
  }
  if (kind === "image") {
    if (imageSrc !== undefined && imageSrc.startsWith("data:image/")) {
      return <img data-testid="artifact-preview-image" src={imageSrc} alt="" className="mt-1 max-h-32 max-w-full" />;
    }
    return (
      <p data-testid="artifact-preview-image" className="mt-1 text-[11px] text-ink-faint">
        Image — open in Diff to view.
      </p>
    );
  }
  return (
    <p data-testid="artifact-preview-none" className="mt-1 text-[11px] text-ink-faint">
      No preview for this file type.
    </p>
  );
}

/** Claimed file paths with Finder / Diff. Markdown is text; HTML is never interpreted. */
export default function ArtifactPathList({
  paths,
  onOpenDiff,
  onReveal,
  previewText,
  previewImageSrc,
}: {
  paths: string[];
  onOpenDiff?: (path: string) => void;
  onReveal?: (path: string) => void;
  previewText?: string;
  previewImageSrc?: string;
}) {
  const [selected, setSelected] = useState<string | null>(paths[0] ?? null);
  const current = paths.find((path) => path === selected) ?? paths[0] ?? null;
  if (paths.length === 0) return null;

  return (
    <div data-testid="artifact-path-list">
      <p className="text-[10px] font-semibold tracking-wider text-ink-faint uppercase">Artifacts</p>
      <ul className="mt-1 flex flex-col gap-1.5">
        {paths.map((path) => {
          const active = path === current;
          return (
            <li key={path} className="min-w-0">
              <button
                type="button"
                aria-current={active ? "true" : undefined}
                onClick={() => setSelected(path)}
                className={`w-full truncate rounded-sm px-1 py-0.5 text-left font-mono text-[11px] ${
                  active ? "bg-accent-soft text-ink" : "text-ink-muted hover:bg-elevated hover:text-ink"
                }`}
              >
                {path}
              </button>
              {active && (
                <div className="mt-0.5 flex flex-wrap gap-1">
                  <QuietButton
                    label="Diff"
                    title="Open in Diff"
                    onClick={() => onOpenDiff?.(path)}
                    disabled={onOpenDiff === undefined}
                  />
                  <QuietButton
                    label="Finder"
                    title="Open in Finder"
                    onClick={() => onReveal?.(path)}
                    disabled={onReveal === undefined}
                  />
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {current !== null && (
        <ArtifactPreview path={current} text={previewText} imageSrc={previewImageSrc} />
      )}
    </div>
  );
}
