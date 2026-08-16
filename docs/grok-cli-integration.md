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

## Notes for Phase 1

- The interactive TUI needs a genuine PTY; a plain pipe will not do. Plan on
  `portable-pty` 0.9 behind our own `pty_manager.rs`, wired to Tauri events.
  `tauri-plugin-pty` exists on crates.io (0.3.1, targets `tauri ^2`) and wraps
  the same crate, but it publishes no JavaScript binding, so it buys us little
  over calling `portable-pty` directly.
- `--no-alt-screen` is the escape hatch if the alternate screen fights xterm.js,
  at the cost of the full TUI. Try the default first.
- A dispatched headless run should capture `sessionId` from
  `--output-format json` and persist it on the `sessions` row, so the session
  can later be resumed or exported.
