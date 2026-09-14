---
name: grokspace-steps
description: >
  Before changing a project in GrokSpace, write the steps you will take to
  $GROKSPACE_STEPS_FILE and wait in Spec. Update each step's status in
  that file as you go. Load this when starting work, when a task is dispatched,
  when asked what you are doing, or when a checklist, steps, Spec, Build, or
  approval is mentioned.
when-to-use: >
  starting work, dispatched a task, what are you doing, checklist, steps,
  Spec, Build, approve the plan, before editing files, GROKSPACE_STEPS_FILE
metadata:
  author: GrokSpace
  short-description: Session step lists that GrokSpace shows and the user approves
---

# Session steps GrokSpace shows

GrokSpace has a project board (the human's queue) and a **session step list**
(this run's breakdown). You write the second one. Do not add cards to the board.

## The file

Write JSON to **`$GROKSPACE_STEPS_FILE`**. That path is absolute and named for
this session. A file written anywhere else is a list nobody sees.

```json
{
  "steps": [
    { "id": "read-auth", "title": "Read auth.ts", "status": "pending" },
    { "id": "add-test", "title": "Add a failing test", "status": "pending" }
  ]
}
```

Keep `id` stable across writes so GrokSpace can match status updates. At most
20 steps. Status is `pending`, `doing`, `done`, or `skipped`.

If `$GROKSPACE_STEPS_FILE` is unset you are not inside GrokSpace; do not invent
a path.

## Procedure

1. **Before any tool that changes the project**, write the steps file.
2. **Wait (Spec).** GrokSpace shows this as Spec while the list is `proposed`.
   The next message is Build (Approve), or an edited list. Do not start until
   it arrives. This is a host gate, not grok `plan` mode — do not pass a plan
   flag.
3. After Build, follow the approved titles in order. Update **status only**
   in the file as you go. Do not rename, reorder, add, or drop steps unless the
   user asks.
4. If the user adds or changes steps in GrokSpace, the Build message is the
   list to follow, not the file you last wrote. Spec on an already-built list
   means the human reopened titles; wait again.

## Do not

- Do not write GrokSpace's SQLite database.
- Do not dump these steps onto the project task board.
- Do not skip the wait after the first write.
