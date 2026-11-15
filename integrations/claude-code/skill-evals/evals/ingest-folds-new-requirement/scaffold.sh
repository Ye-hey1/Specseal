#!/usr/bin/env bash
# change add-greeting 进行中，任务都还没做。
source "$(dirname "$0")/../fixtures.sh"
eval_init
eval_greeting_change
specseal in-progress add add-greeting >/dev/null
