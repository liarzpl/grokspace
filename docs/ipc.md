# IPC

The frontend never spells out raw command names or event strings: every backend
call goes through [`src/lib/api.ts`](../src/lib/api.ts), and
[`src/App.tsx`](../src/App.tsx) is the only listener. This page is the
inventory — what [`src-tauri/src/lib.rs`](../src-tauri/src/lib.rs)
`generate_handler!` registers, what the webview listens for, and the
environment every session is spawned with.

Adding a command means a handler, an `api.ts` wrapper, and a row here. Adding
an event means a Rust `emit`, a `listen` in `App.tsx`, and a row here. A
renamed string is a runtime miss, not a type error.

PTY bytes are not an event. They travel over a Tauri channel (`attach_session`).

## Session environment

Set for every session — Grok, shell, or ACP agent. Absolute paths on purpose:
an isolated agent's cwd is its worktree, but graphs, steps, and memory stay on
the project. The same table lives in
[`graph-engineering.md`](graph-engineering.md#what-a-session-is-told).

| Variable | When | Value |
| --- | --- | --- |
| `GROKSPACE_SESSION_ID` | always | Session id; graph and steps file name |
| `GROKSPACE_PROJECT_DIR` | always | Project folder. Cwd for a Grok pane or a shell |
| `GROKSPACE_GRAPH_DIR` | always | Directory the graph belongs in |
| `GROKSPACE_GRAPH_FILE` | always | Absolute path to write the graph |
| `GROKSPACE_STEPS_DIR` | always | Directory the step list belongs in |
| `GROKSPACE_STEPS_FILE` | always | Absolute path to write the step list |
| `GROKSPACE_MEMORY_FILE` | always | Project `memory.md`; same path for every session |
| `GROKSPACE_SESSION_ROLE` | only with a role | Planner, Coder, Reviewer, Tester, or Scout. Absent — not empty — when started by hand |
| `GROKSPACE_WORKTREE` | only when isolated | Agent checkout. Added at spawn, not in `session_env` |

`XAI_API_KEY` is read from the process environment for ACP (`std::env::var`).
It is not a `GROKSPACE_*` export. See `SECURITY.md` for how it actually loads.

## Commands

Names are the `invoke` strings. Arguments and results are camelCase on the
wire. Errors serialize as a plain string (`Error`'s `Display`).

### Projects — `project.rs`

| Command | What it does |
| --- | --- |
| `list_projects` | Every known project, most recently opened first |
| `open_project` | Register a folder, or refresh it if already known |
| `update_project` | Rename and/or replace `settings` |
| `touch_project` | Mark it opened now |
| `remove_project` | Forget the row. Nothing on disk is deleted |

### Sessions — `session.rs`

| Command | What it does |
| --- | --- |
| `list_sessions` | Sessions for one project, with pending permissions |
| `create_session` | Insert the row, isolate an agent if needed, spawn pty or ACP. `allowUnisolated` only after the UI confirm |
| `attach_session` | Route output into a channel; replays buffered scrollback |
| `write_session` | Bytes into a pty. Agents have no pane; use `prompt_session` |
| `resize_session` | Pty size |
| `stop_session` | End the child; keep the row and worktree |
| `restart_session` | Close the old row, start a replacement in the same pane |
| `rename_session` | Title only |
| `close_session` | End the session and free its pane. Refuses a dirty worktree |
| `discard_session_worktree` | Force-remove a **stopped** session's tree so Close can proceed |
| `merge_session_worktree` | Commit leftovers and land the branch on the project |
| `session_merge_readiness` | Why Merge would refuse, without writing. `null` = may run |
| `prompt_session` | ACP `session/prompt`. Returns when the agent is idle again |
| `cancel_session` | Interrupt the current ACP turn; do not end the session |
| `answer_session_permission` | Allow or deny a blocked permission (`optionId` optional) |

### Memory — `memory.rs`

| Command | What it does |
| --- | --- |
| `list_memory` | Every entry for the project |
| `put_memory` | Upsert one entry; rebuilds `memory.md`; returns the list |
| `remove_memory` | Delete by key; returns the list |
| `memory_file_path` | Absolute path agents are told to read |
| `memory_skill_status` | Whether `~/.grok/skills/grokspace-memory` is current |
| `install_memory_skill` | Install or refresh that skill |

### Tasks — `task.rs`

| Command | What it does |
| --- | --- |
| `list_tasks` | The project's board |
| `create_task` | Add to `backlog` |
| `update_task` | Title, description, status, priority |
| `dispatch_task` | Assign a session and move to `in_progress` together |
| `undispatch_task` | Clear the assignment; back to `backlog` |
| `remove_task` | Delete the card |

### Diff — `diff.rs`

| Command | What it does |
| --- | --- |
| `project_diff` | What git sees. Optional `sessionId` scopes to that worktree |
| `file_diff` | One file. `untracked` diffs against nothing (all additions) |
| `reveal_artifact` | Reveal a confined path in the OS file manager |

### Settings — `settings.rs`

| Command | What it does |
| --- | --- |
| `read_settings` | App preferences, defaults filled (`runWorktreeSetup` default `off`) |
| `write_setting` | One key. Unknown values are refused rather than stored |
| `read_permission_policy` | User `~/.grokspace/permission-policy.json` (missing file is empty rules) |
| `write_permission_policy` | Replace that file. Empty patterns, unusable globs, and `*` allow-once-similar are refused |

### Graphs — `graph.rs`

| Command | What it does |
| --- | --- |
| `read_session_graph` | The file for one session, whether or not it exists |
| `watch_project_graphs` | Watch that project's graph dir; asking twice is harmless |
| `graph_skill_status` | Whether `~/.grok/skills/grokspace-graph` is current |
| `install_graph_skill` | Install or refresh that skill |

### Steps — `steps.rs`

| Command | What it does |
| --- | --- |
| `list_session_steps` | Phase plus rows for one session |
| `add_session_step` | User title; at most 20 |
| `update_session_step` | Title and/or status. A title edit marks origin `user` |
| `remove_session_step` | Delete one row; empty list returns phase to `none` |
| `reorder_session_steps` | Must name each of this session's ids once |
| `approve_session_steps` | Lock titles. Grok must be `running`; agent must be `idle` |
| `reopen_session_steps` | Approved → `proposed` when the follow-up prompt failed |
| `watch_project_steps` | Watch that project's steps dir; asking twice is harmless |
| `steps_skill_status` | Whether `~/.grok/skills/grokspace-steps` is current |
| `install_steps_skill` | Install or refresh that skill |

## Events

Payloads are camelCase. `App.tsx` is the only `listen`.

| Event | Payload | Who emits it | What the UI does |
| --- | --- | --- | --- |
| `session-exited` | `{ id, exitCode }` | Pty exit, or ACP `on_closed` (`exitCode` then `null`) | Mark stopped |
| `session-status` | `{ id, status }` | ACP status (`idle` / `running` / `needs_input`). Terminals do not emit this | Update the chip; dock attention |
| `session-permission` | `{ id, requestId, summary, options }` | ACP permission request, after the row is stored | Show Allow / Deny. Emitted before the matching `needs_input` status. A local policy Deny or allow-once-similar answers first and does not emit this |
| `session-isolation` | `{ id, reason }` | Agent start when `worktree add` was skipped | Isolation banner. Not persisted; reload infers from a null path |
| `session-update` | `{ id, kind, text }` | ACP transcript (`message` / `thought` / `tool` / `plan`) | Append. Empty text and `kind: "prompt"` are dropped |
| `graph-changed` | `{ sessionId, path, removed }` | Graph directory watcher | Re-read that session's file. Frontend only uses `sessionId` |
| `steps-changed` | `{ sessionId }` | Steps directory watcher, and only if the session row still exists | Re-read that session's list (80 ms coalesce) |
| `tasks-changed` | `{ projectId }` | Idle review moved a card to `review` | Reload the board if that project is active |

`graph-changed` also carries `path` and `removed`; the re-read covers both, so
the listener ignores them.

## Related

- [`graph-engineering.md`](graph-engineering.md) — graph file, watcher, and the
  same spawn-env table
- [`grok-cli-integration.md`](grok-cli-integration.md) — argv, not IPC. Step
  lists use the same path-and-watch shape as graphs
  (`<project>/.grokspace/steps/<session-id>.json`).
