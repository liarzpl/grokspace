# Security

## Reporting a vulnerability

Report vulnerabilities through [GitHub Security Advisories](https://github.com/liarzpl/grokspace/security/advisories/new). That is the preferred channel so the report stays private until a fix is ready.

Do not open a public issue for a vulnerability.

A useful report names the surface from [Scope](#scope), the GrokSpace commit (`git rev-parse HEAD`) or tag, the macOS version, and — for anything an agent triggered — the ACP messages or the `~/.grokspace/logs/grokspace.log` lines around it, with any key or token removed.

## Supported versions

| Version | Supported |
| --- | --- |
| `main` | Yes. Fixes land here first. |
| Latest `v0.x` tag | Yes, once the first tag exists. There is none yet: the app is built from source, so today `main` is the only release ([Roadmap](README.md#roadmap)). |
| Older `v0.x` tags | No. Move to the latest tag or build `main`. |

## What to expect

GrokSpace has a solo maintainer and no security team, so these are intentions rather than a service-level agreement:

- I aim to acknowledge a report within 7 days of it reaching the advisory.
- Triage happens in the advisory thread: whether it is in [scope](#scope), how severe it looks, and whether a fix is planned.
- Fixes land on `main` first. Until there is a tagged release, "fixed" means "merged to `main`"; building from source picks it up.
- The advisory is published once the fix is on `main` (or in a tag), or earlier if we agree to that. Please leave time for a fix before disclosing publicly.
- You get credit in the published advisory if you want it; say so in the report.

## Scope

GrokSpace is a local desktop app that runs as the user, with no server side and no network code in the host: [`Cargo.toml`](src-tauri/Cargo.toml) has no HTTP crate, and the ledger and snooze writers assert in their tests that they stay that way. The Rust host in `src-tauri/` spawns processes, drives agents over stdio, and touches the user's git repository; the React renderer reaches it only through the Tauri commands listed in [`docs/ipc.md`](docs/ipc.md). The host trusts the user and the `grok` binary it resolves. It does **not** trust what an agent sends over ACP, files under `<project>/.grokspace/`, or a project folder the user has not marked trusted.

Reports about these boundaries are in scope:

| Surface | Where | In scope |
| --- | --- | --- |
| **Pty spawn** | [`pty.rs`](src-tauri/src/pty.rs), [`program.rs`](src-tauri/src/program.rs), [`session/start.rs`](src-tauri/src/session/start.rs) | A pane or agent running a binary other than the `grok` or shell resolved from `PATH` and the well-known install directories; a project file or an agent message that can change the argv, cwd, or environment a session is spawned with; a flag from the must-not-pass list in [`docs/grok-cli-integration.md`](docs/grok-cli-integration.md) being passed |
| **ACP stdio JSON-RPC** | [`acp/`](src-tauri/src/acp) | A `grok agent stdio` peer — or anything that can write to its stdout — crashing the host, faking `idle` or `needs_input`, or receiving a permission reply the user never gave; a reply carrying an `optionId` other than the one the user picked |
| **Permission gate** | [`acp/protocol.rs`](src-tauri/src/acp/protocol.rs), [`policy.rs`](src-tauri/src/policy.rs), [`ledger.rs`](src-tauri/src/ledger.rs), [`PermissionActions.tsx`](src/components/PermissionActions.tsx) | Any path where Allow becomes `allow_always`; a session lease that widens past the edit-class it was granted for (`*` and Bash are refused); a policy Deny that gets overridden; a permission mode reaching `session/new` or `grok agent`; a chip that shows one request while the agent gets another |
| **Worktree merge** | [`worktree.rs`](src-tauri/src/worktree.rs), [`session/worktree_cmds.rs`](src-tauri/src/session/worktree_cmds.rs) | `worktreeinclude` or `worktree-setup` reaching outside the project (`**`, `..`, absolute paths, anything that resolves outside it); setup running for an untrusted folder or with the Settings toggle off; Close, Discard, or Merge touching a tree or branch other than the session's own, or rewriting project history (Merge is a plain `git merge`; conflicts abort) |
| **`~/.grokspace` file permissions** | [`db.rs`](src-tauri/src/db.rs) and everything that writes under `~/.grokspace/` | The directory ending up looser than `0o700`, or `grokspace.db` looser than `0o600`, on a fresh or an existing install; a ledger, log, policy, or snooze file that can be made to hold a secret; the host writing anywhere other than `~/.grokspace/`, `<project>/.grokspace/`, `~/.grok/skills/` (skills you install), a folder you picked in a native dialog, and the session's worktree and branch |

Anything else in this repository is welcome too — the IPC surface, the CSP in [`tauri.conf.json`](src-tauri/tauri.conf.json), the CI and release workflows. The table names the places where a mistake matters most.

### Out of scope

- **`grok` itself** — the CLI, its ACP server, its model, and what it does once a permission is granted. GrokSpace launches it and relays its requests; report the binary's own bugs to xAI, not here.
- **Upstream dependencies** — Tauri, WebKit, `portable-pty`, xterm.js, `rusqlite`, and the rest of `Cargo.lock` / `package-lock.json`. Report to the upstream project. A GrokSpace advisory is only warranted if this app uses the dependency unsafely, or a fix needs a bump here that Dependabot has not opened.
- **An agent using a permission the user granted.** An agent that was Allowed to run a command and ran it is the model working as designed. It becomes in scope when the chip showed one request and the agent got another.
- **Anyone already running code as your user.** GrokSpace has no privilege boundary of its own; that account can read `~/.grokspace` regardless. Reports about *other* local users are the file-permission row above.
- **Denial of service against your own machine** — a runaway agent filling the disk, a pane that hangs. Those are bugs; open an issue.
- **An unsigned `.dmg` you built yourself.** There is no signed or notarized release yet; the README says so.

**What the Scorecard badge counts.** The OpenSSF Scorecard *Vulnerabilities* check behind the README badge and the Security tab counts every [OSV](https://osv.dev) entry matching `Cargo.lock` or `package-lock.json`, and RustSec files *unmaintained* notices there next to real vulnerabilities. At the first run (2026-09-19) all seven findings sit in Tauri 2's own tree and none is fixable from this repository: the five `unic-*` crates behind `urlpattern` and `proc-macro-error` behind `glib-macros` are unmaintained notices, not exploitable bugs, and `glib` 0.18 (RUSTSEC-2024-0429) is Linux-only code that a macOS build never compiles — Tauri 3 drops all of them. The `audit` CI job is the verdict that matters: `cargo audit` fails on vulnerabilities and unsound advisories and only warns on unmaintained crates, [`src-tauri/.cargo/audit.toml`](src-tauri/.cargo/audit.toml) lists every ignored advisory with its reason, and `npm audit` is clean on both the runtime and the dev tree.

## Secrets

Never commit:

- `XAI_API_KEY`
- Apple signing and notarization secrets (`APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`)
- `.env` or `.env.*` files (they are gitignored)

[`.env.example`](.env.example) names the optional key. Copying it to `.env` does **not** load it: there is no dotenv crate and no Tauri env plugin. Vite only injects `VITE_` / `TAURI_ENV_*` into the frontend, not into Rust. `acp.rs` reads `std::env::var("XAI_API_KEY")` from the process environment.

For `npm run tauri:dev`, export the key in the same shell:

```bash
export XAI_API_KEY=…
npm run tauri:dev
```

A packaged `.app` launched from Finder does not see a source-tree `.env`. Put the key in the user environment, or use `grok login`. Leave the key unset to use the cached token. Do not put real keys in the example.
