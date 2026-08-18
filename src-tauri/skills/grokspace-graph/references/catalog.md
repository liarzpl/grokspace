# Topology catalogue

Which shape the work deserves. Read this before choosing; the answer is usually T0.

The graph file itself is `graph-file.md`.

## Decision

```
Tek iş + net test/log verifier + sıralı?
  EVET → T0
  HAYIR ↓
Bağımsız parçalara bölünüyor mu?
  HAYIR → T0 + yüksek effort
  EVET ↓
Tek ajan zaten yeterince iyi, ya da 5 dakikada bitiyor?
  EVET → T0 (graph ekleme)
  HAYIR ↓
Parçalar birbirinin taslağını görmeli mi?
  EVET → T1 veya T5. Peer draft yok.
  HAYIR → T3
Yüksek stake / birden fazla makul çözüm?
  EVET → T4 Arena
  HAYIR → T5
Her hafta aynı iş? → adlandırılmış workflow
  değilse → orchestrator + spawn
```

Napkin test: if you cannot draw three clean parallel lanes, stay T0.

## Atoms

**T0 loop** — `Goal → Act → Verify(deterministic) → Pass? → Done`, else back to Act,
capped at three attempts. Bugs, small features, sequential code. One session and a test.

**T1 chain with gates** — `A → gate? → B → gate? → C`. The gate is code or a test, not
"looks good to me".

**T2 router** — `In → Classify → cheap | hard | human`. High effort only on the hard
path.

**T3 fan-out** — `Decompose(deterministic) → [W1 | W2 | W3] → Join → Synthesize`. The
list is made by a script. Workers are isolated. The join is fail-closed.

```rhai
phase("Fanout");
let jobs = [];
for d in dimensions {
    jobs.push(#{
        prompt: "READ-ONLY. Use grep/read_file. Lane: " + d
            + ". {claims:[], evidence:[]}. Empty only after you searched.",
        label: d,
        capability_mode: "read-only",
        output_schema: claim_schema,
    });
}
let results = parallel(jobs);
```

**T4 Arena** — `Same spec → [A1 | A2 | A3] in worktrees → Judge(rubric, evidence) →
Winner`. Two or three producers. The judge inherits no producer context. No equal-weight
merge.

**T5 supervisor** — `Lead(plan, scale) → specialists → synthesize → maybe a second
wave`. The lead writes the objective, the format, the tools, the bounds, and the
will-nots. Depth 1.

**T6 evaluate and optimise** — `Producer → independent evaluator → pass? else gaps →
Producer`, capped at two or three rounds.

**T7 pipeline** — `Research → Draft → Critique → Revise → Fact-check`, with a schema per
stage.

**T8 zone** — a long-lived organisational graph. Cross-zone writes only through a work
graph.

**T9 cost split** — expensive planning, routing and judging; cheap workers.

## Job graphs

**Research** — T5 + T3 + T6. A high-effort lead, three to six named lanes, then skeptic
shards. Label the result partial if a lane drops. Not for a single fact: one agent with
a few tools. Use deep research when the lanes are not known in advance.

**Ideas and Arena** — read-only signal lanes → N isolated ideas → two skeptics per idea →
score `value * confidence / (risk * effort)` → a human picks one. Do not let agents
improve each other's titles.

**Full refactor** — inventory → parallel analysis → Arena on strategy → human gate →
execution in worktrees → verify. The inventory is what makes "delete nothing that works"
checkable rather than hopeful.

**Docs** — classify without tools → parallel reference and conceptual writers in
worktrees → a deterministic ticket list → synthesize → fact-check against live code.

**Feature** — ambiguous? plan first and get it approved. Then an implementer in a
worktree, parallel read-only reviewers (correctness, tests, security), fail-closed, merge
green. Skip the plan for a typo or a delete button.

**Debug** — T0. Reproduce → one high-effort explorer with every symptom → at most three
hypotheses → one change in a worktree → a failing test, then a regression test.
Independently red files: one agent per file, then the whole suite. Never several agents
on one race condition.

**Review** — diff since a ref → parallel dimensions → a skeptic per finding demanding
evidence → report only what was confirmed.

**Migration** — a deterministic file list → batches of at most eight worktrees →
sequential merge → the suite.

**Acceptance loop** — multi-round with adversarial verification, for work with a
definition of done that can be checked. Skip it for one-shot small work.

## Primitives

| Need | Use | Do not |
| --- | --- | --- |
| A child in this turn | `spawn_subagent` | nest them |
| A repeatable DAG | a workflow file | fill the budget because it exists |
| Waiting for a person | `await_user` | pause on a branch derived from a result |
| An acceptance loop | a goal-style loop | mix two goal states |
| Parallel writers | `isolation: worktree`, then apply | two writers in one directory |
| A read-only lane | `explore` or read-only capability | a plan-mode parent with a general-purpose writing child |
| Judging or planning | high effort on that node | high effort on every worker |
| Parsing a join | `output_schema` | prose fan-in |
| Resuming a trace | resume the same child type | reopen a finished node as running |

## Budget

Fan-out plus verification plus two spare. Three or four agents under a fixed budget;
three to eight when the work is genuinely parallel. The cap is not a target.
