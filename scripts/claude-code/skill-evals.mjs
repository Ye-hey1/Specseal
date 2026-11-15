#!/usr/bin/env node
// 技能评测的运行与新旧比较（skill-authoring 规格「技能评测套件」）。
//
//   node scripts/claude-code/skill-evals.mjs run --specseal <运行档> --model <模型 ID> \
//     --label <名称> --max-cost-usd <金额> [--case <题目>] [--runs <次数>]
//   node scripts/claude-code/skill-evals.mjs compare <旧结果目录> <新结果目录>
//
// run 以指定的运行档渲染受测技能、也让评测工作区内的 `specseal` 都是它：评测不加载
// 工作区的项目技能，所以技能要放进 plugin 的 skills/。repo 的 manifest 与 evals/ 会拷贝
// 成 target/skill-evals/.staging/<label>/plugin/，再补上该运行档写出的 `.claude/skills/specseal-*`。
//
// compare 的 exit code：0 没有退步、1 有退步、2 题目集合不同、3 无法比较（用法错、结果档
// 不存在或不是 JSON、结果因花费上限而不完整）。
// 需要 claude CLI 与用户额度，不在 CI 运行；CI 只跑 skill-evals.test.mjs。
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SUITE_DIR = 'integrations/claude-code/skill-evals';
export const OUT_ROOT = 'target/skill-evals';
export const RESULT_FILE = 'aggregate-result.json';
/// 运行档与 plugin 副本的暂存根目录。label 不能以 . 开头，所以它不会和任何结果目录同名。
const STAGING = '.staging';
const CANNOT_COMPARE = 3;
const JUDGE_MODEL = 'claude-sonnet-5-5';

/// 逐题比较两份 aggregate-result.json：题目名在 cases[].name、分数在 cases[].aggregates.score。
/// rows 只含两边都有的题目（依名称排序）；新分数低于旧分数即退步；只在一边出现的题目列入 missing。
export function compareResults(oldDoc, newDoc) {
  const scores = (doc) => new Map(doc.cases.map((entry) => [entry.name, entry.aggregates.score]));
  const oldScores = scores(oldDoc);
  const newScores = scores(newDoc);
  const names = [...new Set([...oldScores.keys(), ...newScores.keys()])].sort();
  const rows = [];
  const missing = [];
  for (const name of names) {
    if (!newScores.has(name)) missing.push({ name, missingFrom: 'new' });
    else if (!oldScores.has(name)) missing.push({ name, missingFrom: 'old' });
    else rows.push({ name, old: oldScores.get(name), new: newScores.get(name), delta: newScores.get(name) - oldScores.get(name) });
  }
  const regressions = rows.filter((row) => row.new < row.old).map((row) => row.name);
  return { rows, regressions, missing };
}

/// label 成为 target/skill-evals/ 下的目录名，只收单一路径段。
const LABEL = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/// run 用到的目录：结果写在 <OUT_ROOT>/<label>/，运行档与 plugin 副本在 <OUT_ROOT>/.staging/<label>/。
export function runPaths(label, root = ROOT) {
  const staging = path.join(root, OUT_ROOT, STAGING, label);
  return { outDir: path.join(root, OUT_ROOT, label), binDir: path.join(staging, 'bin'), pluginDir: path.join(staging, 'plugin') };
}

/// claude 子行程的启动设置：不读 stdin、输出不带颜色、PATH 以受测运行档的目录开头。
export function evalSpawnOptions(binDir, env = process.env) {
  return { stdio: ['ignore', 'inherit', 'inherit'], env: { ...env, NO_COLOR: '1', PATH: `${binDir}${path.delimiter}${env.PATH}` } };
}

/// run 的参数。回传 `{ options, errors }`；errors 非空时不得启动评测。
/// root 只供测试换成暂存目录；--specseal 的相对路径照常以目前目录解析。
export function parseRunArgs(argv, root = ROOT) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        specseal: { type: 'string' },
        model: { type: 'string' },
        label: { type: 'string' },
        'max-cost-usd': { type: 'string' },
        case: { type: 'string' },
        runs: { type: 'string', default: '3' },
      },
    }));
  } catch (error) {
    return { options: null, errors: [error.message] };
  }
  const errors = ['specseal', 'model', 'label', 'max-cost-usd']
    .filter((name) => values[name] === undefined || values[name] === '')
    .map((name) => `缺少参数 --${name}`);
  if (values.specseal) {
    const binary = path.resolve(values.specseal);
    if (!existsSync(binary) || !statSync(binary).isFile()) errors.push(`--specseal 指向的运行档不存在：${binary}`);
  }
  if (values.label && !LABEL.test(values.label)) {
    errors.push(`--label 只能用英数字、- 与 _，且以英数字开头（它是 ${OUT_ROOT}/ 下的目录名）：${values.label}`);
  } else if (values.label && existsSync(path.join(root, OUT_ROOT, values.label, RESULT_FILE))) {
    errors.push(`${OUT_ROOT}/${values.label}/ 已有评测结果；换一个 --label，或先删掉该目录`);
  }
  const cost = Number(values['max-cost-usd']);
  if (values['max-cost-usd'] && !(Number.isFinite(cost) && cost > 0)) {
    errors.push(`--max-cost-usd 必须是正数（美元）：${values['max-cost-usd']}`);
  }
  const runs = Number(values.runs);
  if (!(Number.isInteger(runs) && runs >= 1 && runs <= 50)) errors.push(`--runs 必须是 1 到 50 的整数：${values.runs}`);
  return { options: values, errors };
}

/// 读结果档；文件不存在、不是 JSON，或因花费上限而不完整时丢出指名该档的错误。
/// 不完整＝顶层 partial 为 true，或某次运行略过了付费评分（llm 评分没跑，分数不能和完整结果比）。
function readResult(dir) {
  const file = path.join(dir, RESULT_FILE);
  if (!existsSync(file)) throw new Error(`找不到结果档：${file}`);
  let doc;
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`结果档不是 JSON：${file}（${error.message}）`);
  }
  const skippedPaid = doc.cases?.some((entry) => entry.arms?.with?.some((run) => run.skippedPaidGraders === true));
  if (doc.partial === true || skippedPaid) throw new Error(`结果因花费上限而不完整，不能比较：${file}`);
  return doc;
}

function compareMain([oldDir, newDir, ...rest]) {
  if (!oldDir || !newDir || rest.length > 0) {
    console.error('用法：node scripts/claude-code/skill-evals.mjs compare <旧结果目录> <新结果目录>');
    return CANNOT_COMPARE;
  }
  let result;
  try {
    result = compareResults(readResult(oldDir), readResult(newDir));
  } catch (error) {
    console.error(error.message);
    return CANNOT_COMPARE;
  }
  const width = Math.max('题目'.length, ...result.rows.map((row) => row.name.length));
  const score = (value) => value.toFixed(2);
  console.log(`${'题目'.padEnd(width)}  旧分数  新分数  差值`);
  for (const row of result.rows) {
    const delta = `${row.delta >= 0 ? '+' : ''}${row.delta.toFixed(2)}`;
    console.log(`${row.name.padEnd(width)}  ${score(row.old).padStart(6)}  ${score(row.new).padStart(6)}  ${delta}`);
  }
  for (const name of result.regressions) {
    const row = result.rows.find((entry) => entry.name === name);
    console.log(`退步：${name}（${score(row.old)} → ${score(row.new)}）`);
  }
  for (const entry of result.missing) {
    console.log(`缺少的题目：${entry.name}（${entry.missingFrom === 'new' ? '新' : '旧'}结果没有）`);
  }
  // 题目集合不同时比较本身不完整，优先于退步回报。
  if (result.missing.length > 0) return 2;
  return result.regressions.length > 0 ? 1 : 0;
}

/// 以指定运行档在暂存工作区写出全部技能（worktree 政策打开才会写出 apply-with-worktree
/// 与 worktree-merge），连同 repo 的 manifest 与 evals/ 组成受测的 plugin 副本。
function stagePlugin(specseal, pluginDir) {
  rmSync(pluginDir, { recursive: true, force: true });
  mkdirSync(pluginDir, { recursive: true });
  cpSync(path.join(ROOT, SUITE_DIR, '.claude-plugin'), path.join(pluginDir, '.claude-plugin'), { recursive: true });
  cpSync(path.join(ROOT, SUITE_DIR, 'evals'), path.join(pluginDir, 'evals'), { recursive: true });
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'specseal-skill-evals-'));
  try {
    execFileSync(specseal, ['init', workspace, '--tools', 'claude'], { stdio: 'ignore' });
    execFileSync(specseal, ['workflow-config', 'set', 'worktree', 'true'], { cwd: workspace, stdio: 'ignore' });
    execFileSync(specseal, ['update'], { cwd: workspace, stdio: 'ignore' });
    const skillsDir = path.join(workspace, '.claude', 'skills');
    for (const name of readdirSync(skillsDir).filter((entry) => entry.startsWith('specseal-'))) {
      cpSync(path.join(skillsDir, name), path.join(pluginDir, 'skills', name), { recursive: true });
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

/// macOS 的 /usr/bin/git 是 xcrun 转接程序：它要把缓存写进系统暂存目录，评测沙箱不准；
/// 真正的 git 在 /Library/Developer 底下，沙箱也读不到。所以把真正的 git 拷贝到受测
/// 运行档旁边，受测模型与 specseal 都用这一支（内置子指令不需要 git-core 目录）。
function copyRealGit(binDir) {
  if (process.platform !== 'darwin') return;
  const git = execFileSync('xcrun', ['--find', 'git'], { encoding: 'utf8' }).trim();
  copyFileSync(git, path.join(binDir, 'git'));
  chmodSync(path.join(binDir, 'git'), 0o755);
}

function runMain(argv) {
  const { options, errors } = parseRunArgs(argv);
  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    return 1;
  }
  const { outDir, binDir, pluginDir } = runPaths(options.label);
  const specseal = path.join(binDir, 'specseal');

  mkdirSync(binDir, { recursive: true });
  copyFileSync(path.resolve(options.specseal), specseal);
  chmodSync(specseal, 0o755);
  copyRealGit(binDir);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, 'specseal-version.txt'), execFileSync(specseal, ['--version'], { encoding: 'utf8' }));
  stagePlugin(specseal, pluginDir);

  const args = ['plugin', 'eval', pluginDir, '--scaffold', '--ablation', 'none', '--runs', options.runs, '--model', options.model];
  // 缺省的 Haiku 评审对明显符合的回复也会投 FAIL，评审改用 Sonnet。
  args.push('--judge-model', JUDGE_MODEL);
  // apply-with-worktree 与 worktree-merge 的 worktree 在工作区旁边（同一个暂存根目录下），
  // 只给 Write／Edit 的话写不进去。
  args.push('--allow-tools', 'Bash', 'Edit', 'Write', 'Edit(//private/tmp/**)', 'Write(//private/tmp/**)', 'Edit(//tmp/**)', 'Write(//tmp/**)');
  args.push('--trust-plugin', '--no-publish', '--threshold', '0');
  args.push('--max-cost-usd', options['max-cost-usd'], '--output-dir', outDir);
  if (options.case !== undefined) args.push('--case', options.case);
  const child = spawnSync('claude', args, evalSpawnOptions(binDir));
  if (child.error) {
    console.error(`无法启动 claude：${child.error.message}`);
    return 1;
  }
  return child.status ?? 1;
}

function main([command, ...rest]) {
  if (command === 'compare') return compareMain(rest);
  if (command === 'run') return runMain(rest);
  console.error('用法：node scripts/claude-code/skill-evals.mjs <run|compare> ...');
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exit(main(process.argv.slice(2)));
}
