# GrokSpace

A local-first macOS command center for running and coordinating multiple
[Grok Build](https://docs.x.ai/build) sessions across your projects.

Open a project folder, spread several independent `grok` terminals across a
pane grid, and hand work to them from a Kanban board. Agents are teammates, not
tools: they plan, code, and review while you stay in the loop.

Everything runs on your machine. There is no mandatory cloud dependency and no
telemetry; workspace state lives in `~/.grokspace`. Host and renderer errors are
appended to `~/.grokspace/logs/grokspace.log` on this machine only. Permission
answers are appended to `~/.grokspace/ledgers/<project-id>.jsonl` (Settings
replays the last 20). Nothing is uploaded.

> **Status: Phase 5 done.** Projects, a multi-pane terminal grid, a live graph
> per session, a task board that hands work to an agent, agents driven over ACP that
> report what they are doing (including a transcript of what they say), a project
> memory every session reads, role presets that can be launched as a swarm, a
> command palette, settings, a diff panel, and per-agent git worktrees that merge
> back into the project. What remains of Phase 4 is the signed, notarized
> release — see [Roadmap](#roadmap).
>
> This is an **early public, v0.1-track** macOS app: build it from source. There is
> no signed or notarized download yet, and it is not an App Store build. A few
> checks still need a Mac with a licensed `grok` — see
> [issue #8](https://github.com/liarzpl/grokspace/issues/8).

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
  the card of the task it concerns. Under the chips, the session title, the
  `doing` step, the worktree path, and overlapping diff paths are listed when
  those are already known — missing pieces are omitted, not invented. Allow is `allow_once` only; `allow_always` and
  `reject_always` are separate chips using the name the agent sent, so Allow can
  never silently become always-approve.   After Allow, **Also this session:
  `Edit src/**`** opts into matching file-tool prompts in that session, still
  answered as Allow once. `*` and any Bash are refused. The lease dies on Stop
  or Restart (a new id) and is never persisted as `allow_always`. A pane chip
  **plan | ask | acceptEdits** records host intent: plan is Spec, ask is today's
  chips, acceptEdits auto-grants that edit-class lease (still `allow_once`).
  There is no yolo chip, and the mode is not passed to `session/new` or
  `grok agent --permission-mode`. A named
  **permission policy** file of user-authored globs
  (`~/.grokspace/permission-policy.json`, and optionally
  `<project>/.grokspace/permission-policy.json`) can auto-Deny or allow-once-similar
  before chips appear. Deny wins; allow-once-similar cannot widen a deny and
  never becomes Always. A bad glob is skipped, not treated as Always. Deny is a reject-once chip. Its words, thoughts, tools,
  and plans surface as a transcript on the Graph tab and the Tasks rail, with
  Cancel while it is working and a follow-up field while it is idle. A long
  transcript keeps the latest rows on screen; earlier lines unmount until you
  ask for them. Five
  identical tool calls in a row (same text — different args do not count)
  raise a host Pause / Continue strip: Pause cancels the turn, Continue
  dismisses the strip and resets the count. A terminal can
  only ever report `running` or `stopped`, because a pty carries pixels.
- **Live graphs, one per session** — every session has its own graph file, and
  the panel redraws the moment an agent writes to it. Watch a plan from the Graph
  tab, or flip a single pane from `term` to `graph` or `steps` and keep working
  in the others. The workspace **Tasks** tab is the Kanban board; the pane face
  is this session's step list.
- **Task board** — a Kanban board per project, in the columns `backlog`,
  `in_progress`, `review`, and `done`. Cards can be dragged between columns or
  moved with the arrows on the card, and each card can be handed to an agent:
  one already running, a fresh terminal in a free pane, or a new ACP agent, which
  needs no pane at all. Dispatching records which session took the task.
  Double-click a description to edit it.
- **Session steps** — each Grok or agent session can propose a short working list
  beside the board. Build (Approve) locks the step titles and the graph node
  titles the panel is showing; completing steps does not move the Kanban card.
- **Shared project memory** — one memory per project, in the columns `context`,
  `decisions`, `notes`, and `artifacts`. It is projected into a Markdown file every
  session is told to read, so what you would otherwise repeat to each agent gets
  said once. A bundled skill is what teaches agents to read it before they plan.
- **Roles, and swarms of them** — a session can be started as a Planner, Coder,
  Reviewer, Tester, or Scout. The role is remembered, titles the session, is exported
  as `GROKSPACE_SESSION_ROLE`, and is what the agent is told first. One click starts
  one agent per chosen role, each briefed for its job; a role that will not start is
  named rather than losing the rest. Palette **Hand to Coder** / **Hand to Reviewer**
  starts that role (or prompts an idle one) with the source graph path (read-only),
  approved step titles, and a ≤2 KiB transcript excerpt; the source is left idle.
- **A command palette** — `⌘K` reaches the tabs, layouts, session starts, swarm
  launches, Hand to Coder/Reviewer, Export pack for a session, project switches, skill installs, Merge for a stopped isolated
  agent, Allow first wait, and Jump to first Needs you from one place, and it opens over a focused terminal rather than being swallowed by it. `⌘O` / `Ctrl+O` opens a
  project folder. The palette lists each bundled skill as installed or missing
  and can refresh that list; there is no remote catalog. "Install or refresh
  GrokSpace skills" writes graph, memory, and steps in that order; the Graph
  empty-state button still installs graph alone.
  Search matches a subsequence, so `sgr` finds "Start Grok in the first free pane".
- **Settings** — a default pane layout for projects that have never chosen one, which
  panel the workspace opens on, which new session a dispatch reaches for first, and a
  named permission-policy file of user globs. Shared by every project, and refused
  rather than stored when a value is not one this build knows. The dispatch
  preference reorders what is offered and never picks a target: a setting that
  chose for you would be one that sends work somewhere nobody looked. Policy Deny
  wins over ask and over allow-once-similar; Allow is never inferred as Always.
- **A diff panel** — what changed, read out of `git`. The default view is the
  project's tree. An ACP agent that isolated into a worktree appears as a chip, and
  picking it reads that checkout. Modified, new, deleted and renamed files, with each
  file's diff against `HEAD`; a file git has never seen is shown as all additions
  rather than skipped. Paths another worktree (or the project) also touched are
  marked; lockfiles and migrations get a louder hotspot strip. That strip warns —
  it does not lock Merge. On an isolated worktree that overlaps, Walk (on by
  default) lists hotspots, then other overlaps, then the rest; turn it off for
  git's order. A stopped agent's Merge refusal (dirty project, nothing
  to merge, missing git) is shown before you click. The checkpoint is that
  worktree's `HEAD`; Discard reverts it so Close can proceed. Merge, on a
  stopped agent, lands that branch on the project. There is no shadow-git.
- **Per-agent worktrees** — an ACP agent starts in a clean checkout of `HEAD` at
  `<project>/.grokspace/worktrees/<session-id>/`, on a branch named
  `grokspace/<short-id>`. Grok panes and shells stay on the project folder. Graphs,
  steps, and memory still live under the project, via absolute environment variables.
  If isolation is skipped, a dialog asks before start (Cancel / Start on the
  project tree); after confirm, a banner says the agent is on the project tree. Close
  refuses while that checkpoint is dirty; Discard reverts it (force-remove).
  Merge, on a stopped agent, commits leftover files and lands the branch on
  the project.
  After a successful `git worktree add`, paths listed in
  `<project>/.grokspace/worktreeinclude` (one relative path per line) are copied
  from the project into the new tree. Missing paths are skipped; start still
  succeeds. `**`, `..`, absolute paths, and anything outside the project are
  refused. Nothing is copied by default — not `.env`. Restart reuses the tree
  and does not copy again. If Settings → Worktree setup is **on** (off by
  default) **and** the folder is trusted, GrokSpace then runs
  `<project>/.grokspace/worktree-setup`, or `setup` in `.grokspace/worktrees.json`,
  in that tree. First open asks **Deny / Trust once / Trust this folder**.
  Untrusted folders keep setup and project hooks off. Trust is stored by
  canonical path in `~/.grokspace`; forgetting a project does not forget it.
- **Attention inbox** — a strip above the workspace lists **Needs you** (an ACP
  agent on `needs_input` or a pending permission), **Review** (idle, with
  approved steps or an isolated worktree), and **Merge** (stopped, isolated, and
  Merge would not refuse). Clicking jumps to the task card, the Diff chip, or
  the graph. With the inbox or a permission chip focused (not a terminal),
  `A` allows once, `D` denies, `O` opens the pane or card, and `G` shows the
  graph. The palette has **Allow first wait** and **Jump to first Needs you**.
  Dispatch is not gated on an empty inbox.
- **Dock attention** — an unfocused window with an ACP agent waiting on
  `needs_input` shows a badge count and one Informational bounce. A focused
  window already has Allow/Deny, so it does not bounce. A second permission on
  the same session does not bounce again until that session has left
  `needs_input`.
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

- Node.js 20.19+ or 22.12+ and npm (`package.json` `engines` matches Vite)
- Rust 1.88+ (`rustup toolchain install 1.88`; `rust-toolchain.toml` pins this channel)
- On macOS: Xcode Command Line Tools (`xcode-select --install`)
- The [`grok` CLI](https://docs.x.ai/build) — needed to drive agents and Grok
  panes, not to compile or run the CI checks
- Optional: `XAI_API_KEY` in the **process environment** if you want ACP to
  authenticate with an API key instead of `grok login`. A repo-root `.env` is
  not loaded. Export it in the same shell as `npm run tauri:dev`. A packaged
  `.app` needs the key in the user environment, or a prior `grok login`.

```bash
# optional — only if you are not using `grok login`
export XAI_API_KEY=…
npm install
npm run tauri:dev
```

The first run compiles the Rust backend, which takes a few minutes; later runs
are incremental. `npm run tauri:build` produces a release build, and a `.dmg`
on macOS. That local `.dmg` is unsigned; macOS will ask you to right-click and
Open it. `"private": true` in `package.json` only means the package is not
published to npm — it says nothing about the repository.

## Development

```bash
npm run build          # type-check the frontend and build it
npm test               # frontend store tests (Vitest)
npm run test:e2e       # TEST-002 host smoke (skips WebView if none)

cd src-tauri
cargo test             # backend tests, against in-memory SQLite
cargo clippy --all-targets -- -D warnings
cargo fmt
```

Those are the same checks [`.github/workflows/ci.yml`](.github/workflows/ci.yml)
runs on every pull request, so a green run locally is a green run there. CI adds
`cargo fmt --check` in place of `cargo fmt`, and installs the WebKitGTK packages
Tauri needs to compile on Linux.

`npm run test:e2e` is one smoke, not a harness: it opens a fixture folder, starts
a shell pane, runs `graph:demo` in that pane, and asserts the Graph snapshot
the panel would draw. A Playwright drive of the Tauri window is skipped when
there is no display (Linux CI has WebKitGTK to link, not a usable WebView).
On a Mac you can still watch the same path by hand with `npm run tauri:dev`
and `npm run graph:demo -- "$GROKSPACE_GRAPH_FILE"`.

### Where things live

```
.github/          The CI workflow: the same checks, on every pull request
src/
  components/     TitleBar, ProjectSidebar, WorkspaceShell, EmptyState, PaneGrid,
                  TerminalPane, GraphVisualizer, TaskBoard, MemoryPanel,
                  CommandPalette, SettingsPanel, DiffPanel, AgentTranscript,
                  SessionSteps, ErrorBoundary, PermissionActions, graph/
  stores/         Zustand stores (projectStore, sessionStore, graphStore,
                  taskStore, memoryStore, settingsStore, diffStore, stepStore,
                  uiStore)
  lib/            Typed `invoke` wrappers (api.ts), the terminal registry,
                  the graph document parser, the role presets, the shortcut
                  table, the palette's commands, the dispatch targets, the
                  theme reader, dock attention, worktree overlap, permission
                  chips, session steps, hunk prompts, window drag, home-relative
                  paths, the ACP transcript folder, and graph ask/artifact helpers
  styles.css      Every colour the app draws, including the ANSI palette
  types.ts        Mirrors the Rust structs, which serialize as camelCase
  generated/      Domain enum lists emitted from src-tauri/src/domain.rs
scripts/          Development helpers; demo-graph.mjs writes a moving graph,
                  e2e-smoke.mjs is the TEST-002 host smoke, and the release-*.sh
                  pair holds the release workflow's decisions so they can be tested
src-tauri/
  migrations/     Append-only SQL migrations
  skills/         The three Grok skills GrokSpace installs on request (see below)
  src/
    db.rs         Database location, pragmas, migration runner
    project.rs    Project model, queries, and Tauri commands
    pty.rs        Pseudo-terminal plumbing; no database, no Tauri
    session/      Session model, start path, and worktree commands
      db.rs       Session row, permissions, status, reconcile
      start.rs    Resolve program, isolate, spawn pty or ACP
      worktree_cmds.rs  Close, discard, merge, merge-readiness, orphan GC
    program.rs    Finding `grok` and `git` when PATH is not enough
    acp/          Agent Client Protocol: status from JSON-RPC, no Tauri, no database
      protocol.rs Classify lines, visible updates, permission replies
      process.rs  Child, handshake, status tracker
    task.rs       Task model, the board's queries, and dispatch
    memory.rs     Shared project memory, and the file agents read it from
    skill.rs      Installing the skills GrokSpace bundles into ~/.grok/skills
    graph.rs      Graph file locations, reads, and the change watcher
    edges.rs      Project `.grokspace/edges.json`; Graph tab overlay, not a merge
    steps/        Session steps: watch, ingest, approve
      store.rs    Types, paths, SQLite CRUD
      ingest.rs   Parse and fold the agent's file
      watch.rs    Directory watcher and watch command
    worktree.rs   Git worktrees for ACP agents; no Tauri needed to test
    diff.rs       What changed, read out of git, optionally in one session's tree
    settings.rs   App preferences: key-value in SQLite, typed on the way out
    policy.rs     Named permission-policy globs; deny wins; never Always
    ledger.rs     Append-only permission answers; ~/.grokspace/ledgers/; no upload
    domain.rs     Shared enum lists; emits src/generated/domain.ts
    error.rs      Error type; serializes to a plain string for the frontend
    e2e_smoke.rs  TEST-002 host smoke (compiled only for tests)
  icons/source/   Icon artwork and how to regenerate it
```

Three bundled skills. Source directory, install directory, and frontmatter
`name` are not always the same word — the memory skill is the one that differs:

| Skill | Source | Installs to | Frontmatter `name` |
| --- | --- | --- | --- |
| Graph | `src-tauri/skills/grokspace-graph/` | `~/.grok/skills/grokspace-graph/` | `grokspace-graph` |
| Memory | `src-tauri/skills/project-memory/` | `~/.grok/skills/grokspace-memory/` | `grokspace-memory` |
| Steps | `src-tauri/skills/grokspace-steps/` | `~/.grok/skills/grokspace-steps/` | `grokspace-steps` |

The frontend never spells out raw command names: every backend call goes
through a typed wrapper in [`src/lib/api.ts`](src/lib/api.ts). The command and
event inventory — and the spawn environment — is
[`docs/ipc.md`](docs/ipc.md).

Colour works the same way. Every value the app draws is declared in
[`src/styles.css`](src/styles.css), including the sixteen ANSI colours a terminal
paints with. Two places cannot use Tailwind classes — xterm takes a theme object and
React Flow takes props — so [`src/lib/theme.ts`](src/lib/theme.ts) reads the tokens
back out of the stylesheet rather than keeping a second copy. ErrorBoundary is the
exception: it paints inline from a fallback map in that file so a missing stylesheet
still matches the palette, and a test locks the map to `@theme`. Adding a light theme
is a second block in one file.

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
`GROKSPACE_GRAPH_DIR`, `GROKSPACE_SESSION_ID`, `GROKSPACE_PROJECT_DIR`,
`GROKSPACE_STEPS_DIR`, `GROKSPACE_STEPS_FILE`, `GROKSPACE_MEMORY_FILE`, and —
when the session has a role or isolated — `GROKSPACE_SESSION_ROLE` and
`GROKSPACE_WORKTREE`. The full table is in
[`docs/graph-engineering.md`](docs/graph-engineering.md#what-a-session-is-told).
[`src-tauri/src/graph.rs`](src-tauri/src/graph.rs) watches those directories and
reports which session's file moved; the panel re-reads that one file, which is
what makes the graphs live rather than a snapshot.

What makes `grok` write one is a bundled skill, installed to `~/.grok/skills/`
from the button in the Graph panel's empty state, or together with memory and
steps from the palette. That empty state also names the directory installing
writes to, and can ask a running agent for a graph directly.

The skill is three files: a short runbook, a catalogue of topologies for deciding
whether the work deserves a graph at all, and the file contract. It carries no node
positions on purpose — the panel lays a graph out by longest-path layering, which can
see how many nodes landed in each column when a formula in a prompt cannot.

[`docs/graph-engineering.md`](docs/graph-engineering.md) has the file contract,
the reasoning behind the watcher's filters, and how to test the panel by hand —
including `npm run graph:demo`, which steps a graph through a run so the panel can
be watched updating without an agent.

### Cross-session edges

Hand-offs live in `<project>/.grokspace/edges.json` as
`{ fromSession, fromNode, toSession, kind }` (`delegates` | `blocks` | `reviews`).
The Graph tab overlays rows that touch the selected session. Per-session graph
files stay one plan each; they are not merged.

### How session steps work

A step list belongs to a session, not to the project board:

```
<project>/.grokspace/steps/<session-id>.json
```

The agent writes the file; GrokSpace folds it into SQLite and draws the rail.
The phase on the session row is `none`, `proposed`, or `approved`. Build
(Approve) locks the titles and sends them back as a prompt; completing a step
does not move a Kanban card. After Build the graph panel keeps those node
titles (status may still move); new titles are a revise-plan — reopen Spec. A
project folder that cannot be written to falls back to `~/.grokspace/steps/`.

What makes `grok` write one is a bundled skill, installed to
`~/.grok/skills/grokspace-steps/` from the Tasks rail empty state or the
palette's "install GrokSpace skills".

[`docs/session-steps.md`](docs/session-steps.md) has the file contract, the
phase machine, and how to test the rail by hand.

### How memory works

The database is the memory; the file is a projection of it:

```
<project>/.grokspace/memory.md
```

The first write under `.grokspace/` also plants `.grokspace/.gitignore` with `*`,
so `git add .` does not commit memory, graphs, or worktrees. This repository
lists `.grokspace/` in its own `.gitignore` for the same reason; opening a
different folder did not, until that first write.

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
  *name* what belongs in memory in its reply, rather than to write it. The
  transcript offers **Add to Memory** when a message names a key, or on the last
  line by hand. Default type is `note` (context/decision if you switch); the
  32k cap still refuses, and the renderer does not write the Markdown file.
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

To seed deps or local config the agent would otherwise miss, list relative
paths in `<project>/.grokspace/worktreeinclude`, one per line. After a
successful `git worktree add`, those paths are copied from the project into
the new tree. Blank lines and `#` comments are ignored. A missing source is
skipped with a reason; isolation still succeeds. `**`, `..`, absolute paths,
and anything that resolves outside the project are refused. There is no
default copy — `.env` and `node_modules` stay off the tree unless listed.
Restart reuses the checkout and does not copy again.

To *install* (not just copy), add `<project>/.grokspace/worktree-setup` or a
`setup` string in `.grokspace/worktrees.json`. GrokSpace runs it only
when Settings → Worktree setup is **on** **and** the folder is trusted.
That toggle is **off** by default. First open asks **Deny / Trust once /
Trust this folder** (not Allow forever). Deny and Trust once last until quit;
Trust this folder is stored by path in `~/.grokspace`. Forgetting a project
does not drop trust. Untrusted folders keep setup and project hooks off.
The command is logged (and named in the skip reason). `$GROKSPACE_WORKTREE` is
the dest; a `worktree-setup` file also gets dest as `$1`. Timeout is two
minutes. Fail or timeout skips isolation rather than leaving a silent tree.
Restart reuses the checkout and does not run the script again.

GrokSpace calls `git worktree add` itself. It does not pass `grok --worktree`:
every extra flag is a way for a session to fail to start, which is the same
reason graphs, memory, and roles stay out of flags. Missing git, a folder that
is not a repository, or a failed `worktree add` refuse to start unless you
confirm **Start on the project tree**. Cancel leaves the agent unstarted. The
first start never sends `allowUnisolated`. After confirm, the isolation banner
(and the session chip) still say the agent is on the project tree. A swarm
asks once, never starts unisolated in silence.

`GROKSPACE_PROJECT_DIR`, `GROKSPACE_GRAPH_FILE`, `GROKSPACE_STEPS_FILE`, and
`GROKSPACE_MEMORY_FILE` stay pointed at the **project**. `GROKSPACE_WORKTREE` is
set only when a tree exists. Process cwd (and ACP `session/new` cwd) is the
worktree.

Stop keeps the tree so the Diff panel can still read it. Close runs
`git worktree remove` without `--force` and refuses while the tree is dirty.
The checkpoint is this worktree's `HEAD`. Discard, on a stopped session only,
reverts it (force-remove). There is no second snapshot store. Merge, also stopped-only,
commits leftover files on the session branch (a dirty tree cannot be merged
otherwise) and `git merge`s that branch into the project. Uncommitted files on
the project block the merge; `.grokspace/` does not, because that folder is
GrokSpace's own. Conflicts abort. Restart mints a new session id but
reuses the directory, so uncommitted files survive. Forgetting a project
force-removes every leftover tree so git is not left with registered worktrees
for a folder the sidebar no longer knows. Settings can dry-run leftover trees
under `.grokspace/worktrees/` that have no session row, with sizes. Removing
them keeps dirty and unmerged trees and never runs on its own.

An assigned card moves from `in_progress` to `review` when the agent goes idle,
except while its step list is still `proposed` — that idle is the Approve gate,
not the end of the work. Comments on a scoped diff (path, hunk, and a note)
stay in the panel until they are sent as one follow-up to an idle agent. A
graph node's file `artifactPath` opens that path in the Diff panel, scoped to
the session. The node inspector and Memory Artifacts column list claimed file
paths with Open in Finder or Diff. Markdown previews as text and images as
images; agent HTML is never rendered.

### Database

State lives in `~/.grokspace/grokspace.db` rather than the platform app-data
directory, so it is easy to inspect and back up. Folder trust is the
`trusted_folders` table, keyed by canonical path — forgetting a project does
not drop it.

```bash
sqlite3 ~/.grokspace/grokspace.db '.tables'
tail -n 50 ~/.grokspace/logs/grokspace.log
tail -n 20 ~/.grokspace/ledgers/<project-id>.jsonl
```

Command failures, ErrorBoundary crashes, store banners, and failed pane
attach/resize/emit land in that log. Typing into a session that has already
exited does not. Nothing is uploaded.

Migrations are an append-only list in
[`src-tauri/src/db.rs`](src-tauri/src/db.rs), tracked with SQLite's
`user_version`. To change the schema, add a new file under
`src-tauri/migrations/` and append it to `MIGRATIONS` — never edit a migration
that has already shipped.

There are six shipped migrations. `0001` creates `projects`, `tasks`, `sessions`,
and `memory_entries`. It reserves `sessions.role` and `sessions.worktree_path`.
It does **not** create `sessions.kind` — that arrives in `0002`. The `0001` file
header still says later phases "only add rows and queries"; that is stale.

| File | What it added |
| --- | --- |
| `0001_initial.sql` | `projects`, `tasks`, `sessions`, `memory_entries` |
| `0002_session_command.sql` | `sessions.kind` (default `grok`) and `sessions.exit_code`. The filename says "command"; the SQL does not add a command column. The name is left as-is so the `include_str!` path in `db.rs` stays stable. |
| `0003_app_settings.sql` | `app_settings` key-value table. Preferences belong to the app, not a project; a new preference is a new key, and the typed surface lives in Rust. |
| `0004_session_permissions.sql` | `session_permissions`, so a pending ACP prompt survives a webview reload |
| `0005_session_steps.sql` | `session_steps` and `sessions.steps_phase` (`none` / `proposed` / `approved`) |
| `0006_permission_options.sql` | `options` JSON on `session_permissions`, so Allow can stay `allow_once` and Always-allow is a named chip |

`sessions.worktree_path` was reserved in `0001` and is written when an ACP agent
isolates. Filling a nullable column that already exists needed no new migration.

## Roadmap

- **Phase 0 — Foundation.** Scaffold, window shell, SQLite, project CRUD. Done.
- **Phase 1 — Terminal core.** Pty-backed sessions, xterm.js panes, the grid
  layout, the session lifecycle, and a live graph per session. Done.
- **Phase 2 — Kanban and dispatch.** The board, dispatch, and ACP-driven agents
  whose status is richer than running/stopped. Done. Leftover real-`grok` ACP
  checks (permission option ids, a swarm) stay on
  [issue #8](https://github.com/liarzpl/grokspace/issues/8).
  [`docs/grok-cli-integration.md`](docs/grok-cli-integration.md) records the
  documented surface.
- **Phase 3 — Memory and roles.** Shared project memory, role presets, and swarm
  launches. Done. A swarm is made of ACP sessions, so it inherits the same leftovers.
- **Phase 4 — Polish and distribution.** A command palette, a diff panel, settings,
  and a notarized `.dmg`. The first three are done. The release pipeline is written but
  unproven: there are no `v*` tags, signing and notarizing need Apple Developer
  credentials and a macOS runner, and repository Actions secrets may still be empty.
  Also on [issue #8](https://github.com/liarzpl/grokspace/issues/8): HTML5 drag in
  macOS WKWebView, and optional column reorder. Inline description edit shipped in
  [#23](https://github.com/liarzpl/grokspace/pull/23).
- **Phase 5 — Isolation and review.** ACP agents start in their own git
  worktree, the diff panel can read that tree, Close refuses to eat dirty work,
  Discard reverts that checkpoint, Merge commits leftover files and lands the branch on
  the project. An assigned card moves to `review` when the agent goes idle,
  except while the step list is still `proposed` (the Approve gate).   Comments on
  hunks can be bundled and sent back as one prompt, and a graph node's file path
  opens in the Diff panel. The node inspector and Memory Artifacts column list
  claimed paths with Finder or Diff. Done. The same Mac/`grok` leftovers as Phase 2 still
  apply.

[`docs/skill-merge.md`](docs/skill-merge.md) records how the bundled graph skill was
merged with a hand-written one, every conflict, and which side won.

[`docs/session-steps.md`](docs/session-steps.md) is the step-list contract (path,
JSON, phase, skill), the same shape as
[`docs/graph-engineering.md`](docs/graph-engineering.md) for graphs.

[`docs/grok-cli-integration.md`](docs/grok-cli-integration.md) records the
verified `grok` CLI surface the app builds on, and
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

## License

Released under the [MIT License](LICENSE).
