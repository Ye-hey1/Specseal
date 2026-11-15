#!/usr/bin/env bash
# add-greeting 的程序任务已勾、src/greet.js 已 commit，但有一个真的错误（见 fixtures.sh）。
source "$(dirname "$0")/../fixtures.sh"
eval_greeting_repo
eval_buggy_greet_committed
