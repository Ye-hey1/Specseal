#!/usr/bin/env bash
# 一个小模块，workflow config 还是 init 的默认值。
source "$(dirname "$0")/../fixtures.sh"
eval_init
mkdir -p src
cat >src/todo.js <<'JS'
const todos = [];

function addTodo(title) {
  todos.push({ title, done: false });
}

module.exports = { addTodo };
JS
