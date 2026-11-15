#!/usr/bin/env bash
# demo 创建的 change 名称是随机的，改成固定的 demo-change 让提示可以指名。
source "$(dirname "$0")/../fixtures.sh"
eval_init
specseal demo >/dev/null
demo=$(ls specseal/changes | grep -v '^archive$')
mv "specseal/changes/$demo" specseal/changes/demo-change
