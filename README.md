# GrokSpace

A local-first macOS command center for running and coordinating multiple
[Grok Build](https://docs.x.ai/build) sessions across your projects.

Open a project folder, spread several independent `grok` terminals across a
pane grid, and hand work to them from a Kanban board. Agents are teammates, not
tools: they plan, code, and review while you stay in the loop.

Everything runs on your machine. There is no mandatory cloud dependency and no
telemetry; workspace state lives in `~/.grokspace`.

> **Status: Phase 5 in progress.** Projects, a multi-pane terminal grid, a live graph
> per session, a task board that hands work to an agent, agents driven over ACP that
> report what they are doing (including a transcript of what they say), a project
> memory every session reads, role presets that can be launched as a swarm, a
> command palette, settings, a diff panel, and per-agent git worktrees so that
> panel can show one session's changes. What remains of Phase 4 is the signed
> release; what remains of Phase 5 is merging a worktree back into the project —
> see [Roadmap](#roadmap).

## What works today

- **Project management** — open any folder as a project, switch between them,
  rename them, and remove them from the workspace. Removing a project only
  forgets it; nothing on disk is touched.
- **Terminal grid** — run several independent sessions side by side in a
  `1x1`, `2x1`, `2x2`, or `3x2` grid, or expand one to fill the window. The
  layout is remembered per project.
- **Real terminals** — each pane is a genuine pty, so full-screen TUIs work:
  Grok Build's own interface, but equally `vim`, `htop`, or anything else.
  Panes start in the project folder and reflow when the window resizes.
- **Session lifecycle** — start a Grok agent or a plain shell in any pane, then
  stop, restart, rename, clear, or close it. Sessions left running when the app
  quits come back marked as stopped, ready to restart.
- **Agents that report themselves** — a session can be a Grok agent driven over
  ACP instead of a terminal. It holds no pane, and in exchange it says whether it
  is `running`, `idle`, or `needs_input`; a permission it is blocked on appears on
  the card of the task it concerns, with Allow and Deny. Its words, thoughts, tools,
  and plans surface as a transcript on the Graph tab and the Tasks rail, with
  Cancel while it is working and a follow-up field while it is idle. A terminal can
  only ever report `running` or `stopped`, because a pty carries pixels.
- **Live graphs, one per session** — every session has its own graph file, and
  the panel redraws the moment an agent writes to it. Watch a plan from the Graph
  tab, or flip a single pane from `term` to `graph` and keep working in the
  others.
- **Task board** — a Kanban board per project, in the columns `backlog`,
  `in_progress`, `review`, and `done`. Cards can be dragged between columns or
  moved with the arrows on the card, and each card can be handed to an agent:
  one already running, a fresh terminal in a free pane, or a new ACP agent, which
  needs no pane at all. Dispatching records which session took the task.
- **Session steps** — each Grok or agent session can propose a short working list
  beside the board. Approve locks the titles; completing steps does not move the
  Kanban card.
- **Shared project memory** — one memory per project, in the columns `context`,
  `decisions`, `notes`, and `artifacts`. It is projected into a Markdown file every
  session is told to read, so what you would otherwise repeat to each agent gets
  said once. A bundled skill is what teaches agents to read it before they plan.
- **Roles, and swarms of them** — a session can be started as a Planner, Coder,
  Reviewer, Tester, or Scout. The role is remembered, titles the session, is exported
  as `GROKSPACE_SESSION_ROLE`, and is what the agent is told first. One click starts
  one agent per chosen role, each briefed for its job; a role that will not start is
  named rather than losing the rest.
- **A command palette** — `⌘K` reaches the tabs, layouts, session starts, swarm
  launches, project switches, and skill installs from one place, and it opens over a
  focused terminal rather than being swallowed by it. Search matches a subsequence, so
  `sgr` finds "Start Grok in the first free pane".
- **Settings** — a default pane layout for projects that have never chosen one, which
  panel the workspace opens on, and which new session a dispatch reaches for first.
  Shared by every project, and refused rather than stored when a value is not one this
  build knows. The dispatch preference reorders what is offered and never picks a
  target: a setting that chose for you would be one that sends work somewhere nobody
  looked.
- **A diff panel** — what changed, read out of `git`. The default view is the
  project's tree. An ACP agent that isolated into a worktree appears as a chip, and
  picking it reads that checkout. Modified, new, deleted and renamed files, with each
  file's diff against `HEAD`; a file git has never seen is shown as all additions
  rather than skipped. Read-only except Discard, which throws away a stopped agent's
  worktree so Close can proceed.
- **Per-agent worktrees** — an ACP agent starts in a clean checkout of `HEAD` at
  `<project>/.grokspace/worktrees/<session-id>/`, on a branch named
  `grokspace/<short-id>`. Grok panes and shells stay on the project folder. Graphs,
  steps, and memory still live under the project, via absolute environment variables.
  Close refuses while that tree is dirty; Discard force-removes it. Merge into the
  project branch is not this half.
- **Local persistence** — projects, sessions, tasks, memory, and settings live in
  SQLite at `~/.grokspace/grokspace.db`.

## Stack

| Layer | Choice |
| --- | --- |
| Shell | Tauri 2 |
| Frontend | React 19, TypeScript, Vite 8, Tailwind CSS 4 |
| Terminals | xterm.js 6 with `portable-pty` |
| State | Zustand |
| Database | SQLite via `rusqlite` (bundled) |

## Getting started

**Requirements**

- Node.js 20+ and npm
- Rust 1.85+ (`rustup toolchain install stable`)
- On macOS: Xcode Command Line Tools (`xcode-select --install`)
- The [`grok` CLI](https://docs.x.ai/build) — not needed for Phase 0, but it is
  the engine behind every later phase

```bash
npm install
npm run tauri:dev
```

The first run compiles the Rust backend, which takes a few minutes; later runs
are incremental. `npm run tauri:build` produces a release build, and a `.dmg`
on macOS.

## Development

```bash
npm run build          # type-check the frontend and build it
npm test               # frontend store tests (Vitest)

cd src-tauri
cargo test             # backend tests, against in-memory SQLite
cargo clippy --all-targets -- -D warnings
cargo fmt
```

Those are the same checks [`.github/workflows/ci.yml`](.github/workflows/ci.yml)
runs on every pull request, so a green run locally is a green run there. CI adds
`cargo fmt --check` in place of `cargo fmt`, and installs the WebKitGTK packages
Tauri needs to compile on Linux.

### Where things live

```
.github/          The CI workflow: the same checks, on every pull request
src/
  components/     TitleBar, ProjectSidebar, WorkspaceShell, EmptyState, PaneGrid,
                  TerminalPane, GraphVisualizer, TaskBoard, MemoryPanel,
                  CommandPalette, SettingsPanel, DiffPanel, AgentTranscript,
                  SessionSteps, graph/
  stores/         Zustand stores (projectStore, sessionStore, graphStore,
                  taskStore, memoryStore, settingsStore, diffStore, stepStore,
                  uiStore)
  lib/            Typed `invoke` wrappers (api.ts), the terminal registry,
                  the graph document parser, the role presets, the shortcut
                  table, the palette's commands, the dispatch targets, and
                  the theme reader
  styles.css      Every colour the app draws, including the ANSI palette
  types.ts        Mirrors the Rust structs, which serialize as camelCase
scripts/          Development helpers; demo-graph.mjs writes a moving graph, and
                  the release-*.sh pair holds the release workflow's decisions so
                  they can be tested
src-tauri/
  migrations/     Append-only SQL migrations
  skills/         The Grok skills GrokSpace installs on request; grokspace-graph
                  is a runbook plus two references read on demand
  src/
    db.rs         Database location, pragmas, migration runner
    project.rs    Project model, queries, and Tauri commands
    pty.rs        Pseudo-terminal plumbing; no database, no Tauri
    session.rs    Session model and the commands that drive a pty or an agent
    program.rs    Finding `grok` and `git` when PATH is not enough
    acp.rs        Agent Client Protocol: status from JSON-RPC, no Tauri, no database
    task.rs       Task model, the board's queries, and dispatch
    memory.rs     Shared project memory, and the file agents read it from
    skill.rs      Installing the skills GrokSpace bundles into ~/.grok/skills
    graph.rs      Graph file locations, reads, and the change watcher
    steps.rs      Session steps: watch, ingest, approve
    worktree.rs   Git worktrees for ACP agents; no Tauri needed to test
    diff.rs       What changed, read out of git, optionally in one session's tree
    settings.rs   App preferences: key-value in SQLite, typed on the way out
    error.rs      Error type; serializes to a plain string for the frontend
  icons/source/   Icon artwork and how to regenerate it
```

The frontend never spells out raw command names: every backend call goes
through a typed wrapper in [`src/lib/api.ts`](src/lib/api.ts).

Colour works the same way. Every value the app draws is declared in
[`src/styles.css`](src/styles.css), including the sixteen ANSI colours a terminal
paints with. Two places cannot use Tailwind classes — xterm takes a theme object and
React Flow takes props — so [`src/lib/theme.ts`](src/lib/theme.ts) reads the tokens
back out of the stylesheet rather than keeping a second copy. Adding a light theme is
a second block in one file.

### How terminals work

Three decisions here are not obvious, and undoing any of them breaks something
subtle:

- **Output travels over a Tauri channel, not the event system.** Tauri's own
  docs call the event system unsuitable for throughput and point at channels for
  child-process output. Chunks are sent as raw bytes and written to xterm as a
  `Uint8Array`; decoding UTF-8 in Rust would corrupt any sequence that straddles
  a read boundary. Exits, being rare, do use an event.
- **The pty's slave handle is dropped immediately after spawning.** Holding it
  keeps the pty open, and the reader thread then waits for an EOF that never
  comes. EOF also arrives as `Ok(0)` rather than as an error.
- **xterm instances live in a registry outside React**
  ([`src/lib/terminals.ts`](src/lib/terminals.ts)), each owning a detached
  container that is moved between hosts. React remounts panes on every layout
  change, and StrictMode remounts them in development; without the registry that
  would duplicate input handlers and discard scrollback.

[`src-tauri/src/pty.rs`](src-tauri/src/pty.rs) depends on neither Tauri nor the
database, so its tests drive real pseudo-terminals headlessly.

### How graphs work

A graph belongs to a session, not to the project:

```
<project>/.grokspace/graphs/<session-id>.json
```

Naming the file after the session id means nothing has to be stored to remember
whose graph is whose, two agents in one project never overwrite each other's
plan, and a restart — which mints a new session id — starts from no graph instead
of inheriting the plan of the run it replaced. A project folder that cannot be
written to falls back to `~/.grokspace/graphs/`.

Every session is spawned knowing where its graph belongs, through
`GROKSPACE_GRAPH_FILE` (absolute, so a worktree does not change the answer),
`GROKSPACE_GRAPH_DIR`, `GROKSPACE_SESSION_ID`, `GROKSPACE_PROJECT_DIR`, and —
when the session isolated — `GROKSPACE_WORKTREE`.
[`src-tauri/src/graph.rs`](src-tauri/src/graph.rs) watches those directories and
reports which session's file moved; the panel re-reads that one file, which is
what makes the graphs live rather than a snapshot.

What makes `grok` write one is a bundled skill, installed to `~/.grok/skills/`
from the button in the Graph panel's empty state. That empty state also names the
directory installing writes to, and can ask a running agent for a graph directly.

The skill is three files: a short runbook, a catalogue of topologies for deciding
whether the work deserves a graph at all, and the file contract. It carries no node
positions on purpose — the panel lays a graph out by longest-path layering, which can
see how many nodes landed in each column when a formula in a prompt cannot.

[`docs/graph-engineering.md`](docs/graph-engineering.md) has the file contract,
the reasoning behind the watcher's filters, and how to test the panel by hand —
including `npm run graph:demo`, which steps a graph through a run so the panel can
be watched updating without an agent.

### How memory works

The database is the memory; the file is a projection of it:

```
<project>/.grokspace/memory.md
```

Agents read files rather than SQLite, so every write rebuilds that file from the
whole table and every session is spawned knowing its path through
`GROKSPACE_MEMORY_FILE`. It is written even when the memory is empty, since a file
saying there is nothing to know is friendlier than one that is missing.

Three decisions shape the rest:

- **The key is half the primary key,** so writing is an upsert. Memory is a set of
  things that are true about the project, not a log of things that were said, and
  writing the same key twice is a correction.
- **One direction only.** GrokSpace writes and the agent reads. A file the agent
  also wrote would need merging against the table on every change, and a merge that
  guesses wrong loses something a person typed. The skill therefore asks the agent to
  *name* what belongs in memory in its reply, rather than to write it.
- **It is capped, at 32k characters.** Every session reads all of it, so an
  unbounded panel would quietly make each session more expensive and less attentive.
  Rewriting an existing entry replaces its own size, so a correction is never refused
  for being long.

`.grok/rules/` would have needed no skill at all, since Grok loads every `.md`
under it automatically. It is not used, for a reason recorded in
[`docs/grok-cli-integration.md`](docs/grok-cli-integration.md): Grok skips files
that `.gitignore` ignores, so the file would either land in the user's git history
or be silently ignored.

### How worktrees work

An ACP agent writes in its own checkout so its diff is its own. Grok panes and
shells stay on the project folder — that is the tree a person is looking at.

```
<project>/.grokspace/worktrees/<session-id>/
```

The tree is a clean checkout of `HEAD` on a branch named `grokspace/<short-id>`.
The agent does not see uncommitted files on the project tree; that is the point.
Walk-up from the worktree still finds the project's `AGENTS.md` and `.grok`.
Putting trees under `~/.grokspace` would not.

GrokSpace calls `git worktree add` itself. It does not pass `grok --worktree`:
every extra flag is a way for a session to fail to start, which is the same
reason graphs, memory, and roles stay out of flags. Missing git, a folder that
is not a repository, or a failed `worktree add` all mean the agent starts in the
project folder with no `worktree_path`, rather than refusing to start. The UI
says so: isolation did not happen, and the agent is on the project tree.

`GROKSPACE_PROJECT_DIR`, `GROKSPACE_GRAPH_FILE`, `GROKSPACE_STEPS_FILE`, and
`GROKSPACE_MEMORY_FILE` stay pointed at the **project**. `GROKSPACE_WORKTREE` is
set only when a tree exists. Process cwd (and ACP `session/new` cwd) is the
worktree.

Stop keeps the tree so the Diff panel can still read it. Close runs
`git worktree remove` without `--force` and refuses while the tree is dirty.
Discard, on a stopped session only, force-removes it. Merge, also stopped-only,
commits leftover files on the session branch (a dirty tree cannot be merged
otherwise) and `git merge`s that branch into the project. Uncommitted files on
the project block the merge; `.grokspace/` does not, because that folder is
GrokSpace's own. Conflicts abort. Restart mints a new session id but
reuses the directory, so uncommitted files survive. Forgetting a project
force-removes every leftover tree so git is not left with registered worktrees
for a folder the sidebar no longer knows.

An assigned card moves from `in_progress` to `review` when the agent goes idle,
except while its step list is still `proposed` — that idle is the Approve gate,
not the end of the work. A selected diff hunk plus an optional sentence can be
sent back to an idle agent. A graph node's file `artifactPath` opens that path
in the Diff panel, scoped to the session.

### Database

State lives in `~/.grokspace/grokspace.db` rather than the platform app-data
directory, so it is easy to inspect and back up:

```bash
sqlite3 ~/.grokspace/grokspace.db '.tables'
```

Migrations are an append-only list in
[`src-tauri/src/db.rs`](src-tauri/src/db.rs), tracked with SQLite's
`user_version`. To change the schema, add a new file under
`src-tauri/migrations/` and append it to `MIGRATIONS` — never edit a migration
that has already shipped.

Migration `0001` creates `projects`, `tasks`, `sessions`, and `memory_entries`.
Phases 1 to 3 needed no schema change at all: `tasks` and a third `sessions.kind` in
Phase 2, `memory_entries` and `sessions.role` in Phase 3, all of it already reserved.
Phase 4 ends that streak with `0003`, because a preference belonging to the app rather
than to a project had no reserved home. It is key-value rather than a column per
setting, which is the same lesson read backwards: a shape decided now is a shape a
later phase has to migrate, so the typed surface lives in Rust where changing it is
free.

`sessions.worktree_path` was reserved in `0001` and is written when an ACP agent
isolates. No new migration: filling a nullable column that already exists is what
the reservation was for.

## Roadmap

- **Phase 0 — Foundation.** Scaffold, window shell, SQLite, project CRUD. Done.
- **Phase 1 — Terminal core.** Pty-backed sessions, xterm.js panes, the grid
  layout, the session lifecycle, and a live graph per session. Done.
- **Phase 2 — Kanban and dispatch.** The board, dispatch, and ACP-driven agents
  whose status is richer than running/stopped. Done, with one caveat worth knowing:
  the ACP path has never run against a real `grok`, since the binary needs a
  subscription and an interactive sign-in.
  [`docs/grok-cli-integration.md`](docs/grok-cli-integration.md) records what that
  leaves unproven.
- **Phase 3 — Memory and roles.** Shared project memory, role presets, and swarm
  launches. Done, with the same caveat Phase 2 carries: a swarm is made of ACP
  sessions, and that path has never run against a real `grok`.
- **Phase 4 — Polish and distribution.** A command palette, a diff panel, settings,
  and a notarized `.dmg`. The first three are done. The release pipeline is written but
  cannot be proven from here: signing and notarizing need Apple Developer credentials
  and a macOS runner, so the first tagged build is what verifies it. Tracked on
  [issue #8](https://github.com/liarzpl/grokspace/issues/8) with the other things that
  need a Mac and a licensed `grok`.
- **Phase 5 — Isolation and review.** ACP agents start in their own git
  worktree, the diff panel can read that tree, Close refuses to eat dirty work,
  Discard throws it away, Merge commits leftover files and lands the branch on
  the project. An assigned card moves to `review` when the agent goes idle,
  except while the step list is still `proposed` (the Approve gate). A selected
  hunk can be sent back as a prompt, and a graph node's file path opens in the
  Diff panel. Done, with the same Mac/`grok` caveat Phase 2 carries.

[`docs/skill-merge.md`](docs/skill-merge.md) records how the bundled graph skill was
merged with a hand-written one, every conflict, and which side won.

[`docs/grok-cli-integration.md`](docs/grok-cli-integration.md) records the
verified `grok` CLI surface that Phases 1-3 build on, and
[`docs/releasing.md`](docs/releasing.md) covers signing, notarizing and what to check
the first time a real release runs.

## Platform notes

GrokSpace targets macOS. The window is configured with
`titleBarStyle: "Overlay"` and a hidden native title, so the traffic lights
float over the in-app title bar. Moving the window is started from that bar
(`data-tauri-drag-region` plus `core:window:allow-start-dragging`); without
the permission the Overlay chrome cannot be dragged.

It also builds and runs on Linux, which is useful for CI. Those two options are
macOS-only, so on Linux you get the ordinary window decorations in addition to
the in-app title bar, and the space reserved for the traffic lights is empty.
