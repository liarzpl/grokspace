# Session steps

How a session's working list gets from an agent to the Tasks rail, and what the
file has to contain. The rows themselves live in SQLite
([`src-tauri/src/steps.rs`](../src-tauri/src/steps.rs)); this document is the
contract around the inbound file and the phase machine.

The project Kanban is how work is handed *to* a session. This list is how the
session shows the breakdown *back*. Completing a step does not move a card.

## One list per session

```
<project>/.grokspace/steps/<session-id>.json
```

The file name is the session id, the same rule graphs use. Three consequences
worth knowing:

- **Sessions never share a list.** Two agents in the same project write two
  files, and the rail draws only the session you have selected.
- **Restarting starts clean.** A restart mints a new session id, so the pane
  shows no list until the new run writes one.
- **A list goes when its session does.** Closing a session removes its file, and
  so does handing the session a new job (`clear`): leaving the file would let the
  watcher fold the last job back in as a fresh proposal.

When the project folder cannot be written to, both the writer and the reader fall
back to `~/.grokspace/steps/<session-id>.json`.

Shells have no steps face. Grok panes and ACP agents do.

## What a session is told

Every session — Grok, shell, or ACP agent — is spawned with the same environment.
The full table is in
[`graph-engineering.md`](graph-engineering.md#what-a-session-is-told). The two
that matter here:

| Variable | Value |
| --- | --- |
| `GROKSPACE_STEPS_DIR` | The directory the list belongs in |
| `GROKSPACE_STEPS_FILE` | The absolute path to write |

`GROKSPACE_STEPS_FILE` is absolute on purpose: an agent that moves into a git
worktree still reports into the list its pane (or the Graph/Tasks rail) is
drawing.

## The JSON

Write JSON to `$GROKSPACE_STEPS_FILE`. A file written anywhere else is a list
nobody sees. Either of these shapes is accepted; junk entries are skipped.

```json
{
  "steps": [
    { "id": "read-auth", "title": "Read auth.ts", "status": "pending" },
    { "id": "add-test", "title": "Add a failing test", "status": "pending" }
  ]
}
```

A root array of the same objects is also fine. `title` is required and must be
non-empty after trim. `id` is optional on the first write; keep it stable across
later writes so status updates match the same row. `status` is `pending`,
`doing`, `done`, or `skipped` (anything else reads as `pending`).

Two caps, because a working list that becomes a log is useless on a rail:

- **At most 20 steps.** A twenty-first title is dropped, not an error.
- **At most 64 KiB.** A file past that is refused unread — almost certainly a
  process redirecting output into the path.

Invalid JSON is ignored and the last good list stays. An empty object or a file
with no titles is the same: nothing to fold.

## The phase machine

The list has a phase on the session row (`sessions.steps_phase`), not in the
file. The file is inbound only — agents write it, GrokSpace folds it into
SQLite, and edits a person makes in the UI go back as a prompt rather than by
rewriting the same file.

| Phase | How it got there | What a new write may change |
| --- | --- | --- |
| `none` | No list yet, or the last step was deleted | Titles, order, and status. First successful ingest moves the phase to `proposed`. |
| `proposed` | The agent wrote a list, or the user added a title | Titles and status. A title the user edited in the UI is kept; leftover user-added rows that the file omitted are kept. |
| `approved` | Approve | Status only. New titles and a different order are ignored. |

Approve refuses an empty list, a shell, a Grok pane that is not `running`, and
an agent that is not `idle`. Approve then sends one line — `Approved. Continue
as written:` plus the titles — into the session (`promptSession` for an agent,
`writeSession` + `\r` for a Grok pane). If that prompt never lands, Reopen puts
the phase back to `proposed` so Approve can be tried again.

An assigned Kanban card moves from `in_progress` to `review` when the agent
goes idle, **except** while the list is still `proposed`. That idle is the
Approve gate, not the end of the work.

## How the rail stays live

[`src-tauri/src/steps.rs`](../src-tauri/src/steps.rs) watches a project's steps
directory with `notify` and, when a live session's file moves, folds it into
SQLite and emits `steps-changed`.
[`src/stores/stepStore.ts`](../src/stores/stepStore.ts) re-reads that session
(80 ms coalesce). Decisions that differ from the graph watcher:

- **The file is parsed in Rust and stored as rows.** The rail draws SQLite, not
  the JSON. A person editing a title in the UI is editing a row; a later agent
  write must not blow that away (see `proposed` above).
- **A leftover file is folded only when the phase is still `none`.** Re-reading
  while `proposed` would restore agent rows the user had deleted. Watch-start
  and idle review share this gate.
- **An event naming a session that is no longer open is not emitted.** A close
  deletes the row and then the file; emitting for a gone session would make the
  frontend re-read it and banner `SessionNotFound`.
- **Only the directory the project's sessions write into is watched**,
  non-recursively, and only `.json` files directly in it count — the same
  filters as graphs, for the same reasons.

## Making `grok` write one

The bundled skill at
[`src-tauri/skills/grokspace-steps/`](../src-tauri/skills/grokspace-steps/) is
what teaches the agent to propose a list and wait. Grok Build discovers skills
from `~/.grok/skills/`, so GrokSpace installs it to
`~/.grok/skills/grokspace-steps/` — from the empty state on the Tasks rail, or
the palette's "install GrokSpace skills", not silently on boot. It is one
`SKILL.md` (frontmatter `name: grokspace-steps`).

The runbook's rule is: write the file **before** any tool that changes the
project, then wait. The next message is the approval (or an edited list). After
approval, update **status only**.

Skills are read at session start, so a session that was already running when the
skill was installed needs restarting before it picks it up.

## Testing it by hand

The rail reads SQLite after a file lands, so nothing about it needs a real
agent. Write one:

```bash
# In a session's pane, with the shell that GrokSpace started:
echo "$GROKSPACE_STEPS_FILE"
cat > "$GROKSPACE_STEPS_FILE" <<'JSON'
{
  "steps": [
    { "id": "a", "title": "Read the contract", "status": "done" },
    { "id": "b", "title": "Write the change", "status": "doing" },
    { "id": "c", "title": "Add a test", "status": "pending" }
  ]
}
JSON
```

The session's step list on the Tasks rail fills in as `proposed` as soon as the
file lands. Approve (Grok pane running, or agent idle) locks the titles.
