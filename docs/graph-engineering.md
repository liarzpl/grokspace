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
remember whose graph is whose. Three consequences worth knowing:

- **Sessions never share a graph.** Two agents in the same project write two
  files, and each pane draws only its own.
- **Restarting starts clean.** A restart mints a new session id, so the pane
  shows no graph until the new run writes one, rather than inheriting the plan of
  the run it replaced.
- **A graph goes when its session does.** Closing a session removes its file, and
  so does restarting, which closes the old session first. Once an id has left the
  database nothing can surface its graph again, so keeping the file only meant a
  project collecting one per restart.

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

[`src-tauri/src/graph.rs`](../src-tauri/src/graph.rs) watches a project's graph
directory with `notify` and emits `graph-changed` naming the session whose file
moved; [`src/stores/graphStore.ts`](../src/stores/graphStore.ts) re-reads that
file. Seven decisions in that path exist for a reason:

- **Only the directory the project's sessions write into is watched.** The
  fallback is shared by every project, so watching it as well would put a watcher
  on it per open project and report each write landing there that many times. A
  graph left in the fallback from a spell when the project folder was read-only is
  still read; it is only no longer reported live.
- **The watch is non-recursive, and only `.json` files directly in the directory
  count.** A run's artifacts live under the same directory and would otherwise be
  most of the events. Put artifacts in a subdirectory.
- **Existence decides whether a file was removed,** not the event kind. A writer
  renaming a temporary file over the target produces different events on every
  platform.
- **Writes are coalesced.** A run flipping several node statuses at once redraws
  the canvas once.
- **Invalid JSON is read again before it is shown.** A file caught mid-write is
  not valid JSON, and reporting that immediately would make every update flash an
  error that fixes itself. A file that parses but describes no graph is reported
  the first time: it will read the same a moment later. Only `JSON.parse` decides
  which of the two a failure is, so the narrow retry does not depend on
  `parseGraph` reporting rather than throwing.
- **A file past 4 MiB is refused unread,** and reported as too large rather than as
  a graph that has not arrived. The two are different things to say: one file is
  missing, the other is sitting there and will not be opened. A plan does not reach
  that size, so what this catches is an agent redirecting output into the file.
- **An event naming a session that is no longer open is ignored,** unless a graph
  is still held for it. A project's watcher outlives the sessions it was started
  for, and removing a closed session's file is itself an event naming it.

The JSON crosses from Rust to the frontend unparsed. `parseGraph` is deliberately
forgiving because a model writes these files; a second, stricter parser in Rust
would reject graphs the panel can happily draw.

## Making `grok` write one

The bundled skill at
[`src-tauri/skills/grokspace-graph/`](../src-tauri/skills/grokspace-graph/) is what
teaches the agent to report a graph. Grok Build discovers skills from
`~/.grok/skills/`, so GrokSpace installs it to `~/.grok/skills/grokspace-graph/` —
from the button in the Graph panel's empty state, not silently on boot. Installing
again refreshes any file whose bundled version has changed, and does nothing to the
rest.

It is three files, because a skill that fits in one is a skill that has to choose
between being short and being complete:

| File | Holds |
| --- | --- |
| `SKILL.md` | The runbook. Read every time the skill triggers, so it stays short. |
| `references/catalog.md` | Topologies, the loop-versus-graph decision tree, and job-shaped recipes. Read when choosing a shape. |
| `references/graph-file.md` | The file contract: path, schema, and when to write. Read when writing JSON. |

Grok loads `SKILL.md` and follows its references on demand, so a two-node graph does
not cost an agent the whole topology catalogue. `skill.rs` treats a stale reference as
not-current, because a reference describing a contract this build no longer honours is
worse than one that is missing — the agent follows it either way.

**The merge.** This skill began as GrokSpace's own, and the catalogue came from one
written by hand outside the app. Both were installed at once on the same machine and
both claimed the same triggers. Their schemas were identical, so nothing had to be
converted; what conflicted was where to write, how often, and what the defaults were.
[`docs/skill-merge.md`](skill-merge.md) records each conflict and which side won.

One of those conflicts was a real bug rather than a preference. The hand-written skill
wrote a fixed `current-graph.json`; GrokSpace watches `<session-id>.json`. Followed
exactly, it produced graphs the panel never saw, and the panel sat empty for the whole
run. The merged contract forbids that filename whenever `GROKSPACE_GRAPH_FILE` is set,
and a test asserts the prohibition — the fallback is still documented for use outside
GrokSpace, so its absence could not be the guard.

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
