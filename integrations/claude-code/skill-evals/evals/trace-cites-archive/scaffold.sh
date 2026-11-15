#!/usr/bin/env bash
# greeting 正式规格来自已封存的 change add-greeting。
source "$(dirname "$0")/../fixtures.sh"
eval_init
eval_greeting_archived
