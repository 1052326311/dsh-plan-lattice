# V23 Grader Qualification

This directory qualifies the Duty Window Ledger grader before any paid model
run. It is a grader test fixture, not evidence that Plan Lattice improves model
quality.

The reference workspace must score `100/100` with zero hard misses. The
qualification runner then copies it into a temporary directory for each
known-bad mutant. Every hard check has at least one attributable mutant, and
qualification succeeds only when the intended check rejects that mutant while
the unchanged reference remains accepted.

The reassign check deliberately snapshots bytes immediately before and after
the rejected old-worker command. Only after proving that rejection is byte
stable does it run the accepted new-worker command and require a byte change.
The adjust-start check requires both `start == end` and `start > end` to exit
with input status `2` without changing the store.

All scripts use Node built-ins. Mutant workspaces are deterministic copies in
OS temporary directories and are removed in `finally` blocks.

Run the qualification and its automated tests:

```sh
node eval/long-system/v23/qualification.mjs
node --test eval/long-system/v23/tests/*.test.mjs
```
