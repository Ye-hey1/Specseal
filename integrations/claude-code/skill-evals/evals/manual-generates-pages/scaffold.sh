#!/usr/bin/env bash
# 封存过一个 change，specseal/specs/greeting/spec.md 是正式规格。
source "$(dirname "$0")/../fixtures.sh"
eval_init
eval_greeting_archived
