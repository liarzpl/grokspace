# Contributing

GrokSpace is a Tauri 2 + React + Rust app. Frontend lives in `src/`, backend in `src-tauri/`.

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

cd src-tauri
cargo test
cargo clippy --all-targets -- -D warnings
cargo fmt --check
```

## Pull requests

- CI green on the checks above.
- No secrets. Never commit `.env` files, `XAI_API_KEY`, or Apple signing material.
- If the change is user-facing, update the README.

## Hard rules

- Do **not** pass `--always-approve` to `grok`. Permission prompts are the only thing `needs_input` can mean.
- Do **not** replace the hand-written ACP messages with the `agent-client-protocol` crate. The crate is on 2.0; Grok speaks ACP v1.
- Driving ACP against a real `grok` needs a subscription and an interactive `grok login`. CI does not have that.

## Further reading

- [`docs/grok-cli-integration.md`](docs/grok-cli-integration.md) — CLI flags, ACP, and what must not be passed
- [`docs/graph-engineering.md`](docs/graph-engineering.md) — graph file contract, watcher filters, hand test
- [`docs/skill-merge.md`](docs/skill-merge.md) — how the bundled graph skill was merged with the hand-written one
- [`docs/releasing.md`](docs/releasing.md) — signed, notarized `.dmg` (unproven until the first tagged run)
