---
name: grokspace-memory
description: >
  Read the shared project memory GrokSpace keeps before doing work in a project.
  It holds what the project is, what has already been decided, and where things
  ended up, written by the person you are working with. Use it at the start of any
  session, and whenever a choice looks like one that may already have been made.
when-to-use: >
  starting work in this project, what did we decide, why is it like this,
  project conventions, where does that live, before choosing a library,
  before changing an architecture, catching up
metadata:
  author: GrokSpace
  short-description: Shared project memory for GrokSpace
---

# Shared project memory

GrokSpace keeps one memory per project: the things everyone working on it should
already know. Read it from the path in `$GROKSPACE_MEMORY_FILE`; if that variable is
unset, use `.grokspace/memory.md` under the project root.

```bash
cat "$GROKSPACE_MEMORY_FILE"
```

The file always exists for a session GrokSpace started, so nothing being there means
the memory is genuinely empty, not that something went wrong.

## When to read it

**At the start of the session, before planning anything.** Memory is where a
project's decisions live, and a plan made without them is a plan that re-litigates
them. This costs one read.

**Again before any choice that sounds settled.** Which database, which test runner,
which directory something belongs in — if it reads like a decision somebody already
made, check whether they did.

## What is in it

Four kinds of entry, under a heading each:

| Heading | What it holds |
| --- | --- |
| Context | What the project is and how it is put together |
| Decisions | Choices already made, and usually why |
| Notes | Anything else worth carrying between sessions |
| Artifacts | Where things ended up: paths, outputs, endpoints |

Each entry has a short key as its own heading and its content underneath. Keys are
stable, so `database` means the same entry today and next week.

## Do not write to it

This file is generated from GrokSpace's Memory panel and rewritten whenever that
changes. An edit here is lost the next time anything is saved, which is worse than
being refused: it looks like it worked.

When you learn something that belongs in the memory — a decision made during this
session, a convention you had to infer — **say so in your reply** and name the key
it should go under. The person you are working with puts it in the panel, and every
later session gets it. Two lines of your answer buy that.

## What it is not

It is not your own memory of this conversation, and not a scratchpad. It is the
shared, human-curated account of the project: small, deliberate, and read by every
agent that starts here. Treat a claim in it as more authoritative than an inference
you drew from the code, and if the two disagree, say so rather than quietly
picking one.
