# Changelog

All notable changes to GrokSpace are recorded in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html). No `v*` tag
has been pushed yet: `main` is the `v0.1.0` track, so everything below is unreleased.
How a tag becomes a release is in [docs/releasing.md](docs/releasing.md); the release
workflow writes its own notes and does not read this file.

The history before this file existed is backfilled from the merged pull requests,
newest first, grouped by the milestone each change landed in. A bullet usually covers
several PRs, and each milestone heading links to its commit range on GitHub.

## [Unreleased]

### Added

- `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1), reported through a private security advisory rather than a personal address ([#178](https://github.com/liarzpl/grokspace/pull/178)).
- This changelog, and a "CHANGELOG updated, or not needed" item in the pull request template.

### Changed

- CONTRIBUTING: where to start, branch naming, `type(scope): summary` commit subjects, squash merging, and how to disclose AI-assisted contributions ([#178](https://github.com/liarzpl/grokspace/pull/178)).

## [Feature wave] - 2026-09-14

Pull requests #135–#177 (43 squash merges): the attention inbox, the permission model, folder trust, and the worktree, graph, and Diff features around them.

### Added

- Attention inbox: a Needs you / Review / Merge strip ([#152](https://github.com/liarzpl/grokspace/pull/152)), keyboard triage with A/D/O/G and palette jumps to the first wait ([#154](https://github.com/liarzpl/grokspace/pull/154)), snoozing a wait for an hour or until tomorrow ([#170](https://github.com/liarzpl/grokspace/pull/170)), and an optional, default-off inbox-zero gate on dispatch ([#166](https://github.com/liarzpl/grokspace/pull/166)).
- Permission model: a session-scoped "allow similar" lease that still answers ACP with `allow_once` ([#148](https://github.com/liarzpl/grokspace/pull/148)), a `plan | ask | acceptEdits` permission-mode chip ([#153](https://github.com/liarzpl/grokspace/pull/153)), a named permission policy file in `~/.grokspace` and the project's `.grokspace/` with deny > ask > allow-once-similar precedence ([#155](https://github.com/liarzpl/grokspace/pull/155)), an append-only permission ledger under `~/.grokspace/ledgers/` replayed in Settings ([#160](https://github.com/liarzpl/grokspace/pull/160)), role capability profiles that suggest a Deny ([#171](https://github.com/liarzpl/grokspace/pull/171)), and a permission-heat sidecar with a count badge on the Graph tab ([#173](https://github.com/liarzpl/grokspace/pull/173)).
- Permission prompts explain themselves: known facts (title, doing, worktree, overlap) under the chips ([#136](https://github.com/liarzpl/grokspace/pull/136)), and identical ACP tool loops pause after five repeats ([#142](https://github.com/liarzpl/grokspace/pull/142)).
- Trust: Deny / Trust once / Trust this folder before project-supplied config is honored ([#162](https://github.com/liarzpl/grokspace/pull/162)), the trust state of project hooks in Settings ([#172](https://github.com/liarzpl/grokspace/pull/172)), and a read-only Settings list of the MCP servers `grok` will load ([#177](https://github.com/liarzpl/grokspace/pull/177)).
- Worktrees: confirmation before an agent starts on the project tree instead of an isolated worktree ([#141](https://github.com/liarzpl/grokspace/pull/141)), `.grokspace/worktreeinclude` copies listed paths into a new worktree ([#143](https://github.com/liarzpl/grokspace/pull/143)), an optional default-off setup script ([#149](https://github.com/liarzpl/grokspace/pull/149)), dry-run orphan worktree GC from Settings ([#163](https://github.com/liarzpl/grokspace/pull/163)), and Merge from the command palette ([#144](https://github.com/liarzpl/grokspace/pull/144)).
- Sessions and graphs: a Spec | Build steps chip with an Approve gate ([#145](https://github.com/liarzpl/grokspace/pull/145)) and graph node titles stamped after Build ([#150](https://github.com/liarzpl/grokspace/pull/150)); hand a live session to Coder or Reviewer ([#151](https://github.com/liarzpl/grokspace/pull/151)); Continue this job reuses the worktree ([#169](https://github.com/liarzpl/grokspace/pull/169)); fork a session from a graph node ([#175](https://github.com/liarzpl/grokspace/pull/175)); cross-session edges overlaid on the Graph tab ([#164](https://github.com/liarzpl/grokspace/pull/164)); a warning when graph nodes and step titles drift ([#168](https://github.com/liarzpl/grokspace/pull/168)); a Scout-first tripwire when a Coder dispatch overlaps another session ([#176](https://github.com/liarzpl/grokspace/pull/176)).
- Diff panel: hotspots walked before other overlaps ([#139](https://github.com/liarzpl/grokspace/pull/139)), hunk comments bundled into one follow-up for the idle agent ([#146](https://github.com/liarzpl/grokspace/pull/146)), and claimed artifact paths listed with Finder and Diff ([#147](https://github.com/liarzpl/grokspace/pull/147)).
- Memory, skills, and playbooks: Add to Memory from the transcript ([#140](https://github.com/liarzpl/grokspace/pull/140)), installed vs missing skills in the palette ([#138](https://github.com/liarzpl/grokspace/pull/138)), a skill provenance chip and Save recipe into `~/.grokspace/skills/` ([#174](https://github.com/liarzpl/grokspace/pull/174)), local playbook snapshots ([#167](https://github.com/liarzpl/grokspace/pull/167)), and Export pack for a session ([#161](https://github.com/liarzpl/grokspace/pull/161)).

### Changed

- The memory skill reads the project's committed `AGENTS.md` alongside the memory file ([#135](https://github.com/liarzpl/grokspace/pull/135)); the Diff panel names the worktree HEAD as the checkpoint ([#137](https://github.com/liarzpl/grokspace/pull/137)).
- Transcript and permission state moved into `uiStore` ([#165](https://github.com/liarzpl/grokspace/pull/165)); Channel writes and the transcript list are virtualized ([#157](https://github.com/liarzpl/grokspace/pull/157)); `list_session_graphs` and `list_project_steps` are batched IPC calls ([#159](https://github.com/liarzpl/grokspace/pull/159)).
- Tests: Session/Task serde fixtures lock the camelCase IPC shape ([#158](https://github.com/liarzpl/grokspace/pull/158)).

### Fixed

- Start is locked while sessions load, so a second click cannot start a duplicate ([#156](https://github.com/liarzpl/grokspace/pull/156)).

## [Audit wave] - 2026-09-14

Pull requests #39–#134 (95 squash merges; [#92](https://github.com/liarzpl/grokspace/pull/92) was closed unmerged and superseded by #112): the security, bug, accessibility, performance, test, dependency, and debt findings of a full audit, worked down to zero criticals.

### Security

- GitHub Actions pinned to commit SHAs with `permissions: contents: read` ([#53](https://github.com/liarzpl/grokspace/pull/53)), then bumped to checkout / setup-node / upload-artifact v7 and tauri-action v1 ([#58](https://github.com/liarzpl/grokspace/pull/58)); CI installs with `npm ci` and runs `npm audit --omit=dev` ([#44](https://github.com/liarzpl/grokspace/pull/44)).
- CSP gained `object-src`, `frame-ancestors`, and `base-uri`; `~/.grokspace` is created `0700` and its files `0600` ([#39](https://github.com/liarzpl/grokspace/pull/39)).
- Host API keys are stripped from the shell PTY environment ([#65](https://github.com/liarzpl/grokspace/pull/65)); `.grokspace/` is gitignored on a project's first write ([#76](https://github.com/liarzpl/grokspace/pull/76)).
- An ACP session that skipped isolation is recorded on its row ([#77](https://github.com/liarzpl/grokspace/pull/77)) and an unisolated start is refused unless confirmed ([#113](https://github.com/liarzpl/grokspace/pull/113)); `open_project` is dialog-only and every invoke passes an ACL check ([#93](https://github.com/liarzpl/grokspace/pull/93)).

### Fixed

- Sessions: Close refuses while the session branch is still ahead ([#79](https://github.com/liarzpl/grokspace/pull/79)); a Stopped session ignores late ACP status ([#59](https://github.com/liarzpl/grokspace/pull/59), [#68](https://github.com/liarzpl/grokspace/pull/68)); pending permissions are dropped when reconciling on start ([#70](https://github.com/liarzpl/grokspace/pull/70)) and cleared on a successful cancel ([#66](https://github.com/liarzpl/grokspace/pull/66)); permission prompts upsert by `requestId` ([#90](https://github.com/liarzpl/grokspace/pull/90)) and keep opaque JSON-RPC ids ([#88](https://github.com/liarzpl/grokspace/pull/88)); a worktree is reused only when it is a real checkout ([#75](https://github.com/liarzpl/grokspace/pull/75)); creating a pane displaces the previous occupant instead of failing ([#83](https://github.com/liarzpl/grokspace/pull/83)); merge teardown returns a `MergeOutcome` instead of an English phrase ([#73](https://github.com/liarzpl/grokspace/pull/73)).
- Board and panels: Tasks and Memory clear on project switch ([#57](https://github.com/liarzpl/grokspace/pull/57)); Diff drops stale file bodies when the selection races ([#46](https://github.com/liarzpl/grokspace/pull/46)); a tab the user already picked is not overwritten ([#50](https://github.com/liarzpl/grokspace/pull/50)); clearing a task description writes SQL `NULL` ([#54](https://github.com/liarzpl/grokspace/pull/54)); dispatch rejects unusable session ids ([#49](https://github.com/liarzpl/grokspace/pull/49)); swarm failures are surfaced and a failed briefing fails closed ([#86](https://github.com/liarzpl/grokspace/pull/86)).
- Accessibility: Forget project is visible and in the palette ([#43](https://github.com/liarzpl/grokspace/pull/43)); keyboard focus rings ([#60](https://github.com/liarzpl/grokspace/pull/60)); the palette and Settings are true modal dialogs with a focus trap and Escape ([#63](https://github.com/liarzpl/grokspace/pull/63)); chrome colors go through theme tokens at AA contrast ([#52](https://github.com/liarzpl/grokspace/pull/52)); Diff paths stay LTR ([#67](https://github.com/liarzpl/grokspace/pull/67)); `prefers-reduced-motion` is honored in terminals and graph edges ([#91](https://github.com/liarzpl/grokspace/pull/91)); keyboard graph selection with status text ([#87](https://github.com/liarzpl/grokspace/pull/87)); orphaned permission prompts announce as alerts ([#94](https://github.com/liarzpl/grokspace/pull/94)); every text field has an accessible name ([#96](https://github.com/liarzpl/grokspace/pull/96)); keyboard rename for tasks, steps, projects, and panes ([#98](https://github.com/liarzpl/grokspace/pull/98)); segmented controls expose their selected state ([#102](https://github.com/liarzpl/grokspace/pull/102)).

### Changed

- Performance: visible sessions' graphs and steps load first ([#64](https://github.com/liarzpl/grokspace/pull/64)); ACP session-update text is capped and coalesced ([#84](https://github.com/liarzpl/grokspace/pull/84)); git lookups are cached and Diff reuses porcelain ([#78](https://github.com/liarzpl/grokspace/pull/78)); permission attach uses `IN (…)` and task assignment is indexed ([#95](https://github.com/liarzpl/grokspace/pull/95)); narrower selectors and fewer React Flow node rebuilds ([#99](https://github.com/liarzpl/grokspace/pull/99), [#100](https://github.com/liarzpl/grokspace/pull/100)); Diff bodies are windowed to 400 lines ([#101](https://github.com/liarzpl/grokspace/pull/101)); terminals are disposed on project switch and watchers capped ([#104](https://github.com/liarzpl/grokspace/pull/104)); swarm roles start with bounded concurrency ([#105](https://github.com/liarzpl/grokspace/pull/105)); xterm and xyflow are lazy-split off the first paint ([#106](https://github.com/liarzpl/grokspace/pull/106)); step files are read outside the SQLite mutex ([#108](https://github.com/liarzpl/grokspace/pull/108)).
- Rust structure: `session/{db,worktree_cmds,start}.rs` ([#109](https://github.com/liarzpl/grokspace/pull/109), [#110](https://github.com/liarzpl/grokspace/pull/110), [#111](https://github.com/liarzpl/grokspace/pull/111)), `acp/{protocol,process}.rs` and `steps/{store,ingest,watch}.rs` ([#115](https://github.com/liarzpl/grokspace/pull/115), [#120](https://github.com/liarzpl/grokspace/pull/120), [#123](https://github.com/liarzpl/grokspace/pull/123), [#126](https://github.com/liarzpl/grokspace/pull/126), [#127](https://github.com/liarzpl/grokspace/pull/127)) split out of the large modules; shared domain enum lists are generated and unknown values rejected ([#103](https://github.com/liarzpl/grokspace/pull/103), [#107](https://github.com/liarzpl/grokspace/pull/107)); `OpeningTab` aliases `WorkspaceTab` ([#89](https://github.com/liarzpl/grokspace/pull/89)); `AppState::with_db` and a version sync script ([#129](https://github.com/liarzpl/grokspace/pull/129)).
- Frontend structure: pane faces and maximize live in `uiStore` ([#69](https://github.com/liarzpl/grokspace/pull/69)); backend events go through `events.ts` ([#74](https://github.com/liarzpl/grokspace/pull/74)) and agent or terminal text through `talkToSession` ([#56](https://github.com/liarzpl/grokspace/pull/56)); the pane face is named `steps` ([#47](https://github.com/liarzpl/grokspace/pull/47)); shared `StatusDot` / `QuietButton` / `TextButton` ([#130](https://github.com/liarzpl/grokspace/pull/130)); `skillStore` and `skill_status(id)` ([#131](https://github.com/liarzpl/grokspace/pull/131)); one session JSON watcher with a coalesced map ([#132](https://github.com/liarzpl/grokspace/pull/132)); store-owned watch / forget / `setError` ([#133](https://github.com/liarzpl/grokspace/pull/133)); CRUD verbs with one-release aliases ([#134](https://github.com/liarzpl/grokspace/pull/134)); `GraphDocState` / `GraphStoreState` ([#121](https://github.com/liarzpl/grokspace/pull/121)); `ProjectSettings` typed as `{ terminalLayout? }` ([#128](https://github.com/liarzpl/grokspace/pull/128)); shared PTY size, caps, and `sessionCanTakeWork` ([#124](https://github.com/liarzpl/grokspace/pull/124)).
- Tests: a jsdom + Testing Library harness covering ErrorBoundary, panes, the palette, and TaskBoard drag and drop ([#80](https://github.com/liarzpl/grokspace/pull/80), [#81](https://github.com/liarzpl/grokspace/pull/81), [#82](https://github.com/liarzpl/grokspace/pull/82)); terminal registry ([#71](https://github.com/liarzpl/grokspace/pull/71)); `Error` IPC serialization ([#72](https://github.com/liarzpl/grokspace/pull/72)); `homeRelative` ([#40](https://github.com/liarzpl/grokspace/pull/40)); host e2e smoke ([#97](https://github.com/liarzpl/grokspace/pull/97)); `AppHandle` session cleanup ([#112](https://github.com/liarzpl/grokspace/pull/112)); incremental SQLite migrations ([#117](https://github.com/liarzpl/grokspace/pull/117)); `graphTheme` tokens via a jsdom stylesheet ([#122](https://github.com/liarzpl/grokspace/pull/122)); Vitest HTML coverage published as a CI artifact ([#125](https://github.com/liarzpl/grokspace/pull/125)); `scripts/` type-checked in CI ([#41](https://github.com/liarzpl/grokspace/pull/41)).
- Dependencies: vitest locked to 4.1.11 with an in-range refresh ([#44](https://github.com/liarzpl/grokspace/pull/44)); Node engines 20.19 / 22.12 ([#51](https://github.com/liarzpl/grokspace/pull/51)); MSRV pinned to 1.88 ([#42](https://github.com/liarzpl/grokspace/pull/42)); `uuid` and `tauri-plugin-dialog` bumped in range ([#119](https://github.com/liarzpl/grokspace/pull/119)).
- Docs: README SQLite schema history ([#45](https://github.com/liarzpl/grokspace/pull/45)), the real `grok` argv ([#61](https://github.com/liarzpl/grokspace/pull/61)), how `XAI_API_KEY` is loaded ([#48](https://github.com/liarzpl/grokspace/pull/48)), the README map and skill-merge history ([#55](https://github.com/liarzpl/grokspace/pull/55)), CONTRIBUTING setup and releasing platforms ([#62](https://github.com/liarzpl/grokspace/pull/62)), the session-steps contract ([#114](https://github.com/liarzpl/grokspace/pull/114)), the IPC inventory ([#116](https://github.com/liarzpl/grokspace/pull/116)), and stale phase comments dropped ([#118](https://github.com/liarzpl/grokspace/pull/118)).
- Logging: host and renderer errors are appended to `~/.grokspace/logs/grokspace.log`; there is no telemetry ([#85](https://github.com/liarzpl/grokspace/pull/85)).

### Removed

- Unused named exports, `baseName`, `changedCount`, `roleByName`, and `SettingKey` ([#40](https://github.com/liarzpl/grokspace/pull/40)).

## [Public-readiness docs] - 2026-09-09

Pull requests #31–#36, 2026-09-08 to 2026-09-09.

### Added

- MIT license ([#31](https://github.com/liarzpl/grokspace/pull/31)); CONTRIBUTING, SECURITY, and CODEOWNERS ([#34](https://github.com/liarzpl/grokspace/pull/34)); the release pre-flight checklist in `docs/releasing.md` ([#35](https://github.com/liarzpl/grokspace/pull/35)).

### Changed

- Local `.env*` files are gitignored ([#32](https://github.com/liarzpl/grokspace/pull/32)); the README status reflects the Phase 5 merge ([#33](https://github.com/liarzpl/grokspace/pull/33)) and says this is an early public, `v0.1`-track build ([#36](https://github.com/liarzpl/grokspace/pull/36)).

## [Phase 5] - 2026-08-21

Isolation and review. Pull requests #19–#30, 2026-08-20 to 2026-08-21.

### Added

- Per-session git worktrees: ACP agents start in their own worktree, the Diff panel reads that tree, Close refuses dirty work, and Discard reverts the checkpoint ([#19](https://github.com/liarzpl/grokspace/pull/19)); Merge lands the branch on the project, an assigned card moves to review when the agent goes idle, hunk comments become a prompt, and a graph node's path opens in Diff ([#20](https://github.com/liarzpl/grokspace/pull/20)).
- Follow-ups: the Diff panel shows when an agent did not isolate ([#24](https://github.com/liarzpl/grokspace/pull/24)) and merge refusals before the click ([#25](https://github.com/liarzpl/grokspace/pull/25)); a warning when session worktrees overlap a path ([#29](https://github.com/liarzpl/grokspace/pull/29)); named permission chips, and Allow can never pick `allow_always` ([#26](https://github.com/liarzpl/grokspace/pull/26)); one-click install of the graph, memory, and steps skills from the palette ([#27](https://github.com/liarzpl/grokspace/pull/27)); inline edit of a task description on the board card ([#23](https://github.com/liarzpl/grokspace/pull/23)); a dock badge and one bounce for an unfocused `needs_input` ([#30](https://github.com/liarzpl/grokspace/pull/30)).

### Fixed

- ACP `initialize` sends `protocolVersion` as the integer `1` with `clientInfo` ([#22](https://github.com/liarzpl/grokspace/pull/22)); ACP `authenticate` fails closed with a `grok login` hint instead of hanging on a device code ([#28](https://github.com/liarzpl/grokspace/pull/28)); a blank window caused by the height chain and a React 19 selector loop ([#21](https://github.com/liarzpl/grokspace/pull/21)).

## [Phase 4] - 2026-08-19

Polish and distribution. Pull requests #11–#18, 2026-08-17 to 2026-08-19.

### Added

- Command palette, Settings, and the Diff panel ([#11](https://github.com/liarzpl/grokspace/pull/11)).
- A tag-driven release workflow that builds a universal macOS `.dmg`, signs and notarizes it when Apple secrets exist, and attaches it to a draft release ([#12](https://github.com/liarzpl/grokspace/pull/12)); the bundled graph skill merged with the hand-written one, recorded in `docs/skill-merge.md` ([#13](https://github.com/liarzpl/grokspace/pull/13)). Both were stacked PRs and reached `main` through [#14](https://github.com/liarzpl/grokspace/pull/14).
- ACP transcripts in the session pane ([#17](https://github.com/liarzpl/grokspace/pull/17)); session steps beside the project board ([#18](https://github.com/liarzpl/grokspace/pull/18)).

### Fixed

- Audit findings: ACP v1 permission handling, killing a hung handshake, and agent lifecycle ([3f07aad](https://github.com/liarzpl/grokspace/commit/3f07aad), [#15](https://github.com/liarzpl/grokspace/pull/15)); verified ACP, permission, diff, and store bugs ([#16](https://github.com/liarzpl/grokspace/pull/16)); terminals detach on project switch ([#17](https://github.com/liarzpl/grokspace/pull/17)); the Overlay title bar can drag the window ([b7e309c](https://github.com/liarzpl/grokspace/commit/b7e309c)).

## [Phase 3] - 2026-08-17

Memory and roles. Pull requests #9–#10.

### Added

- Shared project memory that agents actually read ([#9](https://github.com/liarzpl/grokspace/pull/9)); role presets, and launching a swarm of them ([#10](https://github.com/liarzpl/grokspace/pull/10)).

## [Phase 2] - 2026-08-17

Kanban and dispatch. Pull requests #5–#7.

### Added

- The task board, and dispatching a task to an agent ([#6](https://github.com/liarzpl/grokspace/pull/6)); agents driven over ACP that report what they are doing ([#7](https://github.com/liarzpl/grokspace/pull/7)).
- A CI gate, together with the remaining live-graph hardening ([#5](https://github.com/liarzpl/grokspace/pull/5)).

## [Phases 0–1] - 2026-08-17

Foundation and terminal core. The first commits, 2026-08-16 to 2026-08-17, mostly before pull requests were used.

### Added

- Phase 0: the Tauri shell, the SQLite store, and project CRUD ([f0f01c0](https://github.com/liarzpl/grokspace/commit/f0f01c0)), with docs and icon artwork ([3486caf](https://github.com/liarzpl/grokspace/commit/3486caf)).
- Phase 1: pty-backed terminal sessions ([1f9452f](https://github.com/liarzpl/grokspace/commit/1f9452f)), xterm panes and the terminal grid ([acabdf2](https://github.com/liarzpl/grokspace/commit/acabdf2)), honest reporting of signalled exits ([5702385](https://github.com/liarzpl/grokspace/commit/5702385)), a React Flow graph canvas ([870a845](https://github.com/liarzpl/grokspace/commit/870a845)) with minimap, zoom, and control fixes ([f38a8e1](https://github.com/liarzpl/grokspace/commit/f38a8e1)), terminals repainted on re-attach ([fe9648e](https://github.com/liarzpl/grokspace/commit/fe9648e)), and a live graph per session ([#1](https://github.com/liarzpl/grokspace/pull/1)) with refresh, retry, and closed-session leak fixes ([#3](https://github.com/liarzpl/grokspace/pull/3)).

[Unreleased]: https://github.com/liarzpl/grokspace/compare/8968fff...HEAD
[Feature wave]: https://github.com/liarzpl/grokspace/compare/76e4950...8968fff
[Audit wave]: https://github.com/liarzpl/grokspace/compare/0cbefe1...76e4950
[Public-readiness docs]: https://github.com/liarzpl/grokspace/compare/9a0a4f5...0cbefe1
[Phase 5]: https://github.com/liarzpl/grokspace/compare/074f5ab...9a0a4f5
[Phase 4]: https://github.com/liarzpl/grokspace/compare/e28f9d8...074f5ab
[Phase 3]: https://github.com/liarzpl/grokspace/compare/0f23869...e28f9d8
[Phase 2]: https://github.com/liarzpl/grokspace/compare/62d6985...0f23869
[Phases 0–1]: https://github.com/liarzpl/grokspace/commits/62d6985
