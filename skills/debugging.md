---
name: debugging
description: Load when the user is debugging a bug, fixing a failing test, or chasing unexpected behavior in code
triggers:
  pathPatterns: []
  promptKeywords: ["debug", "fix the bug", "fix this bug", "failing test", "tests are failing", "broken", "not working", "doesn't work", "doesnt work", "crash", "crashes", "stack trace", "error message", "throws", "throwing", "exception", "weird behavior", "race condition", "deadlock", "memory leak", "regression"]
---

# Debugging discipline

When the user reports a bug, your job is to find the **root cause** and fix THAT. Symptom fixes (catch the error and ignore it, add a null check that masks the real issue) destroy trust. Follow the four-phase loop below; don't skip.

## Phase 1 — Reproduce

Before touching code, prove the bug is real and you can trigger it:

1. `run_shell` the failing test or repro command. Read the FULL error output, not just the last line.
2. If the user gave a stack trace, locate every frame in the codebase — `read_file` each one. The bug is rarely at the top of the trace; it's usually a frame or two down where a bad value entered.
3. If you can't reproduce, ask for ONE specific piece of missing info ("paste the exact command you ran" / "what version of node?"). Don't guess.

## Phase 2 — Root-cause trace

- Where did the bad value originate? Trace backward from where the symptom appears.
- Use `search_files` to find all callers of the affected function. The bug often isn't in the function — it's in a caller passing bad input.
- If the bug only happens sometimes (flaky test, race), instrument the suspect code with `console.log`/equivalent. Run repeatedly. Don't trust a one-off pass.

## Phase 3 — Hypothesis

Form a SINGLE specific hypothesis: "I think X is wrong because Y." Write it as a comment in the code if it's complex. Then test ONLY that hypothesis with the smallest possible change.

## Phase 4 — Fix + verify

- Make the minimal change that addresses the root cause.
- `run_shell` the test or repro AGAIN — must exit 0.
- Run the FULL test suite — must not regress anything else.
- Only NOW declare it fixed.

## Failure modes that mean STOP

If you find yourself doing any of these, you're symptom-fixing — back up to Phase 1:

- Adding try/catch around code you don't fully understand to "make the error go away"
- Adding `if (x == null) return;` without checking why x is null
- Bumping a timeout because "the test is flaky"
- Disabling a test
- Adding retries to a failing operation
- "Multiple fixes at once" without testing each — you can't isolate what worked

## When to ask for help

If three different hypotheses have failed in a row, STOP and tell the user what you've tried. The fourth attempt without new information is just thrashing.
