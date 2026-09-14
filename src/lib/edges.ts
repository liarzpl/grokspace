/**
 * Cross-session edges. One project file, not a merge of per-session graphs.
 * Host-written `{ fromSession, fromNode, toSession, kind }`.
 */

export const CROSS_EDGE_KINDS = ["delegates", "blocks", "reviews"] as const;
export type CrossEdgeKind = (typeof CROSS_EDGE_KINDS)[number];

export interface CrossSessionEdge {
  fromSession: string;
  fromNode: string;
  toSession: string;
  kind: CrossEdgeKind;
}

export interface EdgesDocument {
  edges: CrossSessionEdge[];
}

export type EdgesParseResult =
  | { ok: true; document: EdgesDocument; warnings: string[] }
  | { ok: false; error: string };

export interface OverlayRow {
  edge: CrossSessionEdge;
  direction: "outgoing" | "incoming";
  otherSession: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function edgeKey(edge: CrossSessionEdge): string {
  return `${edge.fromSession}::${edge.fromNode}::${edge.toSession}::${edge.kind}`;
}

export function parseCrossEdge(input: unknown): CrossSessionEdge | string {
  const record = asRecord(input);
  const fromSession = record ? asString(record["fromSession"]) : undefined;
  const fromNode = record ? asString(record["fromNode"]) : undefined;
  const toSession = record ? asString(record["toSession"]) : undefined;
  const kind = record ? asString(record["kind"]) : undefined;
  if (!record || !fromSession || !fromNode || !toSession) {
    return "Skipped an edge missing fromSession, fromNode, or toSession.";
  }
  if (!kind || !(CROSS_EDGE_KINDS as readonly string[]).includes(kind)) {
    return "Skipped an edge whose kind is not delegates, blocks, or reviews.";
  }
  if (fromSession === toSession) return `Skipped an edge from ${fromSession} to itself.`;
  return { fromSession, fromNode, toSession, kind: kind as CrossEdgeKind };
}

export function parseEdges(input: unknown): EdgesParseResult {
  const root = asRecord(input);
  if (!root) return { ok: false, error: "The edges file does not contain a JSON object." };
  if (!Array.isArray(root["edges"])) return { ok: false, error: "The edges file has no `edges` array." };

  const warnings: string[] = [];
  const edges: CrossSessionEdge[] = [];
  const seen = new Set<string>();
  for (const raw of root["edges"]) {
    const parsed = parseCrossEdge(raw);
    if (typeof parsed === "string") {
      warnings.push(parsed);
      continue;
    }
    const key = edgeKey(parsed);
    if (seen.has(key)) {
      warnings.push(`Skipped a duplicate ${parsed.kind} edge.`);
      continue;
    }
    seen.add(key);
    edges.push(parsed);
  }
  return { ok: true, warnings, document: { edges } };
}

export function overlayRows(edges: readonly CrossSessionEdge[], sessionId: string): OverlayRow[] {
  const rows: OverlayRow[] = [];
  for (const edge of edges) {
    if (edge.fromSession === sessionId) {
      rows.push({ edge, direction: "outgoing", otherSession: edge.toSession });
    } else if (edge.toSession === sessionId) {
      rows.push({ edge, direction: "incoming", otherSession: edge.fromSession });
    }
  }
  return rows;
}

export function overlayLine(
  row: OverlayRow,
  titleOf: (sessionId: string) => string | undefined,
  nodeLabel?: string,
): string {
  const node = nodeLabel?.trim() || row.edge.fromNode;
  const other = titleOf(row.otherSession)?.trim() || row.otherSession;
  if (row.direction === "outgoing") return `${node} ${row.edge.kind} → ${other}`;
  return `${other} · ${node} ${row.edge.kind} this session`;
}

/** Thin helper for a later baton writer. Disk write stays a follow-up. */
export function appendEdge(document: EdgesDocument, edge: unknown): EdgesParseResult {
  const parsed = parseCrossEdge(edge);
  if (typeof parsed === "string") return { ok: false, error: parsed };
  if (document.edges.some((existing) => edgeKey(existing) === edgeKey(parsed))) {
    return { ok: true, document, warnings: ["Already recorded."] };
  }
  return { ok: true, warnings: [], document: { edges: [...document.edges, parsed] } };
}
