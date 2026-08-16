# Grok Build CLI integration

Reference notes for the `grok` CLI surface that GrokSpace drives from Phase 1
onward. Checked against the xAI Grok Build docs (`docs.x.ai/build/cli`).

Phase 0 does not shell out to `grok` at all. This file exists so the terminal
and dispatch work starts from the real flag surface rather than from
assumptions — several of the flags in the original plan behave differently than
their names suggest.

## Corrections to the original master plan

These are the places where the planned integration would not have worked:

- **`--session-id` does not resume.** `-s, --session-id <uuid>` assigns a UUID
  to a *new* session, and the UUID must not already exist. To continue an
  existing conversation use `-r, --resume [<uuid>]` or `-c, --continue` (the
  most recent session for the current directory). `--session-id` is only valid
  alongside `--resume`/`--continue` when paired with `--fork-session`.
  GrokSpace should therefore generate a UUID when it *creates* a session, store
  it on the `sessions` row, and pass that UUID to `--resume` afterwards.
- **Prefer ACP over parsing stdout for status.** The plan called for watching
  stdout to derive agent status. `grok agent stdio` runs Grok as an
  [ACP](https://docs.x.ai/build/cli) agent speaking JSON-RPC over stdin/stdout
  and emits structured `session/update` events. That is a far better source for
  the `idle | running | needs_input | stopped` states than scraping a TUI, and
  it is stable across releases in a way that rendered output is not.
- **Plan mode is a permission mode, not a slash command.** Start the session in
  the `plan` permission mode instead of sending `/plan` into the TUI.
- **Worktree naming needs the `=` form.** `grok --worktree feat "prompt"` can
  parse `feat` as the prompt. Use `--worktree=feat`.
- **`--no-auto-update` belongs in every automated invocation**, otherwise
  background update checks can interleave with machine-readable output.

## Invocation modes

GrokSpace uses two of the three modes, for different jobs.

**Interactive TUI** — what a terminal pane runs. Needs a real PTY.

```bash
grok --cwd <project-path> --no-auto-update
```

**Headless** — one prompt, then exit. This is what "Dispatch to Agent" uses when
a task does not need a visible terminal.

```bash
grok -p "<goal>" --cwd <project-path> --output-format json --no-auto-update
```

**ACP** — `grok agent stdio`, JSON-RPC over stdin/stdout, for structured status.

## Flags that matter to us

Session and location:

- `--cwd <path>` — working directory; always set it explicitly
- `-s, --session-id <uuid>` — assign a UUID to a **new** session
- `-r, --resume [<uuid>]` — resume an existing session, or the latest
- `-c, --continue` — continue the latest session for the current directory
- `--fork-session` — branch instead of reusing the session id when resuming

Headless output:

- `-p, --single <prompt>` — send one prompt and exit
- `--output-format plain | json | streaming-json`
- `--json-schema <schema>` — constrain headless output to a schema
- `-m, --model <model>`

Permissions:

- `--always-approve` — auto-approve tool execution; must stay user-controlled
- permission modes include `acceptEdits`, `bypassPermissions`, and `plan`
- `--allow '<tool>'` filters, for example `--allow 'Bash(git *)'`

Worktrees:

- `-w, --worktree[=<name>]` — start in a new git worktree
- `--ref <ref>` — branch, tag, or commit to base the worktree on
- `grok worktree list | show <id> | rm <id> [--dry-run] | gc [--max-age 7d]`

Terminal presentation:

- `--no-alt-screen` — run inline instead of taking over the alternate screen
- `--minimal` / `--fullscreen`

Housekeeping:

- `--no-auto-update`
- `grok sessions list | search <query> | delete <id>`, `grok export <id>`

Headless sessions are stored in `~/.grok/sessions`.

## What Phase 1 settled

Confirmed against `grok 1.0.4` running inside a GrokSpace pane:

- The interactive TUI needs a genuine pty; a pipe will not do. GrokSpace uses
  `portable-pty` 0.9 behind [`src-tauri/src/pty.rs`](../src-tauri/src/pty.rs).
  `tauri-plugin-pty` exists on crates.io (0.3.1, targets `tauri ^2`) and wraps
  the same crate, but publishes no JavaScript binding, so it buys little over
  calling `portable-pty` directly.
- The alternate screen does not fight xterm.js. `--no-alt-screen` was not
  needed and is not passed; the full TUI renders in a pane as-is.
- The installer puts the binary at `~/.grok/bin/grok` and appends that directory
  to the shell profile. A macOS app launched from Finder never reads that
  profile, so the launcher resolves `grok` from `PATH` *and* from `~/.grok/bin`,
  `~/.local/bin`, `/usr/local/bin`, and `/opt/homebrew/bin`.
- An unauthenticated `grok` starts normally and renders its device-code sign-in
  screen, so a missing login is not an error GrokSpace has to special-case.

## Skills, and why GrokSpace adds no flags

Grok discovers skills — a directory holding a `SKILL.md` with YAML frontmatter —
from `./.grok/skills/` (walked up to the repo root), `~/.grok/skills/`, enabled
plugins, and any extra `[skills] paths` in `~/.grok/config.toml`. They are read at
session start, so a skill installed mid-session is picked up by the next one.

That is how GrokSpace asks agents to report their graphs: it installs its own
skill into `~/.grok/skills/grokspace-graph/`, which leaves the user's repository
untouched and works for every project. See
[`docs/graph-engineering.md`](graph-engineering.md).

Two tidier-looking alternatives were rejected:

- **`--rules "<text>"`** (alias `--append-system-prompt`) would state the contract
  per session without any file on disk. But every flag GrokSpace adds is a way for
  a terminal to fail to start on a `grok` that does not recognise it, and a
  terminal that will not start is a worse failure than a graph that never appears.
- **`GROK_CONFIG='{"skills":{"paths":[…]}}'`** would point `grok` at a skill
  inside `~/.grokspace` instead of `~/.grok`. It is an undocumented shape to
  depend on for a feature this small, and a malformed overlay would again cost the
  terminal rather than the graph.

## Notes for later phases

- A dispatched headless run should capture `sessionId` from
  `--output-format json` and persist it on the `sessions` row, so the session
  can later be resumed or exported.
- Session status in Phase 1 is only `running` or `stopped`. Distinguishing
  `idle` from `needs_input` needs `grok agent stdio` and its `session/update`
  events; the `sessions` table already has the column for it.
