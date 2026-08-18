# Merging the two graph skills

Two skills were installed side by side on the machine GrokSpace is built for, both
telling Grok to write execution graphs, both claiming the same triggers. This records
what each one contributed, every conflict, and which side won.

Kept because the losing side's reasoning was often good, and a later change that
reverses one of these should know what it is reversing.

## What was on the machine

| | `graph-engineering` | `grokspace-graph` |
| --- | --- | --- |
| Origin | Written by hand, outside the app | Bundled by GrokSpace |
| Size | 4.8 KB runbook, plus 4.7 KB and 13.7 KB of references | One 4.1 KB file |
| Strength | Topology engineering: a decision tree, T0–T9, job-shaped recipes, fail-closed joins, anti-patterns | The contract for the file GrokSpace actually watches |
| Weakness | Wrote to a path GrokSpace does not watch | No opinion on whether the work deserved a graph at all |

Both were in `~/.grok/skills/`, so both loaded, and the agent applied both at once:
one for the topology and one for the file. That is how a machine ended up with two
`current-graph.json` files in two roots, a session file that was never written, and a
third file in a hybrid of the two styles.

**The schemas were identical.** Same top-level keys, same eight node types, same five
node statuses, same four edge types, the same six `data` fields, the same `state`
object. So nothing had to be converted. Everything below is about where to write, how
often, and what to put in a field when the answer is nothing.

## The bug, as opposed to the disagreements

`graph-engineering` resolved its path to a fixed `current-graph.json`. GrokSpace names
a session's graph after the session, watches for exactly that name, and exports it as
`GROKSPACE_GRAPH_FILE`. So an agent following that skill *correctly* wrote a file
nothing was watching, and the panel stayed empty for the whole run while the graph was
updated faithfully a few directories away.

Nothing warned about it. Two things made it silent:

- The skill never mentioned `GROKSPACE_GRAPH_FILE`, so there was no clue in the text
  that a session might have been told where to write.
- GrokSpace derives a session id from a graph file's name, so `current-graph.json`
  arrived as an event about a session called `current-graph`. The guard added in Phase
  1 — ignore events for sessions that are not open — discarded it. Correct behaviour,
  and it meant the mistake produced no symptom at all beyond nothing appearing.

The merged contract forbids that filename outright whenever `GROKSPACE_GRAPH_FILE` is
set, and a test asserts the sentence. The fallback is still documented, because the
skill should keep working outside GrokSpace, so its absence could not be the guard.

## Every conflict

| | `graph-engineering` said | `grokspace-graph` said | Merged | Why |
| --- | --- | --- | --- | --- |
| Path | `current-graph.json`, project root by `git rev-parse` | `$GROKSPACE_GRAPH_FILE` | `$GROKSPACE_GRAPH_FILE`, then the session-id path, then `current-graph.json` outside GrokSpace only | Only one of these is watched. See above. |
| Write cadence | At layer joins, the human gate, and the end. Explicitly not when a worker starts | Every node start and finish | Every node start and finish | A panel that moves only at layer boundaries looks stuck for minutes. Grok's own account of using both said it already drops the joins-only rule "whenever I remember the panel exists", so this codifies what happens rather than what was written. |
| First write | Every node `pending` | Not stated; the example showed work already done | Orchestrator `running`, the rest `pending` | The orchestrator wrote the file, so it is running. Grok reported never following the all-pending rule, and the real files on disk agreed. |
| Node positions | Required, `x = 80 + layer*280`, `y = 80 + sibling*140` | Optional, columns of 260 and rows of 120, and "omit rather than give every node the same one" | Omit them | Two grids meant a file's layout depended on which document was read last. The app lays out by longest-path layering, which can see how many nodes landed in a column; a formula in a prompt cannot. `parseGraph` no longer warns about an absent position, since that is now the instruction. |
| Graph id | `ge-<compact UTC>-<slug>` | Free-form | `ge-<compact UTC>-<slug>` | Sortable and self-describing, at no cost. |
| `topology` | `T0`–`T9` or a compose name | A prose arrow chain | Either; the catalogue's names where one fits | The field is free text either way, and a run that is not one of T0–T9 should say what it is. |
| `role` | A closed list of seven | An example using `planner`, which is not in that list | An open string, with the seven as suggestions | The list was already violated by the real output on that machine — `planner`, `scout`, `fan-out` — and the parser never enforced it. A rule reality breaks is worse than no rule. |
| `effort` | `xhigh` / `high` / `medium` / `""` | An example using `high` | An open string | Same. Real files used `low`, which the closed list forbade. |
| `data` keys | All six always, `""` / `0` / `false` when unused | Only what applies | All six always | Two versions of the file stay diffable, which is most of debugging a graph that went wrong. Empty strings read as absent in the panel, so nothing shows a blank row. |
| `parallelism` on a non-group | `0` | An example using `1` | `0` | A single node has no parallelism. `1` reads as a fact and means nothing. |
| `animated` on an edge | Fan-out edges are animated | Animated means work in flight | Work in flight | Both were defensible, and it can only be one. Aliveness is the more useful signal, and a permanently animated fan-out spends it on nothing. |
| Timestamps | `YYYY-MM-DDTHH:MM:SSZ` | Example with milliseconds | `YYYY-MM-DDTHH:MM:SSZ`, UTC, and `updatedAt` never before `createdAt` | A real file had `updatedAt` earlier than `createdAt` — local time written with a `Z`. Worth a rule of its own since it is invisible until someone sorts by it. |
| ASCII topology and a markdown contract | Required alongside the JSON | Not mentioned | Not required | Grok reported never producing them. A rule nobody follows costs attention and buys nothing. |
| Threshold for having a graph at all | A decision tree, then a napkin test | "More than a couple of steps" | The decision tree | The two thresholds contradicted each other, and Grok reported over-graphing as a result. The catalogue's version has reasoning behind it. |

## Dropped

- **The Hermes and Claude comparison columns.** Real knowledge, but a skill installed
  by GrokSpace runs inside GrokSpace, where a Hermes primitive can never apply, and
  every line in a skill is context spent. The original file is untouched on the
  machine it came from.
- **`/graph-engineering` as a trigger phrase.** The installed directory is
  `grokspace-graph`, so the slash command follows the directory. Every other trigger
  from both skills is in the merged description, including the Turkish ones.

## Kept, unchanged

The decision tree, the T0–T9 atoms, the job recipes, the primitives table, the worker
prompt skeleton, and the anti-patterns are the hand-written skill's, near enough
verbatim. They are the half GrokSpace's own skill did not have: it knew how to draw a
graph and had no opinion on whether the work deserved one.

## Refined after a first real run

Grok was asked, on the machine both skills came from, what it would still deviate from
once the merged contract was installed. Two of its answers were right, and the contract
changed rather than the answer:

- **The cadence rule needed a sense of proportion.** "Write on every node start and
  finish" is about a panel being watched. A sequential job that finishes in twenty
  seconds was never watched mid-flight, and fourteen atomic writes in that time is
  bookkeeping nobody reads. The rule now says so, and says to assume you are being
  watched when unsure — otherwise it was a rule that would be quietly broken on every
  small job, which is how a contract loses its authority over the large ones.
- **The trigger conditions read as a threshold for building a graph.** The description
  said to use the skill when work has "more than a couple of steps", while the catalogue
  said to stay with one loop unless three parallel lanes can be drawn. Loading the skill
  and deciding to build a graph are different decisions, and the description now says
  which one it is.

Both had survived the merge because they came from opposite sides of it: the cadence from
GrokSpace's skill, the napkin test from the hand-written one.

## What the merge does not fix

- **`grokspace-memory` is not installed on that machine**, though
  `GROKSPACE_MEMORY_FILE` is exported for every session. Grok cannot follow a skill
  the host did not install, so the memory panel's contents were being ignored — not
  through any fault in the skill. Installing it is one button in the Memory panel, or
  one command in the palette.
- **"Workers never write this file" cannot be enforced across turns.** Each turn is a
  new orchestrator, and it overwrites. Single-writer is a convention within a run, and
  the merged contract says so rather than implying a guarantee.
