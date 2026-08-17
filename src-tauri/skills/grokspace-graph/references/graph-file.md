# The graph file

GrokSpace draws one graph per terminal, by watching one file per session. This is what
goes in it, where it goes, and when to write it.

You — the orchestrator — own this file. Workers never read or write it.

## Path

In order. Stop at the first that applies:

1. **`$GROKSPACE_GRAPH_FILE`.** Set for every session GrokSpace starts. This is the
   file the panel is watching, and its name is the session's id.
2. `.grokspace/graphs/$GROKSPACE_SESSION_ID.json` under `$GROKSPACE_PROJECT_DIR`, if
   the first is somehow unset but these are not.
3. Outside GrokSpace only: `.grokspace/graphs/current-graph.json` under the project
   root, where the project root is `git rev-parse --show-toplevel` unless that is
   `$HOME`.

**Never write `current-graph.json` when `$GROKSPACE_GRAPH_FILE` is set.** Two things go
wrong at once: the panel watching the session file sees nothing at all, and a second
`.json` appears in a directory where every file is taken for a terminal's graph.

`mkdir -p` the directory. Write a temporary file beside the target and rename it over —
a reader that catches a half-written file shows nothing useful. Pretty-print with two
spaces.

Nothing else belongs in that directory. Artifacts go in a subdirectory, and
`data.artifactPath` names them.

## When to write

Every write replaces the whole file. Keep `id` and `createdAt`; set `updatedAt` to now.

| Moment | What changes |
| --- | --- |
| Contract written, before the first spawn | The whole graph. Status `running`. Every node `pending` except you: the orchestrator is `running`, because it is. |
| A node starts | That node to `running`. Update `state.currentLayer`. |
| A node finishes | That node to `completed`, `failed`, or `skipped`, with the reason in `data.description` if it is not obvious. |
| A group or arena joins | The group's own status, and `state.survivors`. Put what dropped in `state.notes`. |
| A `human-gate` is reached | That node to `running`, and then **actually wait**. The graph stays `running`. |
| The run ends | The graph's final status. |

**Write on every node start and finish, not only at layer joins.** A panel is watching
this file, and a graph that only moves when a whole layer completes looks stuck for
minutes at a time. This is the one rule most worth obeying, because the cost of
breaking it is invisible to you and obvious to the person watching.

Do not rewrite on every inner tool call. A node starting and finishing is the unit.

## Schema

Exactly these keys. Nothing extra at the top level.

```json
{
  "id": "ge-20260816T143012Z-ideas-arena",
  "name": "Idea generation",
  "status": "running",
  "topology": "ideas-arena",
  "createdAt": "2026-08-16T14:30:12Z",
  "updatedAt": "2026-08-16T14:31:40Z",
  "nodes": [
    {
      "id": "orch",
      "type": "orchestrator",
      "label": "Lead",
      "status": "running",
      "role": "lead",
      "data": {
        "description": "Contract, spawn, fail-closed join; owns this file.",
        "model": "grok-4.6",
        "effort": "xhigh",
        "parallelism": 0,
        "worktree": false,
        "artifactPath": ""
      }
    }
  ],
  "edges": [
    {
      "id": "e-orch-signals",
      "source": "orch",
      "target": "signals",
      "label": "fan out 3",
      "type": "smoothstep",
      "animated": true
    }
  ],
  "state": {
    "currentLayer": "signals",
    "notes": "Signals join: 3 of 3 survived. Archive lane skipped, no index exists.",
    "partial": false,
    "survivors": ["orch", "sig-market", "sig-users"]
  }
}
```

### Values that are closed

These four are the only enumerations. GrokSpace draws an unrecognised node type as a
plain agent and an unrecognised status as `pending`, so a wrong value here is a graph
that quietly misrepresents the run.

- Graph `status`: `pending` `running` `completed` `failed` `partial`
- Node `status`: `pending` `running` `completed` `failed` `skipped`
- Node `type`: `orchestrator` `agent` `parallel-group` `arena` `verifier`
  `human-gate` `synthesizer` `tool`
- Edge `type`: `default` `smoothstep` `step` `straight`

`partial` is for the graph only. A lane that ran and could not be verified is a node
`failed`; one that policy never ran is `skipped`. An empty result after a real search
is `completed`.

### Values that are not closed

`role` and `effort` are free strings, and GrokSpace shows whatever you write. Useful
roles are `lead`, `lane`, `judge`, `skeptic`, `implementer`, `reviewer`, `human`, but a
run with a shape those do not fit should say what it actually is rather than pick the
nearest wrong one. Same for `effort`.

### Ids

- Graph: `ge-<compact UTC>-<job slug>`, so a glance tells you when and what.
- Node: a stable slug — `orch`, `signals`, `idea-1`, `judge-1`, `gate-1`, `synth`.
  Stable matters: GrokSpace keeps a node selected across writes by id.
- Edge: `e-<source>-<target>`.

### `data`, all six keys, always

Emit every key. Unused is `""`, `0`, or `false` rather than absent — it makes two
versions of the file diffable, which is most of debugging a graph that went wrong.

| Key | Holds |
| --- | --- |
| `description` | The node's contract boundary, one line. Shown when a node is selected. |
| `model` | The model id if known, else `""`. |
| `effort` | The reasoning effort, else `""`. |
| `parallelism` | Member count on a `parallel-group` or `arena`; `0` on anything else. |
| `worktree` | `true` only when that node runs in its own worktree. |
| `artifactPath` | Where that node's output landed, else `""`. |

### Positions: leave them out

Do not write `position`. GrokSpace lays the graph out itself — longest-path layering,
left to right — and it does that better than a formula, because it can see how many
nodes ended up in each layer.

Write positions only to override that deliberately, and then write them for every
node: a file where some have positions and some do not is laid out from scratch
anyway, and one where every node shares a position looks like a rendering bug.

### Edges

`smoothstep` for the ordinary case, `step` for a gate or a verification hop.

`animated` means **work in flight right now**, not "this is a fan-out". Turn it on when
the target is `running` and off when it is not. It is the cheapest signal of life in
the whole panel, and leaving every fan-out edge animated forever wastes it.

Every edge must name nodes that exist. GrokSpace drops an edge whose end is missing and
says so, so a typo costs you an invisible dependency.

### Groups are flat

There is no `parentId`. A group is a node, and its members are nodes wired to it:

```
orchestrator → parallel-group → agent → synthesizer
                              → agent → synthesizer
orchestrator → arena → agent → verifier → synthesizer
                     → agent → verifier
```

A group is `completed` if any member survived, `failed` if all of them failed or went
unverified. A `skipped` member is not a failure.

### Timestamps

`YYYY-MM-DDTHH:MM:SSZ`, in UTC. Two mistakes to avoid, both of which have happened:
writing local time with a `Z` on the end, and letting `updatedAt` come out earlier than
`createdAt` because the two were read from different clocks.

## Keeping it honest

- A skipped node stays in the graph as `skipped`, with the reason in
  `data.description`. Deleting it hides a decision worth seeing.
- A failed node stays `failed`. Do not retry silently by flipping it back to `running`
  under the same id — add a new node, so the graph shows that there were two attempts.
- `human-gate` means the run stops and waits for a person. Use it when approval is
  genuinely needed, and then wait. A gate you draw and walk past is worse than no gate:
  it tells the person watching that they will be asked.
- `state.notes` is one line about what the graph cannot show — usually what dropped at
  a join. No secrets.

## Which graph is which

One file per terminal, so several sessions can each be running their own graph and
GrokSpace shows each in its own pane. Do not try to represent two runs in one file, and
do not archive the file unless asked. A new run overwrites it with a new `id`.
