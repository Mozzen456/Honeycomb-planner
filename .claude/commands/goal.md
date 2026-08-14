---
description: Set, show, or advance the durable objective recorded in GOAL.md
argument-hint: "[objective text] | (empty to report status)"
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
---

Maintain `GOAL.md` at the repo root. It is the memory that survives context summarisation between
loop iterations, so it must be true at all times and must never carry a claim you have not checked.

## With arguments

`$ARGUMENTS` is the objective. Write `GOAL.md` to the template below, filling **Done when** with
criteria that are each independently checkable — every one names the command or the file that
proves it. Derive the worklist from the repo as it actually is (read `PARKED.md`, `UNKNOWN.md`,
`DECISIONS.md`, and the failing/pinned tests), not from the objective text alone.

If `GOAL.md` already exists, preserve its **Progress log** verbatim and rewrite the rest.

## Without arguments

Read `GOAL.md` and report:

1. The objective, in one sentence.
2. Each **Done when** criterion with its current state — **run its check, do not recall it**. A box
   is ticked only after its stated command or file inspection passes in this turn.
3. The single highest-value unblocked worklist item, named as the next action.
4. Anything now blocked on a decision only the user can make.

If `GOAL.md` does not exist, say so and ask for an objective. Do not invent one.

## Template

```markdown
# GOAL

<objective, one paragraph, in the user's terms>

## Done when

- [ ] <criterion> — proof: `<command>` / `<file>`

## Constraints

- <a rule the work must not break, with why>

## Worklist

- [ ] <bounded item> — <status | blocked by X>

## Progress log

- YYYY-MM-DD — <what changed> — <evidence/source> — <test result>
```

## Rules

- Never tick a **Done when** box from memory, from a previous log line, or because a subagent said
  so. Run the check.
- An item that turns out to be impossible is not deleted — it moves to `PARKED.md` with the reason,
  and its worklist line says so.
- The Progress log is append-only. Do not rewrite history to look tidier.
- Keep `GOAL.md` under ~120 lines. It is a working index, not a report.
