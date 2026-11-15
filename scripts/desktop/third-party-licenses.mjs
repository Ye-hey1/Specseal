// 第三方授权清单（desktop-about-page design D3）：关于页「第三方授权」对话框的数据源，
// 建置时重生、不入版本控制（apps/desktop/package.json 的 predev 与 prebuild 串接本脚本）。
//
// 用法：node scripts/desktop/third-party-licenses.mjs
//   npm 节：package-lock.json 中 apps/desktop 与 packages/ui 的生产相依（递归，不含 dev），
//     授权取 lock 条目的 license 栏（npm 写入 lock 时照抄套件的 package.json）
//   cargo 节：cargo metadata 相依图中 specseal-desktop 与 specseal-cli 的正式相依（递归，不含 dev 与
//     build 相依），workspace 成员只穿过、不列入；cargo 无法运行或 Cargo.lock 过期时警告并输出空节
// 产出：apps/desktop/src/generated/third-party-licenses.json（{ npm, cargo }，各依名称排序；
//   授权缺席为 null，由 UI 以接口语言显示「未标示」）
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** 打包进桌面 app 的两个工作区。 */
const WORKSPACES = ['apps/desktop', 'packages/ui'];

/** 桌面 app 与随附 CLI 的 crate。 */
const CARGO_ROOTS = ['specseal-desktop', 'specseal-cli'];

const byNameThenVersion = (a, b) =>
  a.name.localeCompare(b.name) || a.version.localeCompare(b.version, undefined, { numeric: true });

/** 从 `from` 位置解析相依 `name` 的 lock 键：由近而远找 node_modules，找不到为 null。 */
function resolveKey(packages, from, name) {
  let base = from;
  for (;;) {
    const key = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
    if (packages[key]) return key;
    if (!base) return null;
    const index = base.lastIndexOf('/node_modules/');
    base = index === -1 ? '' : base.slice(0, index);
  }
}

/** lock 中两个工作区的生产相依（递归走 dependencies），工作区链接只穿过、不列入。 */
export function npmLicenses(lock) {
  const packages = lock.packages ?? {};
  const seen = new Set();
  const entries = new Map();
  const visit = (key) => {
    if (seen.has(key)) return;
    seen.add(key);
    const entry = packages[key];
    if (entry.link) return visit(entry.resolved);
    if (key.includes('node_modules/')) {
      const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
      entries.set(`${name}@${entry.version}`, { name, version: entry.version, license: entry.license ?? null });
    }
    for (const dep of Object.keys(entry.dependencies ?? {})) {
      const depKey = resolveKey(packages, key, dep);
      if (depKey) visit(depKey);
    }
  };
  for (const workspace of WORKSPACES) if (packages[workspace]) visit(workspace);
  return [...entries.values()].sort(byNameThenVersion);
}

/** 相依图中两个根 crate 的正式相依（递归走 resolve.nodes），workspace 成员只穿过、不列入。 */
export function cargoLicenses(metadata) {
  const members = new Set(metadata.workspace_members);
  const packages = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const seen = new Set();
  const visit = (id) => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const dep of nodes.get(id).deps) {
      if (dep.dep_kinds.some(({ kind }) => kind === null)) visit(dep.pkg);
    }
  };
  for (const id of members) if (CARGO_ROOTS.includes(packages.get(id).name)) visit(id);
  return [...seen]
    .filter((id) => !members.has(id))
    .map((id) => {
      const { name, version, license } = packages.get(id);
      return { name, version, license: license ?? null };
    })
    .sort(byNameThenVersion);
}

export function buildLicenseList({ lock, metadata }) {
  return { npm: npmLicenses(lock), cargo: metadata ? cargoLicenses(metadata) : [] };
}

/** 运行 cargo metadata；无法运行或非零结束时警告并回 null（建置不因此失败）。带 `--locked`：
 *  Cargo.lock 过期时失败而不改写它，后续 `cargo test --locked` 的锁档守门才有效。 */
export function readCargoMetadata({ spawn = spawnSync, warn = console.warn } = {}) {
  const args = [
    'metadata',
    '--locked',
    '--format-version',
    '1',
    '--manifest-path',
    path.join(root, 'apps/desktop/src-tauri/Cargo.toml'),
  ];
  const result = spawn('cargo', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    const reason = result.error?.message ?? result.stderr?.trim().split('\n')[0] ?? `status ${result.status}`;
    warn(`third-party-licenses: 略过 cargo 节——cargo metadata 失败（${reason}）`);
    return null;
  }
  return JSON.parse(result.stdout);
}

function main() {
  const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const list = buildLicenseList({ lock, metadata: readCargoMetadata() });
  const out = path.join(root, 'apps/desktop/src/generated/third-party-licenses.json');
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(list, null, 2)}\n`);
  console.log(`third-party-licenses: npm ${list.npm.length}、cargo ${list.cargo.length} 笔 → ${path.relative(root, out)}`);
}

// node --test 导入本模块时只取函数，不写档。
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
