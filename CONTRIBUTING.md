# Contributing

GrokSpace is a Tauri 2 + React + Rust app. Frontend lives in `src/`, backend in `src-tauri/`.

## Run it

**Requirements**

- Node.js 20+ and npm
- Rust 1.85+ (`rustup toolchain install stable`)
- On macOS: Xcode Command Line Tools (`xcode-select --install`)
- The [`grok` CLI](https://docs.x.ai/build) — needed to drive agents, not to compile or run the CI checks

```bash
npm install
npm run tauri:dev
```

`npm run tauri:build` produces a release build, and a `.dmg` on macOS.

The checks [CI](.github/workflows/ci.yml) runs on every pull request:

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
- [`docs/releasing.md`](docs/releasing.md) — signed, notarized `.dmg` (unproven until the first tagged run)
