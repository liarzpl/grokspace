import { useEffect, useState } from "react";

import { api, errorMessage } from "../../lib/api";
import { overlayLine, overlayRows, parseEdges, type CrossSessionEdge } from "../../lib/edges";
import { graphFor, useGraphStore, type GraphEntry } from "../../stores/graphStore";
import type { EdgesSnapshot, Session } from "../../types";

const EMPTY: EdgesSnapshot = {
  path: "",
  exists: false,
  json: null,
  tooLarge: false,
  updatedAt: null,
};

function titleOf(sessions: readonly Session[], id: string): string | undefined {
  return sessions.find((session) => session.id === id)?.title ?? undefined;
}

function nodeLabel(edge: CrossSessionEdge, bySession: Record<string, GraphEntry>): string | undefined {
  return graphFor(bySession, edge.fromSession).graph?.nodes.find((node) => node.id === edge.fromNode)
    ?.label;
}

/** Read-only Graph tab overlay. Does not write session graph files. */
export default function EdgesOverlay({
  projectId,
  sessionId,
  sessions,
  onSelectSession,
}: {
  projectId: string;
  sessionId: string | undefined;
  sessions: readonly Session[];
  onSelectSession: (sessionId: string) => void;
}) {
  const [snapshot, setSnapshot] = useState<EdgesSnapshot>(EMPTY);
  const [loadError, setLoadError] = useState<string | null>(null);
  const bySession = useGraphStore((state) => state.bySession);

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    void api
      .readProjectEdges(projectId)
      .then((next) => {
        if (!cancelled) setSnapshot(next);
      })
      .catch((error) => {
        if (!cancelled) setLoadError(errorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  let parsed: ReturnType<typeof parseEdges> | null = null;
  if (snapshot.json !== null && !snapshot.tooLarge) {
    try {
      parsed = parseEdges(JSON.parse(snapshot.json) as unknown);
    } catch {
      parsed = { ok: false, error: "The edges file is not valid JSON." };
    }
  }
  const error =
    loadError ??
    (snapshot.tooLarge ? "The edges file is too large to read." : null) ??
    (parsed !== null && !parsed.ok ? parsed.error : null);
  const rows =
    sessionId !== undefined && parsed !== null && parsed.ok
      ? overlayRows(parsed.document.edges, sessionId)
      : [];

  if (error !== null) {
    return (
      <p role="status" data-testid="cross-session-edges" className="shrink-0 truncate border-b border-line px-3 py-1.5 text-[11px] text-danger">
        {error}
      </p>
    );
  }
  if (rows.length === 0) return null;

  return (
    <div
      role="region"
      aria-label="Cross-session edges"
      data-testid="cross-session-edges"
      className="flex shrink-0 items-center gap-2 overflow-x-auto border-b border-line px-3 py-1.5"
    >
      <p className="shrink-0 text-[10px] font-semibold tracking-wider text-ink-faint uppercase">
        Cross-session
      </p>
      {rows.map((row) => (
        <button
          key={`${row.direction}:${row.edge.fromSession}:${row.edge.fromNode}:${row.edge.toSession}:${row.edge.kind}`}
          type="button"
          onClick={() => onSelectSession(row.otherSession)}
          className="max-w-72 truncate rounded-sm px-1.5 py-0.5 text-[11px] text-ink-muted hover:bg-elevated hover:text-ink"
        >
          {overlayLine(row, (id) => titleOf(sessions, id), nodeLabel(row.edge, bySession))}
        </button>
      ))}
    </div>
  );
}
