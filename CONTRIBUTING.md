# Contributing

GrokSpace is a Tauri 2 + React + Rust app. Frontend lives in `src/`, backend in `src-tauri/`.

Everyone taking part agrees to the [Code of Conduct](CODE_OF_CONDUCT.md). It names the private channel for reports.

## Where to start

- Issues labelled [`good first issue`](https://github.com/liarzpl/grokspace/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) are small, self-contained, and need nothing beyond the setup below. [`help wanted`](https://github.com/liarzpl/grokspace/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22) is the next tier; anything also labelled `macOS` needs a Mac to verify.
- Comment on the issue before you start so two people do not pick the same one. If the list is empty, the [README Roadmap](README.md#roadmap) says what is next; a docs fix or a missing test does not need an issue at all.
- Not sure the change is wanted? Open an issue describing it first. A short note saves a PR that goes the wrong way.

## Run it

Follow [README Getting started](README.md#getting-started) for install details.

**Requirements**

- Node.js 20.19+ or 22.12+ and npm (`engines` matches Vite)
- Rust 1.88+ (`rustup toolchain install 1.88`; `rust-toolchain.toml` pins this channel)
- On macOS: Xcode Command Line Tools (`xcode-select --install`)
- The [`grok` CLI](https://docs.x.ai/build) — needed to drive agents, not to compile or run the CI checks

```bash
npm ci
npm run tauri:dev
```

Use `npm ci` so the lockfile matches CI. `npm install` can resolve newer
caret versions and rewrite `package-lock.json`.

`npm run tauri:build` produces a release build, and a `.dmg` on macOS.

On Ubuntu, install the same WebKitGTK packages [CI](.github/workflows/ci.yml) installs. Tauri will not compile without them — even `cargo test` needs this block:

```bash
sudo apt-get update
sudo apt-get install -y \
  build-essential \
  libayatana-appindicator3-dev \
  libgtk-3-dev \
  librsvg2-dev \
  libssl-dev \
  libwebkit2gtk-4.1-dev \
  libxdo-dev \
  patchelf
```

Linux compiles and is what CI runs on. The Overlay title bar and traffic-light drag are macOS-only; on Linux you get ordinary window decorations plus the in-app title bar, and the space reserved for the traffic lights is empty. See [README Platform notes](README.md#platform-notes).

The checks CI runs on every pull request:

```bash
npm run build          # type-check the frontend and build it
npm test              # frontend tests (Vitest)
npm run test:e2e       # TEST-002: fixture folder, shell pane, graph:demo → Graph
                       # Skips a WebView/Playwright pass if this machine has no display.

cd src-tauri
cargo test
cargo clippy --all-targets -- -D warnings
cargo fmt --check
```

## Pull requests

- CI green on the checks above.
- No secrets. Never commit `.env` files, `XAI_API_KEY`, or Apple signing material.
- If the change is user-facing, update the README.

### Branches

Branch from `main`, one change per branch, named `type/short-slug` (`fix/diff-stale-body`, `docs/ipc-events`). Agent-authored branches in this repository use `cursor/<slug>-<id>`; either form is fine. Contributors without push access work from a fork.

### Commit subjects

Subjects follow `type(scope): summary`, matching the recent history:

- `type` is one of `feat`, `fix`, `perf`, `refactor`, `test`, `docs`, `chore`, `ci`.
- `scope` is optional: an area such as `diff`, `worktree`, `a11y`, or a backlog id such as `sec-005`.
- `summary` is imperative, lowercase after the colon, no trailing period, about 72 characters at most. A tracking id can close the line: `feat: fork a session from a graph node (FEAT-020)`.

Give the PR the same kind of title. It becomes the commit subject on `main` (see below), so it is the line that has to read well; the commits on the branch do not.

### Merging

Pull requests are squash-merged: one PR becomes one commit on `main`, with the PR title as its subject, the PR description as its body, and `(#N)` appended by GitHub. Keep a PR to one change so that commit means one thing, and open a second PR rather than stacking unrelated work. Branch commits are not preserved, so there is no need to tidy them before review; if `main` has moved, a merge or a rebase are both fine.

### AI-assisted contributions

AI-assisted contributions are welcome — much of this repository was written that way and reviewed before merge. Say so in the PR description (which tool, roughly what it did) and run the checks above yourself before opening it. You are the author of record: read the diff, be able to explain it, and answer review the same as for hand-written code. A PR nobody has read is the one thing that gets a change sent back.

## Hard rules

- Do **not** pass `--always-approve` to `grok`. Permission prompts are the only thing `needs_input` can mean.
- Do **not** replace the hand-written ACP messages with the `agent-client-protocol` crate. The crate is on 2.0; Grok speaks ACP v1.
- Driving ACP against a real `grok` needs a subscription and an interactive `grok login`. CI does not have that.

## Further reading

- [`docs/grok-cli-integration.md`](docs/grok-cli-integration.md) — CLI flags, ACP, and what must not be passed
- [`docs/graph-engineering.md`](docs/graph-engineering.md) — graph file contract, watcher filters, hand test
- [`docs/skill-merge.md`](docs/skill-merge.md) — how the bundled graph skill was merged with the hand-written one
- [`docs/releasing.md`](docs/releasing.md) — signed, notarized `.dmg` (unproven until the first tagged run)
