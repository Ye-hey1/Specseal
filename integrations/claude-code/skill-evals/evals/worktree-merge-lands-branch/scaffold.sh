#!/usr/bin/env bash
# 依 apply-with-worktree 的惯例创建 worktree（分支 specseal/add-greeting、
# 路径 <repo-parent>/<repo-folder>.worktrees/add-greeting），在其中完成变更并 commit。
source "$(dirname "$0")/../fixtures.sh"
eval_greeting_repo
specseal workflow-config set worktree true >/dev/null
eval_greeting_change
eval_commit 'add-greeting: artifacts'
worktree="$(dirname "$PWD")/$(basename "$PWD").worktrees/add-greeting"
git worktree add -q -b specseal/add-greeting "$worktree"
(
  cd "$worktree"
  specseal review prepare add-greeting >/dev/null 2>&1
  eval_greeting_done
  eval_commit 'add-greeting: greeting.txt'
)
