# Graph documents

How a terminal's graph gets from an agent to the panel, and what the file has to
contain. The format itself is defined by
[`src/lib/graph.ts`](../src/lib/graph.ts); this document is the contract around
it.

## One graph per session

```
<project>/.grokspace/graphs/<session-id>.json
```

The file name is the session id, which is why nothing has to be stored to
remember whose graph is whose. Two consequences worth knowing:

- **Sessions never share a graph.** Two agents in the same project write two
  files, and each pane draws only its own.
- **Restarting starts clean.** A restart mints a new session id, so the pane
  shows no graph until the new run writes one, rather than inheriting the plan of
  the run it replaced. The old file stays on disk until something removes it.

When the project folder cannot be written to, both the writer and the reader fall
back to `~/.grokspace/graphs/<session-id>.json`.

## What a session is told

Every session — Grok or shell — is spawned with these:

| Variable | Value |
| --- | --- |
| `GROKSPACE_SESSION_ID` | The session's id, which is also its graph's file name |
| `GROKSPACE_PROJECT_DIR` | The project folder, which is also the session's cwd |
| `GROKSPACE_GRAPH_DIR` | The directory the graph belongs in |
| `GROKSPACE_GRAPH_FILE` | The absolute path to write |

`GROKSPACE_GRAPH_FILE` is absolute on purpose: an agent that moves into a git
worktree still reports into the graph its pane is drawing.

## How the panel stays live

[`src-tauri/src/graph.rs`](../src-tauri/src/graph.rs) watches the graph
directories with `notify` and emits `graph-changed` naming the session whose file
moved; [`src/stores/graphStore.ts`](../src/stores/graphStore.ts) re-reads that
file. Four decisions in that path exist for a reason:

- **The watch is non-recursive, and only `.json` files directly in the directory
  count.** A run's artifacts live under the same directory and would otherwise be
  most of the events. Put artifacts in a subdirectory.
- **Existence decides whether a file was removed,** not the event kind. A writer
  renaming a temporary file over the target produces different events on every
  platform.
- **Writes are coalesced.** A run flipping several node statuses at once redraws
  the canvas once.
- **A parse failure is retried once before it is shown.** A file caught mid-write
  is not valid JSON, and reporting that immediately would make every update flash
  an error that fixes itself.

The JSON crosses from Rust to the frontend unparsed. `parseGraph` is deliberately
forgiving because a model writes these files; a second, stricter parser in Rust
would reject graphs the panel can happily draw.

## Making `grok` write one

The bundled skill at
[`src-tauri/skills/graph-engineering/SKILL.md`](../src-tauri/skills/graph-engineering/SKILL.md)
is what teaches the agent to report a graph. Grok Build discovers skills from
`~/.grok/skills/`, so GrokSpace installs it to
`~/.grok/skills/grokspace-graph/SKILL.md` — from the button in the Graph panel's
empty state, not silently on boot. Installing again refreshes the file when the
bundled version has changed, and does nothing when it has not.

Skills are read at session start, so a session that was already running when the
skill was installed needs restarting before it picks it up. For a session that is
already going, the empty state's **Ask for a graph** types the request straight
into the terminal instead.

GrokSpace passes no extra `grok` flags for any of this. `--rules` would be a
tidier way to state the contract per session, but an unrecognised flag on an
older `grok` stops the terminal starting, and a terminal that will not start is a
worse failure than a graph that does not appear.

## Testing it by hand

The graph panel reads files, so nothing about it needs a real agent. Write one:

```bash
# In a session's pane, with the shell that GrokSpace started:
echo "$GROKSPACE_GRAPH_FILE"
cat > "$GROKSPACE_GRAPH_FILE" <<'JSON'
{
  "name": "By hand",
  "status": "running",
  "nodes": [
    { "id": "a", "type": "orchestrator", "label": "Plan", "status": "completed" },
    { "id": "b", "type": "agent", "label": "Work", "status": "running" }
  ],
  "edges": [{ "id": "e1", "source": "a", "target": "b", "animated": true }]
}
JSON
```

The pane's `graph` view fills in as soon as the file lands; no positions are
needed, since the layout is computed when they are missing.

To watch a graph move, the demo script steps one through a run:

```bash
npm run graph:demo -- "$GROKSPACE_GRAPH_FILE"
```

It writes a small graph and advances a node every second until the run finishes,
which is enough to see the status colours, the animated edges, and the header
tally all keep up.
