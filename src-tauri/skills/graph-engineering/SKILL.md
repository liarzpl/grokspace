---
name: grokspace-graph
description: >
  Report the plan for a multi-step or multi-agent run as a live execution graph
  that GrokSpace draws. Use whenever the work has more than a couple of steps,
  fans out to parallel workers, needs review or approval, or the user asks to see
  the plan, the graph, or the progress.
when-to-use: >
  plan this out, show me the graph, visualise the plan, break this down,
  multi-step work, parallel agents, orchestrate, review before shipping
metadata:
  author: GrokSpace
  short-description: Live execution graph for GrokSpace
---

# Live execution graph

GrokSpace draws one graph per terminal. Write yours to the path in
`$GROKSPACE_GRAPH_FILE`; if that variable is unset, use
`.grokspace/graphs/$GROKSPACE_SESSION_ID.json` under the project root.

Two rules matter more than anything else here:

1. **Write the graph before starting the work,** as soon as the plan exists. A
   graph that arrives at the end is a report, not a plan.
2. **Update it as statuses change** — at minimum whenever a node starts and
   whenever it finishes. The panel is watching the file, so every write is
   visible immediately.

## Writing the file

Write atomically: write a temporary file next to the target and rename it over
the target. A reader that catches a half-written file shows nothing useful.

```bash
tmp="$GROKSPACE_GRAPH_FILE.tmp"
mkdir -p "$(dirname "$GROKSPACE_GRAPH_FILE")"
cat > "$tmp" <<'JSON'
{ ... }
JSON
mv "$tmp" "$GROKSPACE_GRAPH_FILE"
```

Do not create other `.json` files in that directory: every one of them is read
as another terminal's graph. Artifacts belong in a subdirectory.

## Format

```json
{
  "id": "graph-auth-rewrite",
  "name": "Auth rewrite",
  "status": "running",
  "topology": "orchestrator > survey > implement > verify > gate",
  "createdAt": "2026-08-16T14:52:10.000Z",
  "updatedAt": "2026-08-16T15:04:38.000Z",
  "nodes": [
    {
      "id": "orch",
      "type": "orchestrator",
      "label": "Orchestrator",
      "status": "completed",
      "role": "planner",
      "position": { "x": 0, "y": 160 },
      "data": {
        "description": "Plans the run and owns this file.",
        "model": "grok-build-0.1",
        "effort": "high",
        "parallelism": 1,
        "worktree": false,
        "artifactPath": ".grokspace/graphs/artifacts/plan.md"
      }
    }
  ],
  "edges": [
    {
      "id": "e1",
      "source": "orch",
      "target": "survey",
      "label": "fan out 3",
      "type": "smoothstep",
      "animated": true
    }
  ],
  "state": {
    "currentLayer": "survey",
    "notes": "One line about anything the graph cannot show.",
    "partial": false,
    "survivors": ["idea-3", "idea-7"]
  }
}
```

Field rules:

- `status` on the graph: `pending`, `running`, `completed`, `failed`, `partial`.
- `status` on a node: `pending`, `running`, `completed`, `failed`, `skipped`.
- `type` on a node: `orchestrator`, `agent`, `parallel-group`, `arena`,
  `verifier`, `human-gate`, `synthesizer`, `tool`.
- `type` on an edge: `smoothstep` (the usual choice), `default`, `step`,
  `straight`. Set `animated` to `true` for work in flight.
- `position` is optional but worth setting: lay the run out left to right in
  columns of 260 and rows of 120. Omit positions entirely rather than giving
  every node the same one, and the panel will lay the graph out itself.
- Every `edges` entry must name nodes that exist in `nodes`.
- Keep `label` short — a couple of words. Put the detail in
  `data.description`, which the panel shows when a node is selected.

## Keeping it honest

- A node that was skipped stays in the graph as `skipped`, with the reason in
  `data.description`. Deleting it hides a decision the user may want to see.
- A node that failed stays as `failed` with the reason. Do not retry silently by
  flipping it back to `running` under the same id; add a new node instead.
- `human-gate` means the run stops there and waits for a person. Use it when
  approval is genuinely needed, not as decoration.
- Set the graph's own `status` to `completed`, `failed`, or `partial` when the
  run ends, and refresh `updatedAt` on every write.
