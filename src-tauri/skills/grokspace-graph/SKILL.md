---
name: grokspace-graph
description: >
  Design the right agent graph for a job, then report it as a live execution graph
  that GrokSpace draws. Decide loop versus graph, pick a topology, write node
  contracts, emit the graph file GrokSpace watches, and join fail-closed. Use
  whenever work has more than a couple of steps, fans out to parallel workers, needs
  review or approval, or the user asks about the plan, the graph, or the progress.
  Trigger on graph engineering, agent graph, topoloji, multi-agent, parallel
  subagent, Arena, workflow graph, fan-out, orchestrator, "kaç ajan", "graph mi loop
  mu", graph visualizer, live graph, plan this out, show me the graph, visualise the
  plan, break this down, orchestrate, review before shipping.
when-to-use: >
  plan this out, show me the graph, visualise the plan, break this down,
  multi-step work, parallel agents, orchestrate, review before shipping,
  kaç ajan, graph mi loop mu, topoloji, fan-out, Arena, live graph
metadata:
  author: GrokSpace
  short-description: Agent graph design plus the live graph GrokSpace draws
---

# Agent graphs, and the file GrokSpace draws

Two jobs, in this order: decide what graph the work deserves, then report it where it
can be seen.

- **Topologies, the decision tree, and job-shaped recipes:** `references/catalog.md`
- **The graph file — path, schema, when to write:** `references/graph-file.md`

Read the catalog before choosing a shape. Read the file contract before writing JSON.
Neither belongs in your head for a two-node graph.

## The one thing that must be right

Write to the path in **`$GROKSPACE_GRAPH_FILE`**. GrokSpace watches one file per
terminal, named after that terminal's session. A graph written anywhere else — in
particular to a fixed `current-graph.json` — is a graph nobody sees, and the panel
sits empty while the work happens.

If that variable is unset you are not inside GrokSpace; the fallbacks are in
`references/graph-file.md`.

## Default to no graph

**T0, one loop, is the default.** Reach for a graph only when the job splits into
genuinely independent pieces *and* one agent is not already good enough.

The napkin test: if you cannot draw three clean parallel lanes, stay T0. Sequential
work over shared state loses when you fan it out — measurably, not as a matter of
taste. A graph of one lane is a diagram of a loop.

T0 still writes the graph file. A small graph is still worth seeing.

## Hard rules

- Task shape before topology. Sequential plus shared state → T0 with high effort.
- The work list comes from a script, a glob, or arguments. Scope an agent discovered
  for itself is untrusted; filter it in code.
- Workers do not read each other's drafts. Only the supervisor or the join sees every
  output.
- Self-verification is not a vote. An evaluator is a fresh node with no producer
  context, read-only where it can be.
- Fail closed: a result counts when it succeeded **and** carried evidence. An empty or
  failed parallel slot is unverified, not fine.
- Artifacts go to a path. The lead gets a summary and that path, not the blob.
- Spawn depth is 1. Do not nest. The orchestrator re-spawns.
- A plan-mode parent can still have write-capable children. Analysis children should
  be read-only.
- Arena means isolated producers and a separate judge. It is not an equal-weight merge
  of everyone's answer.
- High effort belongs on the lead, the debug root-cause, and the judge — not on every
  worker.
- Three or four agents under a fixed budget; three to eight when the work is truly
  parallel. Do not fill the budget because it is there.
- One writer per directory. Parallel writers need `isolation: worktree`.
- **You own the graph file. Workers never read or write it.** A worker that writes it
  is a race, and the last write wins something nobody asked for.

## Procedure

1. **Classify** with the decision tree in `references/catalog.md`. Most work is T0.
2. **Name the job type** — research, ideas, refactor, docs, feature, debug, review,
   migration — and load that recipe. Compose the atoms; do not invent a new family.
3. **Write the contract** before spawning anything: each node's input and output
   shape, who may write what, the pass rubric and its retry cap, and what happens to a
   partial failure — drop, retry once, or fail everything.
4. **Write the graph file** as soon as the contract exists and before the first spawn.
   Per `references/graph-file.md`.
5. **Prompt every child** with the skeleton below. Terse prompts return empty schemas.
6. **Run**, and **keep the file current** — every node start and every node finish.
   The panel is watching; a graph that only moves at layer boundaries looks stuck.
7. **Join fail closed.** Synthesise survivors only, and record what dropped.
8. **Stop.** Set the graph's final status. Offer to save a repeatable workflow only if
   the same graph will run again.

## Prompt skeleton for every worker

```
READ-ONLY | WRITE + worktree. Use tools; do not answer from memory.
Lane: <id>. Boundary: <in scope>. Do not do: <out of scope>.
Return only <schema>. An empty list is valid only after you searched <how>.
Write large output to <path>; return the path and an eight-line summary.
```

## Stop if you are about to

- Put five nodes on a one-file rename or a document summary
- Send the same "research X" prompt to N agents
- Let a worker improve a peer's draft, or agents polish each other's titles
- Let a producer mark its own tests green
- Treat an empty parallel slot as a pass
- Delete "dead code" without an inventory
- Point several writers at one directory
- Put eight agents on one race condition
- Draw a `human-gate` and then keep going without waiting
