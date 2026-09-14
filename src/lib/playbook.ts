/**
 * Local playbook snapshots (FEAT-030).
 *
 * A skill is SKILL.md prose. A playbook is a session shape: graph stub, steps
 * stub, roles, memory excerpt. No transcript. Paths use `$GROKSPACE_*`.
 */

import type { GraphDocument } from "./graph";
import type { MemoryEntry, Session, SessionStep } from "../types";
import { MAX_STEPS } from "./limits";
import { briefPrompt, ROLES, type Role } from "./roles";
import { transcriptExcerpt } from "./talkToSession";

export type PlaybookScope = "user" | "project";

export interface PlaybookSnapshot {
  name: string;
  roles: string[];
  graph: string;
  steps: string;
  memory: string;
}

export interface PlaybookRecord extends PlaybookSnapshot {
  scope: PlaybookScope;
  path: string;
}

export interface PlaybookSource {
  sessions: readonly Session[];
  graphs: Record<string, { graph: GraphDocument | null }>;
  steps: Record<string, { phase?: string; steps: readonly SessionStep[] }>;
  memory: readonly MemoryEntry[];
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function sanitizePlaybookName(raw: string): string | null {
  const name = raw.trim();
  if (name === "" || name.includes("..") || !NAME.test(name)) return null;
  return name;
}

/** Palette `!name`. */
export function playbookNameFromQuery(query: string): string | null {
  const trimmed = query.trim();
  return trimmed.startsWith("!") ? sanitizePlaybookName(trimmed.slice(1).trim()) : null;
}

export function redactPlaybookPaths(text: string): string {
  return text
    .replace(/\/[^\s"'\\]*\/\.grokspace\/graphs\/[^\s"'\\]+/g, "$GROKSPACE_GRAPH_FILE")
    .replace(/\/[^\s"'\\]*\/\.grokspace\/steps\/[^\s"'\\]+/g, "$GROKSPACE_STEPS_FILE")
    .replace(/\/[^\s"'\\]*\/\.grokspace\/memory\.md/g, "$GROKSPACE_MEMORY_FILE")
    .replace(/\/[^\s"'\\]*\/\.grokspace\/worktrees\/[^\s"'\\]+/g, "$GROKSPACE_WORKTREE");
}

export function snapshotPlaybook(name: string, source: PlaybookSource): PlaybookSnapshot | null {
  const id = sanitizePlaybookName(name);
  if (id === null) return null;
  const usable = source.sessions.filter((session) => session.kind === "agent" || session.kind === "grok");
  const roles = uniqueRoles(usable.map((session) => session.role));
  const graph = pickGraph(usable, source.graphs);
  const steps = pickSteps(usable, source.steps);
  if (roles.length === 0 && graph === null && steps.length === 0) return null;
  return {
    name: id,
    roles,
    graph: graphStub(id, graph),
    steps: JSON.stringify({
      phase: "proposed",
      steps: steps.slice(0, MAX_STEPS).map((step) => ({
        title: step.title.replace(/\s+/g, " ").trim(),
        status: "pending",
      })),
    }),
    memory: transcriptExcerpt(source.memory.map((entry) => ({ text: `${entry.key}: ${entry.content}` }))),
  };
}

export function canSavePlaybook(source: PlaybookSource): boolean {
  return snapshotPlaybook("tmp", source) !== null;
}

export function resolvePlaybookRoles(names: readonly string[]): Role[] {
  const resolved: Role[] = [];
  for (const name of names) {
    const role = ROLES.find((entry) => entry.name === name);
    if (role !== undefined && !resolved.some((entry) => entry.name === role.name)) {
      resolved.push(role);
    }
  }
  return resolved;
}

export function playbookPrompt(role: Role, snapshot: PlaybookSnapshot): string {
  const titles = titlesOf(snapshot.steps, "title");
  const nodes = titlesOf(snapshot.graph, "label");
  const parts = [
    briefPrompt(role),
    `Follow playbook ${snapshot.name}. Write the graph to $GROKSPACE_GRAPH_FILE and steps to $GROKSPACE_STEPS_FILE.`,
  ];
  if (nodes.length > 0) parts.push(`Playbook graph nodes: ${nodes.join("; ")}.`);
  if (titles.length > 0) {
    parts.push(`Playbook steps: ${titles.map((title, index) => `${index + 1}. ${title}`).join(" ")}.`);
  }
  const memory = snapshot.memory.replace(/\s+/g, " ").trim();
  if (memory !== "") parts.push(`Memory excerpt: ${memory}`);
  return parts.join(" ");
}

function uniqueRoles(names: readonly (string | null)[]): string[] {
  const known = new Set(ROLES.map((role) => role.name));
  return names.filter((name): name is string => name !== null && known.has(name)).filter(
    (name, index, all) => all.indexOf(name) === index,
  );
}

function pickGraph(
  sessions: readonly Session[],
  graphs: PlaybookSource["graphs"],
): GraphDocument | null {
  const ranked = [...sessions].sort((a, b) => Number(b.role === "Planner") - Number(a.role === "Planner"));
  for (const session of ranked) {
    const graph = graphs[session.id]?.graph;
    if (graph !== undefined && graph !== null && graph.nodes.length > 0) return graph;
  }
  return null;
}

function pickSteps(sessions: readonly Session[], steps: PlaybookSource["steps"]): SessionStep[] {
  let fallback: SessionStep[] = [];
  for (const session of sessions) {
    const entry = steps[session.id];
    if (entry === undefined || entry.steps.length === 0) continue;
    if (entry.phase === "approved") return [...entry.steps];
    if (fallback.length === 0) fallback = [...entry.steps];
  }
  return fallback;
}

function graphStub(name: string, graph: GraphDocument | null): string {
  const doc =
    graph === null
      ? { id: name, name, status: "pending", nodes: [], edges: [] }
      : {
          ...graph,
          id: UUID.test(graph.id) ? name : graph.id,
          status: "pending",
          nodes: graph.nodes.map((node) => ({ ...node, status: "pending" })),
        };
  return redactPlaybookPaths(JSON.stringify(doc));
}

function titlesOf(json: string, key: "title" | "label"): string[] {
  try {
    const parsed = JSON.parse(json) as { steps?: { title?: string }[]; nodes?: { label?: string }[] };
    const rows = key === "title" ? parsed.steps : parsed.nodes;
    return (rows ?? [])
      .map((row) => String((row as { title?: string; label?: string })[key] ?? "").replace(/\s+/g, " ").trim())
      .filter((text) => text !== "");
  } catch {
    return [];
  }
}
