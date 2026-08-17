# GrokSpace

A local-first macOS command center for running and coordinating multiple
[Grok Build](https://docs.x.ai/build) sessions across your projects.

Open a project folder, spread several independent `grok` terminals across a
pane grid, and hand work to them from a Kanban board. Agents are teammates, not
tools: they plan, code, and review while you stay in the loop.

Everything runs on your machine. There is no mandatory cloud dependency and no
telemetry; workspace state lives in `~/.grokspace`.

> **Status: Phase 4 in progress.** Projects, a multi-pane terminal grid, a live graph
> per session, a task board that hands work to an agent, agents driven over ACP that
> report what they are doing, a project memory every session reads, role presets that
> can be launched as a swarm, a command palette, settings, and a diff panel. What
> remains of Phase 4 is the signed release — see [Roadmap](#roadmap).

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
  the card of the task it concerns, with Allow and Deny. A terminal can only ever
  report `running` or `stopped`, because a pty carries pixels.
- **Live graphs, one per session** — every session has its own graph file, and
  the panel redraws the moment an agent writes to it. Watch a plan from the Graph
  tab, or flip a single pane from `term` to `graph` and keep working in the
  others.
- **Task board** — a Kanban board per project, in the columns `backlog`,
  `in_progress`, `review`, and `done`. Cards can be dragged between columns or
  moved with the arrows on the card, and each card can be handed to an agent:
  one already running, a fresh terminal in a free pane, or a new ACP agent, which
  needs no pane at all. Dispatching records which session took the task.
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
- **A diff panel** — what the agents have changed, read out of `git`. Modified, new,
  deleted and renamed files, with each file's diff against `HEAD`; a file git has never
  seen is shown as all additions rather than skipped. Read-only, because undoing an
  agent's work is not something this app should own before it can show that work
  clearly.
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
                  CommandPalette, SettingsPanel, DiffPanel, graph/
  stores/         Zustand stores (projectStore, sessionStore, graphStore,
                  taskStore, memoryStore, settingsStore, diffStore, uiStore)
  lib/            Typed `invoke` wrappers (api.ts), the terminal registry,
                  the graph document parser, the role presets, the shortcut
                  table, the palette's commands, the dispatch targets, and
                  the theme reader
  styles.css      Every colour the app draws, including the ANSI palette
  types.ts        Mirrors the Rust structs, which serialize as camelCase
scripts/          Development helpers; demo-graph.mjs writes a moving graph
src-tauri/
  migrations/     Append-only SQL migrations
  skills/         The Grok skills GrokSpace installs on request
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
    diff.rs       What the agents changed, read out of git; no Tauri needed to test
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
`GROKSPACE_GRAPH_DIR`, `GROKSPACE_SESSION_ID`, and `GROKSPACE_PROJECT_DIR`.
[`src-tauri/src/graph.rs`](src-tauri/src/graph.rs) watches those directories and
reports which session's file moved; the panel re-reads that one file, which is
what makes the graphs live rather than a snapshot.

What makes `grok` write one is a bundled skill, installed to `~/.grok/skills/`
from the button in the Graph panel's empty state. That empty state also names the
file the pane is watching, and can ask a running agent for a graph directly.

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

`sessions.worktree_path` is the one reserved column still unwritten. Filling it means
giving each agent its own git worktree, which is what per-session diff attribution
would need — a phase of its own rather than polish.

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
  and a macOS runner, so the first tagged build is what verifies it.

[`docs/grok-cli-integration.md`](docs/grok-cli-integration.md) records the
verified `grok` CLI surface that Phases 1-3 build on, and
[`docs/releasing.md`](docs/releasing.md) covers signing, notarizing and what to check
the first time a real release runs.

## Platform notes

GrokSpace targets macOS. The window is configured with
`titleBarStyle: "Overlay"` and a hidden native title, so the traffic lights
float over the in-app title bar.

It also builds and runs on Linux, which is useful for CI. Those two options are
macOS-only, so on Linux you get the ordinary window decorations in addition to
the in-app title bar, and the space reserved for the traffic lights is empty.
