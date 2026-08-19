# Grok Build CLI integration

Reference notes for the `grok` CLI surface that GrokSpace drives from Phase 1
onward. Checked against the xAI Grok Build docs (`docs.x.ai/build`) and, for the
ACP section, against Grok's own published client example and the Agent Client
Protocol schema.

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

GrokSpace does **not** pass `--worktree`. Every extra flag is a way for a session
to fail to start on a `grok` that does not recognise it — the same reason graphs,
memory, and roles stay out of flags. Isolation is `git worktree add` from
[`src-tauri/src/worktree.rs`](../src-tauri/src/worktree.rs), and only for ACP
agents. A Grok pane stays on the project folder.

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

## What Phase 2 settled: ACP is not a terminal

The plan for richer session status was "use `grok agent stdio`". Reading the ACP
surface properly turned up something that reshapes it.

**An ACP agent and the interactive TUI cannot be the same process.** `grok agent
stdio` is a JSON-RPC server speaking on stdin and stdout; it does not render a TUI.
So there is no way to obtain ACP status *for a pane*, because the process in that
pane is a TUI and offers no structured channel. `--leader` looked like it might
bridge the two and does not — it shares credentials between processes, not sessions.

The consequence: `idle` and `needs_input` are only knowable for sessions GrokSpace
itself drives over ACP, which are exactly the dispatched ones. A session someone
started by hand in a pane stays `running` or `stopped`, and honestly so.

**Grok speaks ACP v1.** Its own documented client example sends
`protocolVersion: "1"` and switches on `sessionUpdate` values including
`agent_message_chunk`, `agent_thought_chunk`, `tool_call`, and `plan`. v1 has no
`state_update` — that arrived in v2 — so the four statuses come from the request
lifecycle instead, which happens to line up exactly with the column the schema
already has:

| Status | Where it comes from in ACP v1 |
| --- | --- |
| `running` | a `session/prompt` request is in flight |
| `needs_input` | a `session/request_permission` request is awaiting an answer |
| `idle` | `session/prompt` returned, carrying a `stopReason` |
| `stopped` | the process is gone |

**`--always-approve` must not be passed**, even though the Grok docs recommend it
for automation. It removes permission prompts altogether, and a permission prompt
is the only thing `needs_input` can mean.

## How dispatch works today

There are two ways a task reaches an agent, because there are two kinds of agent.

**Into a terminal.** The prompt is typed into a running `grok` pane, the way the
graph panel's "Ask for a graph" does. This is why such a prompt is flattened to one
line: a newline submits, so a multi-line prompt would arrive as several fragments.
Nothing here can tell whether the agent read it, which is the limit of the approach.

**To an ACP session.** `session/prompt` is a request, so the reply is what says the
turn is over. No carriage return, because nothing is being typed. This is the path
that makes `idle` and `needs_input` real, and an ACP session holds no pane — a full
grid is never the reason a task cannot be dispatched.

`--always-approve` is not passed to either. GrokSpace answers permission requests
from the card of the task they concern, which is only possible because they are
still being asked.

## What is not verified

The ACP path has never run against a real `grok`. It was written against the
published ACP schema and Grok's own documented client example, and its logic is
covered by tests that drive the handshake and the reader over in-memory buffers —
but no machine in this project's CI has the binary, which needs a subscription and
an interactive sign-in.

What that means in practice, for whoever runs it first:

- The handshake assumes `session/new` answers with `result.sessionId`. If Grok nests
  it differently, `start` fails with "opened a session without giving it an id",
  which is the error to look for.
- The permission reply is the ACP v1 nested result, with `optionId` taken from
  the request (`allow-once` / `reject-once` when those kinds are offered):

  ```json
  {
    "jsonrpc": "2.0",
    "id": "<the request id>",
    "result": {
      "outcome": { "outcome": "selected", "optionId": "<from the request>" }
    }
  }
  ```

  Deny is a selected reject option, not a cancelled prompt. A real agent that
  uses other option ids is already handled as long as it sets `kind`.
- Status derivation depends on a prompt's reply carrying the same id it was sent
  with, which JSON-RPC requires but only a real run proves.

The terminal path, the board, and everything either shares is verified by running
the app.

## What Phase 3 settled: where project rules could have gone, and why they did not

Grok loads `AGENTS.md` and every `*.md` under `.grok/rules/` into the context of
every session in that directory tree, with no flag and no skill. For shared project
memory that looked like the whole answer, and one line of Grok's own documentation
rules it out:

> Files ignored by `.gitignore` are skipped.

So a memory file GrokSpace wrote there has two fates and both are bad. Not ignored,
and it lands in the user's git history — GrokSpace writing commits for them. Ignored,
and Grok never reads it, so the memory silently does nothing. A feature that
silently does nothing is worse than one that asks to be installed.

Memory therefore uses the same shape the graphs already proved: a file whose path is
handed to the session in the environment, and a bundled skill that teaches the agent
to read it. `GROKSPACE_MEMORY_FILE` joins the graph variables, and unlike them it is
the same for every session in a project, because the memory is what they share.

Grok has two features with similar names that are **not** this, and should not be
wired to it:

- **`--experimental-memory`** is an agent's own recollection across its sessions,
  appended with `/memory`. GrokSpace's memory is curated by a person and read by
  every agent.
- **Subagents** are parallel children Grok spawns inside one session. GrokSpace's
  sessions are the ones the user can see and stop.

## How a role reaches an agent

A role's brief is the first thing its session is asked. `--rules` (alias
`--append-system-prompt`) would put it in the system prompt, which is the better
place for it, and it is not used for two reasons:

- Every flag GrokSpace adds is a way for a session to fail to start on a `grok` that
  does not recognise it. That is the same reasoning that kept the graph contract in a
  skill rather than a flag.
- The documented options for `grok agent` are `-m`, `--always-approve`, `--reauth`,
  and `--agent-profile`. `--rules` is not among them, so it would not reach the ACP
  sessions a swarm is made of — and those are the ones that most need a role.

A prompt works identically for a terminal and an ACP session, cannot stop either
starting, and can be tested by asserting what was sent. The brief is flattened to one
line for the same reason a dispatched task is, and it names `$GROKSPACE_MEMORY_FILE`
rather than pasting the memory, so its length does not grow with the project.

`--agent-profile` remains the untried option worth knowing about: it is designed for
custom agent definitions and does work in agent mode. It was not used because its
file format is undocumented in what is published, and a role that is a paragraph does
not need a format.

## What Phase 5 settled: isolation without a grok flag

Per-session diffs needed each agent in its own checkout. `sessions.worktree_path`
had been reserved since migration `0001`. Two ways to fill it were on the table
and one was refused:

- **`grok --worktree=`** is a flag, and this project has already twice refused to
  add flags that a slightly older `grok` would not recognise. A session that will
  not start is a worse failure than an agent that shares the project tree.
- **`git worktree add`**, from GrokSpace, with cwd pointed at the new tree. The
  process still starts if git is missing or the folder is not a repository; it
  just does not isolate.

The tree is a clean `HEAD`. An agent does not see the human's uncommitted files.
Graphs, steps, and memory stay under the project via absolute environment
variables, which is why those paths were made absolute in the first place.

Merge commits leftover files on the session branch, then `git merge`s into the
project. Idle review moves `in_progress` cards to `review` unless the step list
is still `proposed` (the Approve gate). A selected hunk plus a sentence is a
`session/prompt`. A graph file artifact opens in the Diff panel.

## Notes for later phases

- A dispatched headless run should capture `sessionId` from
  `--output-format json` and persist it on the `sessions` row, so the session
  can later be resumed or exported.
- `--agent-profile` remains the untried option for roles; a paragraph of brief
  was enough for Phase 3.
