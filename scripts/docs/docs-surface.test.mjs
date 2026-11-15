// getting-started 与 workflow 的指令面查核（user-documentation spec「文档准确性具可重复
// 验证清单」）：写成可直接使用的 `specseal` 子指令与旗标要出现在目前 CLI 的 help，
// 文档明说「没有」的指令要确实不存在；技能名要存在于产生的技能目录。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NO_BUILT_CLI, builtCli } from './built-cli.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (relative) => readFileSync(path.join(ROOT, relative), 'utf8');

const DOCS = [
  'docs/getting-started.zh-CN.md',
  'docs/getting-started.md',
  'docs/workflow.zh-CN.md',
  'docs/workflow.md',
];

/// 文档写明不存在的指令：「没有 `specseal baseline` 指令」／「No `specseal baseline` command exists」。
const ABSENT = /没有 `(specseal [^`]+)` 指令|No `(specseal [^`]+)` command exists/g;

/// 会写指令的 code block 语言。
const SHELL_FENCE = /```(?:bash|sh|shell|zsh|console)\n([\s\S]*?)```/g;

/// 行内 code 与 shell 区块里的指令。区块内以 `\` 续行的先接回一行，console 的 `$ `
/// 提示符号先剥掉，管线、`&&`、`;` 后面的 `specseal …` 也算。`specseal 0.8.0 (…)`
/// 这类输出范例后面接的不是子指令或旗标，不算指令。
function commandsIn(markdown) {
  const absent = new Set([...markdown.matchAll(ABSENT)].map((match) => match[1] ?? match[2]));
  const spans = [...markdown.matchAll(/`(specseal [^`\n]+)`/g)].map((match) => match[1]);
  const lines = [...markdown.matchAll(SHELL_FENCE)].flatMap((match) =>
    match[1]
      .replace(/\\\n\s*/g, '')
      .split('\n')
      .map((line) => line.replace(/\s+#.*$/, '').replace(/^\s*\$\s+/, ''))
      .flatMap((line) => line.split(/\|\||&&|[|;]/))
      .map((segment) => segment.trim())
      .filter((segment) => segment.startsWith('specseal ')),
  );
  const present = [...spans, ...lines].filter(
    (command) => /^specseal (?:-|[a-z])/.test(command) && !absent.has(command),
  );
  return { present, absent: [...absent] };
}

const cli = builtCli();
const helpCache = new Map();

function helpOf(words) {
  const key = words.join(' ');
  if (!helpCache.has(key)) {
    const result = spawnSync(cli, [...words, '--help'], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(result.status, 0, `specseal ${key} --help 失败：${result.stderr}`);
    helpCache.set(key, result.stdout);
  }
  return helpCache.get(key);
}

const subcommandsIn = (help) =>
  new Set(
    (/\nCommands:\n([\s\S]*?)(?:\n\n|$)/.exec(help)?.[1] ?? '')
      .split('\n')
      .map((line) => line.trim().split(/\s+/)[0])
      .filter(Boolean),
  );

/// help 的 Options 区段：旗标只认这里列的，子指令说明里顺口提到的不算。
const optionsOf = (help) => /\nOptions:\n([\s\S]*)$/.exec(help)?.[1] ?? '';

/// 沿着 help 的 Commands 清单走到最深的子指令。clap 的 `help` 子指令后面接的是要查的
/// 子指令路径（`specseal help archive` 查的是 archive），所以先剥掉；子指令前的旗标
/// （`specseal --no-color list`）略过继续走；遇到参数就停。
/// 回传走到的子指令路径，以及第一个不在清单里的子指令名（没有则为 null）。
function walkSubcommands(command) {
  const tokens = command.split(/\s+/).slice(1);
  if (tokens[0] === 'help') tokens.shift();
  const words = [];
  for (const token of tokens) {
    if (token.startsWith('-')) continue;
    if (!/^[a-z][a-z-]*$/.test(token)) break;
    const subcommands = subcommandsIn(helpOf(words));
    if (subcommands.has(token)) {
      words.push(token);
      continue;
    }
    // 有子指令清单却对不上：写错的子指令。没有清单：这是位置参数（变更名称等）。
    return { words, unknown: subcommands.size > 0 ? token : null };
  }
  return { words, unknown: null };
}

const FLAG = /(?<![\w-])(--?[a-zA-Z][\w-]*)/g;

test(
  'getting-started／workflow 的 specseal 子指令与旗标都在目前的 help 里',
  { skip: !cli && NO_BUILT_CLI },
  () => {
    const problems = [];
    for (const doc of DOCS) {
      for (const command of commandsIn(read(doc)).present) {
        const { words, unknown } = walkSubcommands(command);
        if (unknown) {
          problems.push(`${doc}：\`${command}\` 的子指令「${unknown}」不存在`);
          continue;
        }
        const options = optionsOf(helpOf(words));
        for (const [, flag] of command.matchAll(FLAG)) {
          if (!new RegExp(`(?<![\\w-])${flag}(?![\\w-])`).test(options)) {
            problems.push(`${doc}：\`${command}\` 的旗标 ${flag} 不在 \`${['specseal', ...words, '--help'].join(' ')}\``);
          }
        }
      }
    }
    assert.deepEqual(problems, []);
  },
);

test(
  'getting-started／workflow 写明「没有」的 specseal 指令确实不存在',
  { skip: !cli && NO_BUILT_CLI },
  () => {
    const problems = [];
    for (const doc of DOCS) {
      for (const command of commandsIn(read(doc)).absent) {
        if (walkSubcommands(command).unknown === null) problems.push(`${doc}：文档说没有 \`${command}\`，但 CLI 有`);
      }
    }
    assert.deepEqual(problems, []);
  },
);

/// Claude 写 `/specseal-x`、Codex 写 `$specseal-x`，各自对到自己的技能目录。
/// 前面紧接字符、`.`、`/` 或 `-` 的是路径（`crates/adapters/specseal-cli`、`./specseal-data`），不是技能。
const SKILL = /(?<![\w./-])([/$])(specseal-[a-z]+(?:-[a-z]+)*)/g;
const SKILL_DIRS = { '/': '.claude/skills', $: '.agents/skills' };

test('getting-started／workflow 的技能名称都存在于产生的技能目录', () => {
  const problems = [];
  for (const doc of DOCS) {
    for (const [, sigil, name] of read(doc).matchAll(SKILL)) {
      if (!existsSync(path.join(ROOT, SKILL_DIRS[sigil], name, 'SKILL.md'))) {
        problems.push(`${doc}：${sigil}${name} 不在 ${SKILL_DIRS[sigil]}/`);
      }
    }
  }
  assert.deepEqual([...new Set(problems)], []);
});

test('抽取：管线、提示符号、续行与 shell／console 区块里的指令都算', () => {
  const md = [
    '```bash',
    "printf 'x' | specseal discuss context demo --stdin",
    'specseal validate --specs \\',
    '  --strict',
    '```',
    '',
    '```console',
    '$ specseal list --json',
    'specseal 0.8.0 (arm64, engine v1.42.0)',
    '```',
    '',
    '```shell',
    'cd repo && specseal plan --json',
    '```',
  ].join('\n');
  assert.deepEqual(commandsIn(md).present, [
    'specseal discuss context demo --stdin',
    'specseal validate --specs --strict',
    'specseal list --json',
    'specseal plan --json',
  ]);
});

test('旗标比对只看 help 的 Options 区段，不看子指令说明里提到的旗标', () => {
  const help = [
    'Usage: specseal [OPTIONS] <COMMAND>',
    '',
    'Commands:',
    '  discard  Discard a change (--force required once work has started)',
    '',
    'Options:',
    '      --no-color  Disable colored output',
    '  -h, --help      Print help',
  ].join('\n');
  assert.equal(optionsOf(help).includes('--force'), false);
  assert.equal(optionsOf(help).includes('--no-color'), true);
});

test(
  '子指令路径：help 子指令、前置的全域旗标与多层的「没有」指令',
  { skip: !cli && NO_BUILT_CLI },
  () => {
    assert.deepEqual(walkSubcommands('specseal help archive'), { words: ['archive'], unknown: null });
    assert.deepEqual(walkSubcommands('specseal --no-color list --json'), { words: ['list'], unknown: null });
    assert.deepEqual(walkSubcommands('specseal discuss nonexistent-verb'), {
      words: ['discuss'],
      unknown: 'nonexistent-verb',
    });
  },
);
