# GrokSpace docs

The longer documents behind the [README](../README.md). The README says what
the app does and how to build it; these pages hold the contracts and the
reasoning a change has to respect. The two are meant to agree — if they do
not, open an [issue](https://github.com/liarzpl/grokspace/issues).

## Index

| Document | What it covers |
| --- | --- |
| [`graph-engineering.md`](graph-engineering.md) | The graph file contract (`<project>/.grokspace/graphs/<session-id>.json`), the `GROKSPACE_*` variables every session is spawned with, the watcher's filters, the bundled graph skill, and how to test the panel by hand with `npm run graph:demo`. |
| [`session-steps.md`](session-steps.md) | The step-list contract (`<project>/.grokspace/steps/<session-id>.json`), its JSON, the `none` / `proposed` / `approved` phase machine, and how to test the Tasks rail by hand. |
| [`ipc.md`](ipc.md) | The inventory of Tauri commands and events between renderer and host, grouped by Rust module, plus the session environment table. Adding a command or an event means a row here. |
| [`grok-cli-integration.md`](grok-cli-integration.md) | The `grok` CLI surface GrokSpace invokes and the flags it must never pass; why ACP (`grok agent stdio`) replaced stdout scraping; how roles and worktree isolation reach an agent without a `grok` flag; what is still unverified against a real `grok`. |
| [`skill-merge.md`](skill-merge.md) | How the bundled graph skill was merged with a hand-written one: every conflict, which side won, and what the merge does not fix. |
| [`releasing.md`](releasing.md) | The tag-driven release workflow: signing, notarizing, the secrets it needs, the dry run, and what to check the first time it runs for real. Unproven until the first `v*` tag. |

## Reading order

1. [README](../README.md) — *What works today*, *Getting started*, and *Where
   things live*.
2. [`ipc.md`](ipc.md) — the renderer ↔ host contract. Read before touching
   `src/lib/api.ts`, `src/lib/events.ts`, or `generate_handler!` in
   `src-tauri/src/lib.rs`.
3. [`grok-cli-integration.md`](grok-cli-integration.md) — the host ↔ agent
   contract. Read before touching `src-tauri/src/session/start.rs` or
   `src-tauri/src/acp/`.
4. [`graph-engineering.md`](graph-engineering.md) and
   [`session-steps.md`](session-steps.md) — the two files an agent writes and
   GrokSpace watches. Same shape; read them together.
5. [`skill-merge.md`](skill-merge.md) — background on the graph skill. Only
   needed when editing `src-tauri/skills/`.
6. [`releasing.md`](releasing.md) — only when cutting a release.

Contributors also want [`CONTRIBUTING.md`](../CONTRIBUTING.md) (the exact
commands CI runs) and [`SECURITY.md`](../SECURITY.md).

## Host, renderer, agent: the boundaries on one page

Three kinds of process, two boundaries. Module names are the ones in the
README's [*Where things live*](../README.md#where-things-live).

### The host — `src-tauri/` (Rust, Tauri 2)

Owns everything that touches the machine: the SQLite database at
`~/.grokspace/grokspace.db` (`db.rs`, with append-only `migrations/`), projects
and tasks (`project.rs`, `task.rs`), pseudo-terminals (`pty.rs`, on
`portable-pty`), ACP agents (`acp/`), git worktrees and diffs (`worktree.rs`,
`diff.rs`, `session/worktree_cmds.rs`), the graph, steps, and memory files
agents read and write (`graph.rs`, `steps/`, `memory.rs`), settings, the named
permission policy, and the append-only permission ledger (`settings.rs`,
`policy.rs`, `ledger.rs`). Host and renderer errors go to
`~/.grokspace/logs/grokspace.log`. There is no HTTP client; nothing is
uploaded, and the ledger and snooze tests assert their source names no network
type.

`pty.rs`, `acp/`, and `worktree.rs` depend on neither Tauri nor the database,
so their tests run headlessly — real pseudo-terminals, real JSON-RPC lines,
real `git worktree add`.

### The renderer — `src/` (React 19, TypeScript, Zustand)

Draws the pane grid, board, graph, transcript, diff, palette, and settings
(`components/`), keeps state in Zustand stores (`stores/`), and never spells
out a raw command or event name: every backend call goes through a typed
wrapper in [`src/lib/api.ts`](../src/lib/api.ts), every subscription through
[`src/lib/events.ts`](../src/lib/events.ts). `types.ts` mirrors the Rust
structs, which serialize as camelCase; `generated/` is emitted from
`src-tauri/src/domain.rs`. xterm instances live in a registry outside React
([`src/lib/terminals.ts`](../src/lib/terminals.ts)) so remounts do not
duplicate input handlers or lose scrollback.

### Boundary 1 — renderer ↔ host, over Tauri IPC

- **Commands.** `invoke` calls registered by `generate_handler!` in
  `src-tauri/src/lib.rs`. Errors serialize as a plain string. The inventory is
  [`ipc.md` → Commands](ipc.md#commands).
- **Events.** Host → renderer notifications: `session-exited`,
  `session-status`, `session-permission`, `session-isolation`,
  `session-update`, `graph-changed`, `steps-changed`, `tasks-changed`. The
  inventory is [`ipc.md` → Events](ipc.md#events).
- **PTY bytes are neither.** Terminal output travels over a Tauri channel
  (`attach_session`) as raw bytes and is written to xterm as a `Uint8Array`;
  decoding UTF-8 in Rust would corrupt a sequence that straddles a read
  boundary. Exits, being rare, use an event.

### Boundary 2 — host ↔ agent

A session is one of two things, and the host treats them differently:

| | Grok pane or shell | ACP agent |
| --- | --- | --- |
| Process | The `grok` TUI, or a shell, in a pty (`pty.rs`) | `grok agent stdio`: JSON-RPC over stdin/stdout (`acp/process.rs`, `acp/protocol.rs`) |
| Pane | Owns one | None — it reports itself instead |
| Status | `running` / `stopped` only; a pty carries pixels | `running` / `idle` / `needs_input` from `session/update`, then `stopped` on exit |
| Permissions | Answered inside the TUI | `session/request_permission` → Allow / Deny chips. Allow is always `allow_once`; `allow_always` and `reject_always` are separate chips using the name the agent sent; a named policy file can Deny first; every answer is appended to `~/.grokspace/ledgers/<project-id>.jsonl` |
| Working tree | The project folder | A clean checkout of `HEAD` at `<project>/.grokspace/worktrees/<session-id>/` on branch `grokspace/<short-id>`; Close, Discard, and Merge go through the host |
| Transcript | The terminal itself | `message` / `thought` / `tool` / `plan` updates on the Graph tab and the Tasks rail |

Both kinds are spawned with the same `GROKSPACE_*` environment: absolute paths
to the session's graph file, its steps file, and the project's memory file, so
an isolated agent's cwd can be its worktree while those files stay on the
project (table in
[`graph-engineering.md`](graph-engineering.md#what-a-session-is-told)).

Status, transcript, and permission requests reach the host only from an ACP
agent, over that JSON-RPC stream. Plans and progress, from either kind of
session, come back as **files, not IPC**: the agent writes
`<project>/.grokspace/graphs/<session-id>.json` and
`<project>/.grokspace/steps/<session-id>.json`, the host watches those
directories (`graph.rs`, `steps/watch.rs`), and the renderer re-reads the one
file that moved. Memory runs the other way: the host projects SQLite into
`<project>/.grokspace/memory.md` and the agent only reads it. What makes `grok`
write those files is the three bundled skills in `src-tauri/skills/`, installed
to `~/.grok/skills/` on request.

Rules at this boundary, with the reasons in
[`grok-cli-integration.md`](grok-cli-integration.md) and
[`CONTRIBUTING.md`](../CONTRIBUTING.md):

- ACP start is `.args(["agent", "stdio"])` and nothing else. Never
  `--always-approve`, `--worktree`, `--resume`, or `--session-id`; GrokSpace
  runs `git worktree add` itself, and a restart mints a new session id.
- The ACP messages are hand-written for ACP v1. The `agent-client-protocol`
  crate is on 2.0 and is not used.
- `session/new` passes `mcpServers: []`. MCP is loaded by `grok`, not
  GrokSpace.
- Nothing about a session's status is derived from scraping terminal output.
