#!/usr/bin/env bash
# change add-greeting 两个任务：1.1 创建 greeting.txt、[M] 1.2 打开文件确认内容。
source "$(dirname "$0")/../fixtures.sh"
eval_git_init
eval_init
eval_greeting_change manual
eval_commit 'add-greeting: artifacts'
