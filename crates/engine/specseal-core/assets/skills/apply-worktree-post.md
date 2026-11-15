
---

## Worktree wrap-up

Once the apply flow above has finished (all tasks complete, or the user stopped you at a good point), do these — still **inside the worktree**.

The apply body's own **Next steps** section does not apply here — this worktree flow replaces it with the edges in **Next steps** at the end of this document.

### W1. Commit the change in the worktree

{{#SPEC_IN_CHECKOUT}}
Follow the `/specseal:commit` skill's attribution convention: stage only the files belonging to this change (its artifacts under `{{SPEC_DIR}}changes/<change-name>/` plus the source files that `specseal evidence show "<change-name>" --json` lists in `files`), leave unrelated dirty files alone, and put the commit message in the project's language.
{{/SPEC_IN_CHECKOUT}}
{{^SPEC_IN_CHECKOUT}}
Follow the `/specseal:commit` skill's attribution convention: stage only the files belonging to this change — the source files that `specseal evidence show "<change-name>" --json` lists in `files`; the spec documents are on the Server and are not part of this commit — leave unrelated dirty files alone, and put the commit message in the project's language.
{{/SPEC_IN_CHECKOUT}}

The commit lands on branch `specseal/<change-name>` inside the worktree. Nothing reaches the main branch yet.

### W2. Catch up with the main branch, then reset the quality starting point

Rebasing now means a stamp landed in this worktree covers the content as it will be after the merge, and the later merge is a fast-forward that keeps the stamp fresh. Do it only while neither quality station has a ticket — a ticket means the stations are already running, and a rebase in the middle of their loop would move the ground under them:

```bash
specseal review show "<change-name>" --json
specseal verify show "<change-name>" --json
```

Both report that no ticket exists → continue. Either one shows a ticket → skip this whole step and say so.

1. Find the main checkout's path in `git worktree list --porcelain` (its first entry), then the branch it is on:

   ```bash
   git -C <main-checkout> branch --show-current
   ```

   A `specseal/*` branch or empty output (detached HEAD) → skip the rest of this step and tell the user why.

2. Record that branch's current commit, then replay this worktree's branch onto it:

   ```bash
   git -C <main-checkout> rev-parse HEAD
   git rebase "<recorded-commit>"
   ```

   - **Conflicts** → do not resolve them. Run `git rebase --abort` (the branch returns exactly as it was), report the conflicting files, and skip the reset below: the branch did not change, so its old starting point still holds.
   - **Git refuses for another reason** (for example, uncommitted files) → report git's message and skip the reset below.

3. The rebase succeeded → move the quality stations' starting point to the recorded commit:

   ```bash
   specseal review prepare "<change-name>" --base "<recorded-commit>"
   ```

   If it fails, report its error and the recorded commit. The branch now sits on the recorded commit while the starting point still names the old fork point, so a quality round run now would count the main branch's own changes as this change's. Rerun that one line once the cause is cleared, before any quality station runs.

A stamp can still go stale if the main branch changes the same files again while the stations run.

### W3. Stop here — do not merge, do not remove the worktree

This skill's job ends at the commit. Explicitly:

- **Do NOT** merge `specseal/<change-name>` back into the main branch.
- **Do NOT** run `git worktree remove`, and do NOT delete the branch.
- **Do NOT** switch the main checkout to another branch or touch it in any way.

Merging is a separate, human-triggered step: it needs a clean main tree, and a conflict there is the user's call, not yours. Leaving the worktree in place also means the main checkout's `specseal list` keeps showing this change with its `[worktree]` marker until the merge happens.

### W4. Hand off

Pick the path by the change's state: unchecked `[M]` manual tasks show in `specseal instructions apply --change "<change-name>" --json` as `remaining` above `codeRemaining`.

- **No unchecked `[M]` task** — tell the user, plainly:

  > 这个 change 已在 worktree 内完成并提交，尚未合并回主分支。
  >
  {{#SPEC_IN_CHECKOUT}}
  > 建议在这个 worktree 内跑品质关卡——`/specseal:review`（工艺品质）∥ `/specseal:verify`（规格符合度），或 `/specseal:quality`（两站合跑），是否要跑由你决定。盖章会写进 change 的 meta，记得补一次提交，再运行 `/specseal:worktree-merge <change-name>` 收尾。
  {{/SPEC_IN_CHECKOUT}}
  {{^SPEC_IN_CHECKOUT}}
  > 建议在这个 worktree 内跑品质关卡——`/specseal:review`（工艺品质）∥ `/specseal:verify`（规格符合度），或 `/specseal:quality`（两站合跑），是否要跑由你决定。盖完章后运行 `/specseal:worktree-merge <change-name>` 收尾（章在 Server 上，不用补提交）。
  {{/SPEC_IN_CHECKOUT}}
  >
  > 想在盖章前先看到 CI 结果的话，改走另一条路：先运行 `/specseal:worktree-merge <change-name>` 合并，再到主 checkout 跑品质关卡——worktree 分支只在本机、从不 push，CI 看不到它；合并时品质关卡的起点会一起承接到主 checkout。

- **Unchecked `[M]` tasks remain** — tell the user, plainly:

  > 这个 change 已在 worktree 内完成并提交，尚未合并回主分支，还有手动任务没做。
  >
  > 建议先运行 `/specseal:worktree-merge <change-name>`——它会检查主树是否干净、把分支合并回去、把品质关卡的起点承接到主 checkout，成功后移除 worktree 并删掉分支。之后在主 checkout 跑品质关卡——`/specseal:review`（工艺品质）∥ `/specseal:verify`（规格符合度），或 `/specseal:quality`（两站合跑），是否要跑由你决定——做完手动任务再封存。

Report alongside it: the worktree path, the branch name, the tasks completed this session, and whether W2 rebased or why it skipped.

### Wrap-up check

Check these before you hand off:

{{#SPEC_IN_CHECKOUT}}
- [ ] The commit in the worktree holds only this change's artifacts and evidence-recorded source files (W1).
{{/SPEC_IN_CHECKOUT}}
{{^SPEC_IN_CHECKOUT}}
- [ ] The commit in the worktree holds only this change's evidence-recorded source files — no spec document (W1).
{{/SPEC_IN_CHECKOUT}}
- [ ] W2 rebased only while neither station had a ticket; a conflict was aborted, never resolved; a successful rebase was followed by `specseal review prepare --base` (W2).
- [ ] Nothing was merged, no worktree or branch was removed, and the main checkout was not touched (W3).
- [ ] The hand-off names the worktree path, the branch and the tasks completed, takes the path the manual tasks call for, and lists review, verify and quality as the entries next to `/specseal:worktree-merge` (W4).

## Next steps

{{NEXT_STEPS_LEAD}}

{{#SPEC_IN_CHECKOUT}}
- No unchecked `[M]` task → the quality stations here in the worktree: `/specseal:review` ∥ `/specseal:verify`, or `/specseal:quality` for both; commit the stamps, then `/specseal:worktree-merge <change-name>`
{{/SPEC_IN_CHECKOUT}}
{{^SPEC_IN_CHECKOUT}}
- No unchecked `[M]` task → the quality stations here in the worktree: `/specseal:review` ∥ `/specseal:verify`, or `/specseal:quality` for both; then `/specseal:worktree-merge <change-name>` (the stamps are on the Server — nothing to commit for them)
{{/SPEC_IN_CHECKOUT}}
- Unchecked `[M]` tasks remain, or the user wants CI results before stamping (the worktree branch is local only, so CI never sees it) → `/specseal:worktree-merge <change-name>` first, then the quality stations and the manual tasks in the main checkout, then archive
- Requirements changed mid-work → `/specseal:ingest <change-name>` inside this worktree, then resume apply here
