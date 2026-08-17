/**
 * The graph the tests read, standing in for one an agent wrote.
 *
 * This is an Idea Generation graph caught mid-run. It is exported as `unknown` on
 * purpose: the tests put it through `parseGraph` exactly as the store puts a real
 * file, so they exercise that path rather than a shortcut around it.
 *
 * It covers all eight node types and all five node statuses in one document, which
 * is what makes it worth keeping as a fixture: every state the parser and the panel
 * have to handle is reachable without waiting for a real graph to fail or skip a
 * node.
 */
export const SAMPLE_GRAPH: unknown = {
  id: "graph-idea-gen-4f2a",
  name: "Idea Generation",
  status: "running",
  createdAt: "2026-08-16T14:52:10.000Z",
  updatedAt: "2026-08-16T15:04:38.000Z",
  topology: "orchestrator > signal scan > drafting > arena > verify > human gate > synthesis",
  nodes: [
    {
      id: "orch",
      type: "orchestrator",
      label: "Orchestrator",
      status: "completed",
      role: "planner",
      position: { x: 0, y: 160 },
      data: {
        description:
          "Plans the run, decides how many scouts and drafters to fan out, and owns this file.",
        model: "grok-build-0.1",
        effort: "high",
        artifactPath: ".grokspace/graphs/plan.md",
      },
    },
    {
      id: "tool-search",
      type: "tool",
      label: "Web Search",
      status: "completed",
      role: "retrieval",
      position: { x: 260, y: 20 },
      data: {
        description: "Pulls recent market and community chatter for the scouts to read.",
        artifactPath: ".grokspace/graphs/artifacts/search-results.json",
      },
    },
    {
      id: "signals",
      type: "parallel-group",
      label: "Signal Scan",
      status: "completed",
      role: "scout",
      position: { x: 260, y: 160 },
      data: {
        description: "Four scouts read different sources and report signals worth acting on.",
        model: "grok-build-0.1",
        effort: "medium",
        parallelism: 4,
        worktree: false,
        artifactPath: ".grokspace/graphs/artifacts/signals.md",
      },
    },
    {
      id: "scout-legacy",
      type: "agent",
      label: "Archive Scout",
      status: "skipped",
      role: "scout",
      position: { x: 260, y: 300 },
      data: {
        description: "Skipped: the archive index was older than the freshness window allows.",
        model: "grok-build-0.1",
        effort: "low",
      },
    },
    {
      id: "ideas",
      type: "parallel-group",
      label: "Idea Drafting",
      status: "running",
      role: "drafter",
      position: { x: 520, y: 160 },
      data: {
        description: "Three drafters each turn the strongest signals into concrete proposals.",
        model: "grok-build-0.1",
        effort: "high",
        parallelism: 3,
        worktree: true,
        artifactPath: ".grokspace/graphs/artifacts/drafts/",
      },
    },
    {
      id: "arena",
      type: "arena",
      label: "Idea Arena",
      status: "pending",
      role: "critic",
      position: { x: 780, y: 160 },
      data: {
        description: "Drafts are argued against each other; only the survivors go forward.",
        model: "grok-build-0.1",
        effort: "high",
        parallelism: 3,
      },
    },
    {
      id: "probe",
      type: "agent",
      label: "Cost Probe",
      status: "failed",
      role: "analyst",
      position: { x: 1040, y: 20 },
      data: {
        description: "Failed: the pricing endpoint refused the request, so cost is unestimated.",
        model: "grok-build-0.1",
        effort: "low",
      },
    },
    {
      id: "verify",
      type: "verifier",
      label: "Feasibility Check",
      status: "pending",
      role: "verifier",
      position: { x: 1040, y: 160 },
      data: {
        description: "Checks each surviving idea against the constraints before a human sees it.",
        model: "grok-build-0.1",
        effort: "medium",
        artifactPath: ".grokspace/graphs/artifacts/feasibility.md",
      },
    },
    {
      id: "gate-1",
      type: "human-gate",
      label: "Human Gate",
      status: "pending",
      role: "approval",
      position: { x: 1300, y: 160 },
      data: {
        description: "Stops here. Pick which ideas to carry into synthesis.",
      },
    },
    {
      id: "synth",
      type: "synthesizer",
      label: "Synthesis",
      status: "pending",
      role: "writer",
      position: { x: 1560, y: 160 },
      data: {
        description: "Folds the approved ideas into one brief with rationale and next steps.",
        model: "grok-build-0.1",
        effort: "high",
        artifactPath: ".grokspace/graphs/artifacts/brief.md",
      },
    },
  ],
  edges: [
    { id: "e1", source: "orch", target: "tool-search", type: "smoothstep", animated: false },
    {
      id: "e2",
      source: "orch",
      target: "signals",
      label: "fan out 4",
      type: "smoothstep",
      animated: false,
    },
    {
      id: "e3",
      source: "orch",
      target: "scout-legacy",
      label: "skipped",
      type: "smoothstep",
      animated: false,
    },
    { id: "e4", source: "tool-search", target: "signals", type: "smoothstep", animated: false },
    {
      id: "e5",
      source: "signals",
      target: "ideas",
      label: "12 signals",
      type: "smoothstep",
      animated: true,
    },
    { id: "e6", source: "scout-legacy", target: "ideas", type: "smoothstep", animated: false },
    {
      id: "e7",
      source: "ideas",
      target: "arena",
      label: "9 drafts",
      type: "smoothstep",
      animated: false,
    },
    {
      id: "e8",
      source: "arena",
      target: "verify",
      label: "3 survivors",
      type: "smoothstep",
      animated: false,
    },
    { id: "e9", source: "arena", target: "probe", type: "smoothstep", animated: false },
    { id: "e10", source: "verify", target: "gate-1", type: "smoothstep", animated: false },
    { id: "e11", source: "probe", target: "gate-1", type: "smoothstep", animated: false },
    {
      id: "e12",
      source: "gate-1",
      target: "synth",
      label: "on approval",
      type: "smoothstep",
      animated: false,
    },
  ],
  state: {
    currentLayer: "ideas",
    notes: "Cost probe failed; the gate will have to decide without a cost estimate.",
    partial: false,
    survivors: ["idea-3", "idea-7", "idea-9"],
  },
};
