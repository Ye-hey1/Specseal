# 评测题共用的 scaffold 片段：每题的 scaffold.sh 以 source 加载，在评测工作区（目前目录）运行。
# 只依赖 PATH 上的 specseal 与 git。
#
# EVAL_TOOLS 缺省 claude：技能由评测 plugin 的 skills/ 提供，所以删掉 init 写出的项目技能。
# 手动抽查 Codex／Copilot 时设成 codex 或 copilot，技能留在工作区给该工具读：
#   mkdir ws && cd ws && EVAL_TOOLS=codex bash <题目>/scaffold.sh
set -euo pipefail

eval_init() {
  local tools="${EVAL_TOOLS:-claude}"
  specseal init . --tools "$tools" >/dev/null
  if [ "$tools" = claude ]; then rm -rf .claude/skills; fi
}

# 评测的 HOME 是临时目录，没有全域 git 身分，所以设在工作区内。
eval_git_init() {
  git init -q -b main .
  git config user.name "Eval User"
  git config user.email "eval@example.com"
}

eval_commit() {
  git add -A
  git commit -qm "$1"
}

# 第一个 commit 只有 README.md 的 git repo，之后才 init（init 写出的文件留在工作目录、未 commit）。
eval_greeting_repo() {
  eval_git_init
  echo '# greeting' >README.md
  eval_commit 'initial commit'
  eval_init
}

# commit add-greeting 的 artifacts，并记录 apply 基准（review／verify 的冻结范围以它为起点）。
# 基准要在别处记录的题目（由受测的技能记录，或由 scaffold 在 worktree 内另行记录）只用 eval_commit。
eval_greeting_artifacts_with_baseline() {
  eval_commit 'add-greeting: artifacts'
  specseal review prepare add-greeting >/dev/null 2>&1
}

# change add-greeting：在 repo 根目录创建内容为 hello 的 greeting.txt。
# 参数 manual：多一个 [M] 任务（打开文件确认内容）。
eval_greeting_change() {
  local dir=specseal/changes/add-greeting
  specseal new change add-greeting >/dev/null
  mkdir -p "$dir/specs/greeting"
  cat >"$dir/proposal.md" <<'EOF'
## Why

New contributors should see a friendly greeting when they open the repository.

## What Changes

- Add `greeting.txt` at the repository root with the content `hello`.

## Capabilities

### New Capabilities

- `greeting`: A greeting file at the repository root.

### Modified Capabilities

(None)

## Impact

- New file: `greeting.txt`
EOF
  cat >"$dir/design.md" <<'EOF'
## Context

The repository has no greeting yet.

## Decisions

### Plain text file

`greeting.txt` is a plain UTF-8 text file with the single line `hello`. No build step reads it.
EOF
  cat >"$dir/specs/greeting/spec.md" <<'EOF'
## Purpose

The greeting file that welcomes contributors at the repository root, and nothing else.

## ADDED Requirements

### Requirement: Greeting file

The repository SHALL contain a `greeting.txt` file at its root whose content is `hello`.

#### Scenario: Greeting file exists

- **WHEN** a contributor opens the repository root
- **THEN** `greeting.txt` exists and its content is `hello`
EOF
  {
    echo '## 1. Greeting'
    echo
    echo '- [ ] 1.1 Create `greeting.txt` at the repository root with the content `hello`. Verify: `cat greeting.txt` prints `hello`.'
    if [ "${1:-}" = manual ]; then
      echo '- [ ] [M] 1.2 Open `greeting.txt` in an editor and confirm that it reads `hello`.'
    fi
  } >"$dir/tasks.md"
}

# add-greeting 的程序任务已完成：创建 greeting.txt 并以 task done 记录。
eval_greeting_done() {
  specseal in-progress add add-greeting >/dev/null
  echo hello >greeting.txt
  specseal task done --change add-greeting 1 >/dev/null
}

# 已封存的 add-greeting：specseal/specs/greeting/spec.md 成为正式规格。
eval_greeting_archived() {
  eval_greeting_change
  eval_greeting_done
  specseal archive add-greeting --yes >/dev/null
}

# 在 git 中完成 add-greeting：change 先 commit、记录 apply 基准，再做完程序任务并 commit。
eval_greeting_committed() {
  eval_greeting_change
  eval_greeting_artifacts_with_baseline
  eval_greeting_done
  eval_commit 'add-greeting: greeting.txt'
}

# 品质关卡用的 add-greeting：src/greet.js 已实作并 commit，但有一个真的错误——条件式把空字符串
# 指派给 name，任何调用都回传 "hello, "，违反规格的两个 scenario，也是程序上的错。
eval_buggy_greet_committed() {
  local dir=specseal/changes/add-greeting
  specseal new change add-greeting >/dev/null
  mkdir -p "$dir/specs/greeting"
  cat >"$dir/proposal.md" <<'EOF'
## Why

The app needs one place that builds the greeting text shown to contributors.

## What Changes

- Add `greet(name)` in `src/greet.js`.

## Capabilities

### New Capabilities

- `greeting`: The greet helper that builds the greeting text.

### Modified Capabilities

(None)

## Impact

- New file: `src/greet.js`
EOF
  cat >"$dir/design.md" <<'EOF'
## Context

The greeting text is built in several places today.

## Decisions

### One helper

`greet(name)` in `src/greet.js` is the only place that builds the greeting text.
EOF
  cat >"$dir/specs/greeting/spec.md" <<'EOF'
## Purpose

The greet helper that builds the greeting text shown to contributors, and nothing else.

## ADDED Requirements

### Requirement: Greet by name

`greet(name)` in `src/greet.js` SHALL return `hello, <name>`. When `name` is the empty string it SHALL return `hello`.

#### Scenario: Named greeting

- **WHEN** `greet` is called with `Ada`
- **THEN** it returns `hello, Ada`

#### Scenario: Empty name

- **WHEN** `greet` is called with the empty string
- **THEN** it returns `hello`
EOF
  cat >"$dir/tasks.md" <<'EOF'
## 1. Greet helper

- [ ] 1.1 Add `greet(name)` in `src/greet.js` that returns `hello, <name>`, or `hello` when `name` is empty. Verify: `node -e "const {greet}=require('./src/greet'); console.log(greet('Ada'), greet(''))"` prints `hello, Ada hello`.
EOF
  eval_greeting_artifacts_with_baseline
  specseal in-progress add add-greeting >/dev/null
  mkdir -p src
  cat >src/greet.js <<'EOF'
function greet(name) {
  if (name = '') return 'hello';
  return `hello, ${name}`;
}

module.exports = { greet };
EOF
  specseal task done --change add-greeting 1 >/dev/null
  eval_commit 'add-greeting: greet helper'
}
