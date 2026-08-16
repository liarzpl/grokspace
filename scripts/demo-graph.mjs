#!/usr/bin/env node
/**
 * Steps a graph through a run, so the panel can be watched updating without
 * waiting on a real agent.
 *
 * Usage, from a shell session GrokSpace started:
 *
 *   npm run graph:demo -- "$GROKSPACE_GRAPH_FILE"
 *
 * Writes the way the skill asks agents to: a temporary file renamed over the
 * target, so the panel never reads a half-written document.
 */

import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { argv, env, exit, stderr, stdout } from "node:process";

const STEP_MS = Number(env.GRAPH_DEMO_STEP_MS ?? 1000);

const target = argv[2] ?? env.GROKSPACE_GRAPH_FILE;
if (!target) {
  stderr.write(
    "Pass the graph file to write, or run this inside a GrokSpace session where\n" +
      "GROKSPACE_GRAPH_FILE is set:\n\n" +
      '  npm run graph:demo -- "$GROKSPACE_GRAPH_FILE"\n',
  );
  exit(1);
}

/** Laid out left to right, the way the panel reads best. */
const NODES = [
  { id: "orch", type: "orchestrator", label: "Orchestrator", role: "planner", x: 0, y: 120 },
  { id: "scan", type: "parallel-group", label: "Signal Scan", role: "scout", x: 260, y: 0 },
  { id: "tool", type: "tool", label: "Web Search", role: "retrieval", x: 260, y: 240 },
  // Skipped from the start, and never advanced, so the dimmed state shows up in a
  // run and not only in the tests.
  { id: "archive", type: "agent", label: "Archive Scout", role: "scout", x: 260, y: 380, skip: true },
  { id: "draft", type: "parallel-group", label: "Drafting", role: "drafter", x: 520, y: 120 },
  { id: "arena", type: "arena", label: "Arena", role: "critic", x: 780, y: 120 },
  { id: "verify", type: "verifier", label: "Feasibility", role: "verifier", x: 1040, y: 120 },
  { id: "gate", type: "human-gate", label: "Human Gate", role: "approval", x: 1300, y: 120 },
  { id: "synth", type: "synthesizer", label: "Synthesis", role: "writer", x: 1560, y: 120 },
];

const EDGES = [
  ["orch", "scan", "fan out 4"],
  ["orch", "tool", undefined],
  ["orch", "archive", "skipped"],
  ["scan", "draft", "12 signals"],
  ["tool", "draft", undefined],
  ["draft", "arena", "9 drafts"],
  ["arena", "verify", "3 survivors"],
  ["verify", "gate", undefined],
  ["gate", "synth", "on approval"],
];

/** The one node that fails, so the failed colour and its reason both show up. */
const FAILS = "tool";

const created = new Date().toISOString();
const statuses = new Map(
  NODES.map((node) => [node.id, node.skip === true ? "skipped" : "pending"]),
);

function reason(node) {
  if (statuses.get(node.id) === "skipped") {
    return "Skipped: the archive index is older than the freshness window allows.";
  }
  if (statuses.get(node.id) === "failed") {
    return "Failed: the endpoint refused the request.";
  }
  return `${node.label}, in a graph written by scripts/demo-graph.mjs.`;
}

function document(graphStatus, running) {
  return {
    id: "graph-demo",
    name: "Demo run",
    status: graphStatus,
    createdAt: created,
    updatedAt: new Date().toISOString(),
    topology: "orchestrator > scan > draft > arena > verify > gate > synthesis",
    nodes: NODES.map((node) => ({
      id: node.id,
      type: node.type,
      label: node.label,
      status: statuses.get(node.id),
      role: node.role,
      position: { x: node.x, y: node.y },
      data: {
        description: reason(node),
        model: "grok-build-0.1",
        effort: "medium",
      },
    })),
    edges: EDGES.map(([source, sink, label], index) => ({
      id: `e${index + 1}`,
      source,
      target: sink,
      ...(label === undefined ? {} : { label }),
      type: "smoothstep",
      // Animated while it feeds the node currently in flight.
      animated: sink === running,
    })),
    state: {
      currentLayer: running,
      notes:
        running === undefined
          ? "Demo run finished. Delete the file to clear the panel."
          : `Demo run: ${running} in flight.`,
      partial: graphStatus === "partial",
    },
  };
}

async function write(graphStatus, running) {
  const temporary = `${target}.tmp`;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(document(graphStatus, running), null, 2)}\n`);
  await rename(temporary, target);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

stdout.write(`Writing a demo graph to ${target}\n`);

for (const node of NODES.filter((candidate) => candidate.skip !== true)) {
  statuses.set(node.id, "running");
  await write("running", node.id);
  stdout.write(`  ${node.label} running\n`);
  await wait(STEP_MS);

  statuses.set(node.id, node.id === FAILS ? "failed" : "completed");
  await write("running", node.id);
  await wait(STEP_MS / 2);
}

// `partial` rather than `completed`: one node failed and another was skipped,
// which is exactly what that status is for.
await write("partial", undefined);
stdout.write("Done. The panel keeps drawing the file until it is deleted.\n");
