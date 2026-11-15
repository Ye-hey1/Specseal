---
name: specseal-bugfix
description: "Use when a single bug needs fixing end to end — reproduce it, locate the cause, record the change, patch, and prove a verified/partial/failed verdict against the original symptom."
license: MIT
compatibility: Requires specseal CLI.
metadata:
  author: specseal
  version: "v1.58.4"
  generatedBy: "Specseal"
---

**Conversation language**: write to the user in the language they use with you — progress updates, questions, and summaries. This skill is written in English, and its example messages show structure, not language: translate their prose, and keep commands, file paths, code, and fixed tokens (severity labels, status words) as they are. When a step sets the language of its own output — a document, a report, or the way it presents results and asks about them (for example through `locale`) — that step decides for that output. When you edit a document that already exists and no step sets its language, keep the language it is written in. When you run in a forked context that cannot see the conversation, use the language of the request you were given.

Fix a single bug end to end — reproduce, locate, patch, and verify the original symptom is gone — recorded as a Specseal change with an explicit verdict.

**Input**: The argument after `$specseal-bugfix` is the bug report: what happens, where, and how to reproduce it. Examples:

- `$specseal-bugfix submitting an empty password crashes the login form`
- `$specseal-bugfix search returns stale results after deleting an item`

If the report is too thin to reproduce the bug, ask for the missing pieces (steps, expected vs actual, affected area) before touching code.

**Prerequisites**: This skill requires the `specseal` CLI. If any `specseal` command fails with "command not found" or similar, report the error and STOP.

**Asking the user**: ask with the **AskUserQuestion tool**; when that tool is not available, ask the same question with the same options as plain text and wait for the user's response.

**Verdict discipline**: the workflow ends with a verdict — `verified` (the original symptom is gone and stays gone under the reproduction), `partial` (part of it gone), or `failed` (still reproducible). The verdict is recorded in the verify ticket, never implied. A `failed` verdict is a useful outcome: it says the attempt did not land and preserves what was tried.

**Scope guard**: this skill fixes one bug. Feature requests, refactors without a symptom, and workarounds that mask the symptom instead of removing the cause are proposals (`$specseal-propose`), not bugfixes.

**Steps**

1. **Assess the bug**

   a. **Reproduce first.** Write down the exact reproduction (command, input, expected vs actual) and run it. A bug that cannot be reproduced yet is not understood yet — narrow it (minimal input, specific environment) until the failure is deterministic. If it truly cannot be reproduced, report that to the user with everything checked, and ask how to proceed; do not patch blind.

   b. **Locate the cause, not the symptom.** Read the code path the reproduction exercises. Distinguish the surface where the symptom appears from the place where the mistake lives — patching the display site while the state stays wrong is how bugs come back.

   c. **Check the blast radius.** Search for other callers of the faulty code path; a fix that changes shared behavior needs those callers accounted for in the proposal.

2. **Record the change**

   ```bash
   specseal new change fix-<slug> --description "<one line: symptom and cause>"
   ```

   Then write the artifacts:

   - `proposal.md` — `## Why` the symptom as observed; `## Problem` the root cause as located (name the file and the mistake); `## Summary` the fix approach.
   - `tasks.md` — checkboxes: (1) a reproduction that fails before the fix and passes after, (2) the fix itself, (3) a regression check over the blast radius from 1c.
   - `specs/` delta — the corrected behavior as `## ADDED Requirements` (new capability, with `## Purpose`) or `## MODIFIED Requirements`, each requirement with a concrete `- **WHEN** / - **THEN**` scenario that reproduces the bug.

   Run `specseal validate` and fix every error before implementing.

3. **Implement the fix**

   - Make the smallest change that removes the cause. Refactors beyond the fix belong to their own change.
   - Keep the reproduction as the first checkpoint: it should fail on the unfixed code, pass on the fixed code.
   - When a task lands, record it:

   ```bash
   specseal task done <task-id> --change fix-<slug> --json
   ```

   This checks the box and records the touched files the verify scope needs.

4. **Prove the verdict**

   - Run the original reproduction from step 1 and the new test from the task list.
   - `verified` — the symptom is gone and the corrected-behavior scenario holds: write a validation verify round describing what was checked, then hand off to the quality stations (`$specseal-quality` or `$specseal-verify`) per the risk of the change.
   - `partial` — part of the symptom remains: record what still fails as must-fix findings in another round, and tell the user what is left.
   - `failed` — still reproducible: record the attempted cause and the failing evidence in a round, revert nothing without asking, and report to the user with what you learned.

5. **Hand off**

   Do not stamp on your own and do not archive: the verdict is recorded, the user decides whether the fix lands. Summarize: the reproduction, the root cause, the diff summary, the verdict, and any follow-up changes the blast radius suggests.
