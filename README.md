# GrokSpace

A local-first macOS command center for running and coordinating multiple
[Grok Build](https://docs.x.ai/build) sessions across your projects.

Open a project folder, spread several independent `grok` terminals across a
pane grid, and hand work to them from a Kanban board. Agents are teammates, not
tools: they plan, code, and review while you stay in the loop.

Everything runs on your machine. There is no mandatory cloud dependency and no
telemetry; workspace state lives in `~/.grokspace`.

> **Status: Phase 0 (foundation).** The window shell, the local database, and
> project management are in place. Terminals, the Kanban board, and shared
> memory arrive in later phases — see [Roadmap](#roadmap).

## What works today

- **Project management** — open any folder as a project, switch between them,
  rename them, and remove them from the workspace. Removing a project only
  forgets it; nothing on disk is touched.
- **Recent projects** — the sidebar is ordered most-recently-opened first, and
  the app reopens on the project you used last.
- **Local persistence** — projects live in SQLite at
  `~/.grokspace/grokspace.db`.
- **Open Project** — a native folder picker, from the sidebar, the empty state,
  or <kbd>⌘O</kbd>.

## Stack

| Layer | Choice |
| --- | --- |
| Shell | Tauri 2 |
| Frontend | React 19, TypeScript, Vite 8, Tailwind CSS 4 |
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
  components/     TitleBar, ProjectSidebar, WorkspaceShell, EmptyState
  stores/         Zustand stores (projectStore)
  lib/            Typed `invoke` wrappers (api.ts) and helpers
  types.ts        Mirrors the Rust structs, which serialize as camelCase
src-tauri/
  migrations/     Append-only SQL migrations
  src/
    db.rs         Database location, pragmas, migration runner
    project.rs    Project model, queries, and Tauri commands
    error.rs      Error type; serializes to a plain string for the frontend
  icons/source/   Icon artwork and how to regenerate it
```

The frontend never spells out raw command names: every backend call goes
through a typed wrapper in [`src/lib/api.ts`](src/lib/api.ts).

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

Migration `0001` already creates `projects`, `tasks`, `sessions`, and
`memory_entries`. Only `projects` is used so far; the rest are reserved so the
later phases add queries rather than reshaping live databases.

## Roadmap

- **Phase 0 — Foundation.** Scaffold, window shell, SQLite, project CRUD. Done.
- **Phase 1 — Terminal core.** PTY-backed `grok` sessions, xterm.js panes, and
  a multi-pane layout with start/stop/rename/clear.
- **Phase 2 — Kanban and dispatch.** Task board with drag-to-dispatch onto a
  free terminal or a freshly spawned session.
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
