# GrokSpace

A local-first macOS command center for running and coordinating multiple
[Grok Build](https://docs.x.ai/build) sessions across your projects.

Open a project folder, spread several independent `grok` terminals across a
pane grid, and hand work to them from a Kanban board. Agents are teammates, not
tools: they plan, code, and review while you stay in the loop.

Everything runs on your machine. There is no mandatory cloud dependency and no
telemetry; workspace state lives in `~/.grokspace`.

> **Status: Phase 1 (terminal core).** Projects, a working multi-pane terminal
> grid, and a live graph per session are in place. The Kanban board, shared
> memory, and agent roles arrive in later phases — see [Roadmap](#roadmap).

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
- **Live graphs, one per session** — every session has its own graph file, and
  the panel redraws the moment an agent writes to it. Watch a plan from the Graph
  tab, or flip a single pane from `term` to `graph` and keep working in the
  others.
- **Local persistence** — projects and sessions live in SQLite at
  `~/.grokspace/grokspace.db`.

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

### Where things live

```
src/
  components/     TitleBar, ProjectSidebar, WorkspaceShell, EmptyState,
                  PaneGrid, TerminalPane, GraphVisualizer, graph/
  stores/         Zustand stores (projectStore, sessionStore, graphStore)
  lib/            Typed `invoke` wrappers (api.ts), the terminal registry,
                  the graph document parser, and helpers
  types.ts        Mirrors the Rust structs, which serialize as camelCase
scripts/          Development helpers; demo-graph.mjs writes a moving graph
src-tauri/
  migrations/     Append-only SQL migrations
  skills/         The Grok skill GrokSpace installs on request
  src/
    db.rs         Database location, pragmas, migration runner
    project.rs    Project model, queries, and Tauri commands
    pty.rs        Pseudo-terminal plumbing; no database, no Tauri
    session.rs    Session model and the commands that drive a pty
    graph.rs      Graph file locations, reads, and the change watcher
    error.rs      Error type; serializes to a plain string for the frontend
  icons/source/   Icon artwork and how to regenerate it
```

The frontend never spells out raw command names: every backend call goes
through a typed wrapper in [`src/lib/api.ts`](src/lib/api.ts).

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
`tasks` and `memory_entries` are still unused; they are reserved so the later
phases add queries rather than reshaping live databases.

## Roadmap

- **Phase 0 — Foundation.** Scaffold, window shell, SQLite, project CRUD. Done.
- **Phase 1 — Terminal core.** Pty-backed sessions, xterm.js panes, the grid
  layout, the session lifecycle, and a live graph per session. Done.
- **Phase 2 — Kanban and dispatch.** Task board with drag-to-dispatch onto a
  free terminal or a freshly spawned session. This is also where session status
  becomes richer than running/stopped: telling `idle` from `needs_input` needs
  the structured ACP event stream, not scraped terminal output.
- **Phase 3 — Memory and roles.** Shared project memory, role presets
  (Planner, Coder, Reviewer, Tester, Scout), and swarm launches.
- **Phase 4 — Polish and distribution.** Command palette, diff preview,
  settings, and a notarized `.dmg`.

[`docs/grok-cli-integration.md`](docs/grok-cli-integration.md) records the
verified `grok` CLI surface that Phases 1-3 build on.

## Platform notes

GrokSpace targets macOS. The window is configured with
`titleBarStyle: "Overlay"` and a hidden native title, so the traffic lights
float over the in-app title bar.

It also builds and runs on Linux, which is useful for CI. Those two options are
macOS-only, so on Linux you get the ordinary window decorations in addition to
the in-app title bar, and the space reserved for the traffic lights is empty.
