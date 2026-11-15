// Specseal Server 交付 gate 的静态契约测试（delivery-baseline／server-release spec，
// design D5／D7）。以解析文档内容验证 root `test:all`、主 CI、release workflow、
// Dockerfile、.dockerignore 与部署文档的关键属性；不运行任何 build。
//
// RED 先行：对现况这些断言应失败，改好设置后才转绿。所有断言只做静态解析，
// 让 gate 的结构性保证（顺序、fail-fast、无 Node runtime、内嵌来源）可回归。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), 'utf8');
}

/// 回传 needle 在 haystack 的起始索引，找不到时以带标签的消息 fail——把「缺片段」
/// 与「顺序错」两种失败分开，避免 indexOf 回 -1 让顺序断言假性通过。
function requireIndex(haystack, needle, label) {
  const i = haystack.indexOf(needle);
  assert.notEqual(i, -1, `${label}: 找不到片段 ${JSON.stringify(needle)}`);
  return i;
}

// --- root test:all（delivery-baseline「root 单一指令完整验证」） ---

test('test:all 依序纳入五个测试面，且 apps/server-web build 排在 cargo test --workspace 之前', () => {
  const pkg = JSON.parse(read('package.json'));
  const script = pkg.scripts?.['test:all'];
  assert.ok(script, 'package.json 缺少 test:all script');

  // 五个测试面都在链上。
  assert.match(script, /npm test -w packages\/ui/, 'test:all 缺少 packages/ui 测试面');
  assert.match(script, /npm test -w apps\/desktop/, 'test:all 缺少 apps/desktop 测试面');
  assert.match(script, /npm test -w apps\/server-web/, 'test:all 缺少 apps/server-web 测试面');
  assert.match(script, /cargo test --workspace/, 'test:all 缺少 Rust workspace 测试面');
  assert.match(script, /specseal-node/, 'test:all 缺少 crates/adapters/specseal-node 测试面');

  // server-web production build 存在，且排在 cargo test --workspace 之前——
  // Rust 的 embedded asset／route 测试才验到当次 source 产出的 index 与 manifest。
  const webBuild = requireIndex(script, 'npm run build -w apps/server-web', 'test:all');
  const cargoTest = requireIndex(script, 'cargo test --workspace', 'test:all');
  assert.ok(
    webBuild < cargoTest,
    `test:all：apps/server-web build 必须排在 cargo test --workspace 之前\n${script}`,
  );
});

test('test:all 全程以 && 串接，任一面失败即以非零 exit 中止', () => {
  const pkg = JSON.parse(read('package.json'));
  const script = pkg.scripts['test:all'];

  assert.match(script, /&&/, 'test:all 应以 && 串接');
  assert.doesNotMatch(script, /;/, 'test:all 不得用 ; 串接，否则前段失败仍续跑');
  // 添加的 server-web 测试面前后都挂 &&，确保它也在 fail-fast 链上。
  assert.match(
    script,
    /&&\s*npm test -w apps\/server-web\s*&&/,
    'apps/server-web 测试面必须夹在 && 之间',
  );
});

// --- 开发建置（delivery-baseline「开发建置不保留调试中间档」） ---

const DEV_DEBUG_WHY =
  'Cargo.toml 的 dev profile 必须关闭调试信息（[profile.dev] debug = false）：' +
  'macOS 缺省把调试信息留在 .o 中间档、重新编译不删旧档，会在 target/debug/deps 累积到数百万个，拖慢每次 rustc 启动';

/// 检查 Cargo.toml 内容的 dev profile 是否关闭调试信息；通过回 null，否则回失败消息。
/// 逐行找出 `[profile.dev]` 标头到下一个 `[` 标头之间的区段，只看 debug 键——
/// 不引入 TOML 解析套件，scripts 测试面维持零外部依赖。
function devProfileDebugIssue(toml) {
  let inDev = false;
  let seen = false;
  let value;
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (line.startsWith('[')) {
      inDev = line === '[profile.dev]';
      seen ||= inDev;
    } else if (inDev) {
      value = line.match(/^debug\s*=\s*(.+)$/)?.[1] ?? value;
    }
  }
  if (!seen) return `缺少 [profile.dev] 区段。${DEV_DEBUG_WHY}`;
  if (value !== 'false' && value !== '0') {
    return `[profile.dev] 的 debug 是 ${value ?? '（未设置）'}。${DEV_DEBUG_WHY}`;
  }
  return null;
}

test('dev profile 关闭调试信息（debug = false），避免 .o 在 target/debug/deps 累积', () => {
  // 判定对照 spec 范例表：只有 false 与 0 算关闭。
  const examples = [
    ['[profile.dev]\ndebug = false\n', true],
    ['[profile.dev]\ndebug = 0\n', true],
    ['[profile.dev]\ndebug = "line-tables-only"\n', false],
    ['[profile.dev]\ndebug = true\n', false],
    ['[profile.dev]\nopt-level = 0\n', false],
    ['[workspace]\nresolver = "2"\n', false],
  ];
  for (const [toml, passes] of examples) {
    assert.equal(devProfileDebugIssue(toml) === null, passes, `范例判定错误：\n${toml}`);
  }

  const issue = devProfileDebugIssue(read('Cargo.toml'));
  assert.equal(issue, null, issue ?? undefined);
});

// --- 主 CI（delivery-baseline「CI 运行完整测试」） ---

test('ci.yml 三平台跑三个 React workspace 测试、server-web build 先于 cargo test，且测试步骤不允许失败', () => {
  const ci = read('.github/workflows/ci.yml');

  for (const os of ['ubuntu-latest', 'macos-latest', 'windows-latest']) {
    assert.ok(ci.includes(os), `ci.yml 缺少操作系统 ${os}`);
  }

  assert.match(ci, /npm test -w packages\/ui/, 'ci.yml 缺少 packages/ui 测试步骤');
  assert.match(ci, /npm test -w apps\/desktop/, 'ci.yml 缺少 apps/desktop 测试步骤');
  assert.match(ci, /npm test -w apps\/server-web/, 'ci.yml 缺少 apps/server-web 测试步骤');

  // server-web production build 排在 cargo test --workspace 之前。
  const webBuild = requireIndex(ci, 'npm run build -w apps/server-web', 'ci.yml');
  const cargoTest = requireIndex(ci, 'cargo test --workspace', 'ci.yml');
  assert.ok(webBuild < cargoTest, 'ci.yml：server-web build 必须排在 cargo test --workspace 之前');

  // 测试与 build 步骤不得标记为允许失败。
  assert.doesNotMatch(
    ci,
    /continue-on-error:\s*true/,
    'ci.yml 测试／build 步骤不得设 continue-on-error: true',
  );
});

// --- release.yml 桌面 bundle 目标（desktop-release「更新描述档随 release 发布」） ---

test('release.yml 每个桌面平台都建置至少一个 updater-enabled bundle 目标', () => {
  const release = read('.github/workflows/release.yml');

  // Tauri 只为 app／appimage／msi／nsis 这几个目标产出更新包；dmg 与 deb 不在其中。
  // macOS 若只建 dmg，bundler 会印警告并且不产出 Specseal.app.tar.gz——收集步骤的
  // cp 随即找不到文档，desktop job 红灯，Release 全有全无的闸门让整次发版落空。
  const UPDATER_ENABLED = ['app', 'appimage', 'msi', 'nsis'];

  const declared = [...release.matchAll(/^\s*bundles:\s*(\S+)\s*$/gm)].map((m) => m[1]);
  assert.ok(declared.length > 0, 'release.yml：找不到任何 bundles 声明');

  for (const entry of declared) {
    const targets = entry.split(',');
    assert.ok(
      targets.some((t) => UPDATER_ENABLED.includes(t)),
      `release.yml：bundles「${entry}」不含任何 updater-enabled 目标（${UPDATER_ENABLED.join('／')}），` +
        '该平台不会产出更新包，收集步骤会找不到文档',
    );
  }
});

test('release.yml 的 Linux 桌面建置安装 AppImage 打包所需的 xdg-utils 与 FUSE', () => {
  const release = read('.github/workflows/release.yml');

  // AppImage 的 bundler 会调用 xdg-open；ubuntu-24.04-arm 映像未内置 xdg-utils
  // （22.04 有），只装 FUSE 会让 arm64 的桌面 job 在打包最后一步才炸。
  assert.match(release, /xdg-utils/, 'release.yml：Linux 依赖缺 xdg-utils（AppImage 需要 xdg-open）');
  assert.match(release, /libfuse2/, 'release.yml：Linux 依赖缺 FUSE（AppImage 打包需要）');
});

test('ci.yml 跑 scripts 测试面，且以 bash 展开 glob 以兼容 CI 钉选的 Node 版本', () => {
  const ci = read('.github/workflows/ci.yml');

  const step = requireIndex(ci, 'node --test scripts/*.test.mjs scripts/*/*.test.mjs', 'ci.yml');

  // Node 20 的 --test 不自行展开 glob（该能力 Node 21 才有），Windows runner 的
  // 缺省 shell 也不展开——两者相加会让步骤以「找不到文档」失败而非跑测试。
  // 指定 shell: bash 让 glob 在传给 node 之前就被展开，三平台与钉选版本都成立。
  const shellDecl = ci.lastIndexOf('shell: bash', step);
  assert.notEqual(shellDecl, -1, 'ci.yml：scripts 测试步骤必须指定 shell: bash');
  assert.ok(
    ci.slice(shellDecl, step).split('\n').length <= 3,
    'ci.yml：shell: bash 必须属于 scripts 测试步骤本身，而非更上面的其他步骤',
  );
});

/// 把 ci.yml 依顶层 job 切段（`jobs:` 底下的两空格 key）。前置产物的顺序必须逐
/// job 检查——用全档 indexOf 会让 A job 的建置步骤冒充 B job 的前置，断言看起来
/// 通过、CI 上该 job 仍因缺产物而编不动。
function ciJobs() {
  const ci = read('.github/workflows/ci.yml');
  const body = ci.slice(requireIndex(ci, '\njobs:', 'ci.yml'));
  const jobs = new Map();
  let current = null;
  for (const line of body.split('\n')) {
    const header = line.match(/^ {2}([\w-]+):\s*$/);
    if (header) {
      current = header[1];
      jobs.set(current, []);
    } else if (current) {
      jobs.get(current).push(line);
    }
  }
  return [...jobs].map(([name, lines]) => [name, lines.join('\n')]);
}

/// job 内每个会编到该 crate 的 cargo 指令之前，都必须先备好指定产物。
function assertStagedBeforeCargo(job, body, prerequisite, cargoPatterns, artifact) {
  for (const pattern of cargoPatterns) {
    const hit = body.match(pattern);
    if (!hit) continue;
    const stagedAt = body.indexOf(prerequisite);
    assert.notEqual(
      stagedAt,
      -1,
      `ci.yml job ${job}：「${hit[0]}」会编到需要${artifact}的 crate，但 job 内没有 ${prerequisite}`,
    );
    assert.ok(
      stagedAt < body.indexOf(hit[0]),
      `ci.yml job ${job}：${prerequisite} 必须排在「${hit[0]}」之前`,
    );
  }
}

// specseal-desktop 的 build script 于编译期检查 tauri.conf.json 的 externalBin
// 是否存在，而 binaries/ 是 gitignored——CI 没布就不是测试红字，是 build script
// 直接让整个 job 挂掉。
const COMPILES_DESKTOP = [/cargo test --workspace/, /cargo test\b[^\n]*-p specseal-desktop/];

// specseal-server 的 lib 以 RustEmbed 内嵌 apps/server-web/dist（同样 gitignored），
// 缺文档夹则 derive 于编译期失败。desktop 的 dev-dependencies 带 specseal-server，
// 所以编 desktop 的 job 也吃这份前置。
const COMPILES_SERVER = [...COMPILES_DESKTOP, /cargo test\b[^\n]*-p specseal-server/];

test('ci.yml：凡编译 specseal-desktop 的 job，都在 cargo 之前布好 CLI sidecar', () => {
  for (const [job, body] of ciJobs()) {
    assertStagedBeforeCargo(
      job,
      body,
      'node scripts/desktop/desktop-sidecar.mjs',
      COMPILES_DESKTOP,
      ' CLI sidecar',
    );
  }
});

test('ci.yml：凡编译 specseal-server 的 job，都在 cargo 之前建好 server-web dist', () => {
  for (const [job, body] of ciJobs()) {
    assertStagedBeforeCargo(
      job,
      body,
      'npm run build -w apps/server-web',
      COMPILES_SERVER,
      ' server-web dist',
    );
  }
});

test('ci.yml：每个跑 vite build 的 job 都先以 lockfile 安装依赖', () => {
  for (const [job, body] of ciJobs()) {
    for (const build of ['npm run build -w apps/server-web', 'npm run build -w apps/desktop']) {
      const buildAt = body.indexOf(build);
      if (buildAt === -1) continue;
      const installAt = body.indexOf('npm ci');
      assert.notEqual(installAt, -1, `ci.yml job ${job}：有 ${build} 却没有 npm ci`);
      assert.ok(installAt < buildAt, `ci.yml job ${job}：npm ci 必须排在 ${build} 之前`);
    }
  }
});

// --- Release（server-release） ---

test('release.yml 每个 server artifact 先建 apps/server-web 再 cargo build，并有无-dist 的 /login＋JSON-404 smoke', () => {
  const release = read('.github/workflows/release.yml');

  // server-web production build 先于 release 的 cargo build。
  const webBuild = requireIndex(release, 'npm run build -w apps/server-web', 'release.yml');
  const cargoBuild = requireIndex(release, 'cargo build --release', 'release.yml');
  assert.ok(
    webBuild < cargoBuild,
    'release.yml：apps/server-web build 必须排在 release 的 cargo build 之前',
  );

  // smoke：无相邻 dist 启动 binary，GET /login 加载内嵌 index。
  assert.match(release, /\/login/, 'release.yml 缺少 /login smoke 断言');

  // 未知 /api 路径回 JSON 404，不被 SPA fallback 吞成 200。
  assert.match(release, /\/api\/specseal\/v1\/web\//, 'release.yml 缺少未知 /api 路径的 smoke');
  assert.match(release, /404/, 'release.yml 缺少 JSON-404 断言');
});

// --- Release assets（desktop-release「Release 产出三平台桌面安装档」；设计 D1／D2／D7／D8） ---

test('release.yml 的 build job 不打包 CLI 压缩档，cli-<target> artifact 为 raw binary（CLI 通路收敛为 npm）', () => {
  const release = read('.github/workflows/release.yml');
  const build = jobBlock(release, 'build', 'release.yml');

  // 五 target 的 tar.gz／zip 不再上 Release 页——binary 只给 cli-npm-publish 物化套件。
  assert.ok(!build.includes('- name: Package'), 'release.yml build job：不得再有 Package 步骤');
  assert.ok(!/\b7z\b|tar czf/.test(build), 'release.yml build job：不得再打 zip／tar.gz');

  const upload = requireStep(
    build,
    [/uses: actions\/upload-artifact@v4/, /name:\s*cli-\$\{\{ matrix\.target \}\}/],
    'release.yml build job cli-<target> 上传',
  );
  assert.match(
    upload,
    /path:\s*target\/\$\{\{ matrix\.target \}\}\/release\/specseal\$\{\{ contains\(matrix\.target, 'windows'\) && '\.exe' \|\| '' \}\}\s*$/m,
    'release.yml build job：cli-<target> artifact 必须是 target/<triple>/release 下的 raw binary（Windows 带 .exe），与 server-<target> 同形',
  );
});

test('release.yml 的 desktop job：macOS 只出 universal、Linux 只出 AppImage、.sig 只进 updater/', () => {
  const release = read('.github/workflows/release.yml');
  const desktop = jobBlock(release, 'desktop', 'release.yml');

  // macOS universal（设计 D2）：一列 target universal-apple-darwin，两个 rustup target 都装。
  assert.match(desktop, /^\s*target:\s*universal-apple-darwin\s*$/m, 'desktop job：缺 universal-apple-darwin 的 matrix 列');
  assert.doesNotMatch(
    desktop,
    /^\s*target:\s*(?:aarch64|x86_64)-apple-darwin\s*$/m,
    'desktop job：不得再有 aarch64／x86_64 两列 macOS target',
  );
  assert.match(
    desktop,
    /rust_targets:\s*aarch64-apple-darwin,x86_64-apple-darwin/,
    'desktop job：universal 列必须声明两个 rustup target',
  );
  assert.match(desktop, /targets:\s*\$\{\{ matrix\.rust_targets \}\}/, 'desktop job：toolchain 步骤必须安装 matrix.rust_targets');
  assert.match(desktop, /platform:\s*darwin-universal/, 'desktop job：macOS 的更新包目录必须是 darwin-universal');

  // Linux 只出 AppImage（设计 D7）：deb 退场——不服务无图形 Linux，且其自动更新现况是坏的。
  const bundles = [...desktop.matchAll(/^\s*bundles:\s*(\S+)\s*$/gm)].map((m) => m[1]);
  assert.ok(bundles.length >= 3, `desktop job：bundles 声明过少（${bundles.length}）`);
  for (const entry of bundles) {
    assert.ok(!entry.split(',').includes('deb'), `desktop job：bundles「${entry}」不得含 deb`);
  }
  assert.ok(!/\bdeb\b/.test(desktop), 'desktop job：不得再出现 deb（bundles、收集步骤或注解）');

  // .sig 只进 updater/（设计 D1）：installers/ 是 Release 页的安装档集合，签章内容已内嵌 latest.json。
  const collect = requireStep(desktop, [/name: Collect installers and updater packages/], 'desktop job 收集步骤');
  for (const line of collect.split('\n').filter((l) => /\.sig/.test(l))) {
    assert.ok(!/installers\//.test(line), `desktop job：.sig 不得拷贝进 installers/：${line.trim()}`);
  }
  assert.match(
    collect,
    /Specseal_\$\{VERSION\}_universal\.app\.tar\.gz/,
    'desktop job：macOS 更新包必须改名为 Specseal_<版本>_universal.app.tar.gz',
  );
});

test('release.yml 的 release job 以 body_path 前置下载指南，changelog 接续其后', () => {
  const release = read('.github/workflows/release.yml');

  // 下载指南由产生器落档（设计 D7），body_path 指向同一个档。
  const generate = /node scripts\/release\/release-notes\.mjs --tag [^>\n]+> *(\S+)/.exec(release);
  assert.ok(generate, 'release.yml：缺 release-notes.mjs 产生下载指南的步骤');
  const bodyPath = /body_path:\s*(\S+)/.exec(release);
  assert.ok(bodyPath, 'release.yml：action-gh-release 缺 body_path');
  assert.equal(
    bodyPath[1],
    generate[1],
    'release.yml：body_path 必须指向 release-notes 产生器的输出档',
  );
  // 自动 changelog 保留，接续在指南之后。
  assert.match(release, /generate_release_notes:\s*true/, 'release.yml：generate_release_notes 不得移除');
});

/// 调用共用 npm 发布 workflow 的 job 应有的形状：uses 指向 npm-publish.yml、传入 artifact
/// pattern 与主套件名、把 NPM_TOKEN 以 secrets 传下去。materialize 有值＝下载的是 raw binary
/// 要先物化再 pack；留空＝下载的已是 tarball（engine），发布端不得重新打包。
function assertNpmPublishCaller(job, label, { artifacts, main, materialize }) {
  assert.match(job, /uses:\s*\.\/\.github\/workflows\/npm-publish\.yml/, `${label} 须重用 npm-publish.yml，不得拷贝发布循环`);
  assert.match(job, new RegExp(`artifacts:\\s*${artifacts.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm'), `${label} 须下载 ${artifacts}`);
  assert.match(job, new RegExp(`main-package:\\s*'?${main}'?\\s*$`, 'm'), `${label} 的主套件须为 ${main}`);
  if (materialize) {
    assert.match(job, new RegExp(`materialize:\\s*${materialize.replace(/[.\/]/g, '\\$&')}\\s*$`, 'm'), `${label} 须以 ${materialize} 物化`);
  } else {
    assert.ok(!/materialize:/.test(job), `${label} 的发布单位是上游打包好的 tarball，不得再物化重 pack`);
  }
  assert.match(job, /secrets:\s*\n\s+NPM_TOKEN:\s*\$\{\{ secrets\.NPM_TOKEN \}\}/, `${label} 须把 NPM_TOKEN 传给共用 workflow`);
}

test('npm-publish.yml（workflow_call）：NPM_TOKEN 闸门、物化＋pack 或沿用 tarball、版号 fail-closed、幂等、子套件先发、等主套件可见、输出 published', () => {
  const wf = read('.github/workflows/npm-publish.yml');

  // 只能被调用，不自行触发；输入面就是三个调用端的差异。
  assert.match(wf, /^on:\s*\n\s+workflow_call:/m, 'npm-publish.yml 只能以 workflow_call 触发');
  for (const input of ['artifacts', 'main-package', 'materialize', 'sums-artifact']) {
    assert.match(wf, new RegExp(`\\n\\s+${input}:\\n`), `npm-publish.yml 缺 ${input} 输入`);
  }
  assert.match(wf, /secrets:\s*\n\s+NPM_TOKEN:/, 'npm-publish.yml 须声明 NPM_TOKEN secret');
  assert.match(wf, /outputs:\s*\n\s+published:\s*\n[\s\S]{0,200}value:\s*\$\{\{ jobs\.publish\.outputs\.published \}\}/, 'npm-publish.yml 须把 job 的 published 转成 workflow 输出');

  const job = jobBlock(wf, 'publish', 'npm-publish.yml');
  assert.match(job, /NPM_TOKEN/, '发布 job 必须以 NPM_TOKEN 为开关');
  assert.match(job, /outputs:\n\s+published:/, '发布 job 必须输出 published');
  // 输入不得内插进 run:（tag 名与输入值都可能含 shell 特殊字符），一律经 env 传入。
  assert.ok(!/run:[^\n]*\$\{\{\s*inputs\./.test(job), 'npm-publish.yml：inputs 不得内插进 run:，须以 env: 传入');

  const download = requireStep(job, [/uses: actions\/download-artifact@v4/], 'npm-publish.yml 下载 artifact');
  assert.match(download, /pattern:\s*\$\{\{ inputs\.artifacts \}\}/, '下载面由 artifacts 输入圈定');

  const pack = requireStep(job, [/name: Materialize and pack/], 'npm-publish.yml 物化与打包步骤');
  assert.match(pack, /if \[ -n "\$MATERIALIZE" \]/, '物化脚本有值才物化＋pack');
  assert.match(pack, /--version "\$VERSION" --binaries input --out npm-out/, '物化脚本以 --version／--binaries／--out 调用');
  assert.match(pack, /find input -type f -name '\*\.tgz'/, '无物化脚本时沿用下载到的 tarball，不重新打包');
  // 校验清单不能算在本次 pack 的 tgz 上：重跑时已上架的同版被跳过，本次重建的 bytes
  // 不一定等于 registry 那份，formula 指的是 registry 那份。
  assert.ok(!/sha256sum/.test(pack), '打包步骤不得计算校验清单（要算在 registry 取回的 tarball 上）');

  const publish = requireStep(job, [/name: Publish the platform sub-packages, then the main package/], 'npm-publish.yml 发布步骤');
  assert.match(publish, /EXPECTED="\$\{GITHUB_REF_NAME#v\}"/, '须自 tag 名算出预期版号');
  assert.match(publish, /"\$version" != "\$EXPECTED"/, '发布前须逐份断言 tarball 版号等于 tag 版（npm 发布不可撤回）');
  assert.match(publish, /npm view/, '须先查 registry 以支持重跑（同版已存在即跳过）');
  // `./` 是把关重点：`tarballs/x.tgz` 恰一个斜线会被 npm 当成 GitHub 简写 owner/repo。
  assert.match(publish, /npm publish "\.\/\$tgz" --access public/, '须公开发布 tarball，且路径要带 ./ 前缀');
  // 子套件先发、主套件最后：循环跳过主套件，主套件在循环之后单独发。
  const loop = requireIndex(publish, 'for tgz in tarballs/*.tgz; do', 'npm-publish.yml 发布循环');
  const main = requireIndex(publish, 'publish_one "$main_tgz"', 'npm-publish.yml 主套件发布');
  assert.ok(loop < main, '平台子套件必须先于主套件发布');
  assert.match(publish, /npm view "\$MAIN@\$EXPECTED"/, '收尾须以轮询确认主套件在 registry 可见');
  // 校验清单算在 registry 取回的 tarball 上（直接抓 formula 指向的同一个 tarball 网址），
  // 且在主套件可见之后、published=true 之前——formula 的 sha256 永远等于 registry 那份。
  const iVisible = requireIndex(publish, 'npm view "$MAIN@$EXPECTED"', 'npm-publish.yml 可见性轮询');
  const iFetch = requireIndex(publish, 'curl -fsSL --max-time 120 "$url"', 'npm-publish.yml 自 registry 取回 tarball');
  const iSums = requireIndex(publish, 'sha256sum *.tgz', 'npm-publish.yml 校验清单');
  const iPublished = requireIndex(publish, 'published=true', 'npm-publish.yml published 输出');
  assert.ok(iVisible < iFetch && iFetch < iSums && iSums < iPublished, '顺序须为：等可见 → 自 registry 取回 → 算 sha256 → published=true');
  assert.match(publish, /registry-tarballs/, '取回的 tarball 须落在独立目录，不与本次 pack 的混用');

  const upload = requireStep(job, [/uses: actions\/upload-artifact@v4/], 'npm-publish.yml 上传校验清单');
  assert.match(upload, /inputs\.sums-artifact != ''/, '校验清单只在 sums-artifact 有值时上传');
  assert.match(upload, /name:\s*\$\{\{ inputs\.sums-artifact \}\}/, 'artifact 名取自 sums-artifact 输入');
});

test('release.yml 的 cli-npm-publish job 重用 npm-publish.yml：下载 cli-*、以 npm-cli-package.mjs 物化、上传 cli-npm-sums 校验清单', () => {
  const release = read('.github/workflows/release.yml');
  const job = jobBlock(release, 'cli-npm-publish', 'release.yml');

  // CLI 通路的 binary 唯一来源（cli-distribution spec「CLI 以 npm 套件发布」；设计 D4／D8）：
  // 排在 Release 之后、NPM_TOKEN 缺席跳过而 job 绿、以 published 告知 tap-publish。
  assert.match(job, /needs:\s*\[?release\]?/, 'cli-npm-publish 必须 needs: release');
  assertNpmPublishCaller(job, 'cli-npm-publish', {
    artifacts: 'cli-*',
    main: '@specseal/cli',
    materialize: 'scripts/npm/npm-cli-package.mjs',
  });
  // 校验清单以 artifact 交给 tap-publish：formula 的 sha256 算在 registry 上那份 bytes。
  assert.match(job, /sums-artifact:\s*cli-npm-sums\s*$/m, 'cli-npm-publish 必须上传 cli-npm-sums artifact');
});

test('release.yml 的 tap-publish job 于 Release 与 CLI npm 发布之后、以 TAP_PUSH_TOKEN 与 published 双闸门更新 tap formula', () => {
  const release = read('.github/workflows/release.yml');
  const job = jobBlock(release, 'tap-publish', 'release.yml');

  // 通路推送排在 Release 之后，不是发布的前置条件；formula 指向 npm tgz，所以还要等
  // CLI 的 npm 发布（cli-distribution spec「Formula 随发版自动推送 tap」；设计 D5／D8）。
  assert.match(job, /needs:\s*\[release,\s*cli-npm-publish\]/, 'tap-publish 必须 needs: [release, cli-npm-publish]');
  assert.match(job, /TAP_PUSH_TOKEN/, 'tap-publish 必须以 TAP_PUSH_TOKEN 为开关');
  assert.match(
    job,
    /needs\.cli-npm-publish\.outputs\.published/,
    'tap-publish 的闸门必须读 cli-npm-publish 的 published 输出（NPM_TOKEN 缺席时 tap 一并跳过）',
  );

  const download = requireStep(job, [/uses: actions\/download-artifact@v4/], 'tap-publish 下载校验清单');
  assert.match(download, /name:\s*cli-npm-sums\s*$/m, 'tap-publish 必须下载 cli-npm-sums artifact');
  assert.ok(!job.includes('gh release download'), 'tap-publish 不得再从 Release 抓校验档');
  assert.match(
    job,
    /scripts\/release\/homebrew-formula\.mjs[^\n]*--sums cli-npm-sums\.txt/,
    'tap-publish 必须以 tgz 校验清单产出 formula',
  );
  assert.match(job, /Formula\/specseal\.rb/, 'tap-publish 必须更新 tap repo 的 Formula/specseal.rb');
});

test('release.yml 的 npm-publish job 重用 npm-publish.yml：下载 server-*、以 npm-server-package.mjs 物化', () => {
  const release = read('.github/workflows/release.yml');

  // build job 把 server binary 以独立 artifact 上传供发布 job 使用（任务 10.3 的
  // 命名契约，与 npm-server-package.mjs 的 --binaries 布局对齐）。
  assert.match(
    release,
    /name:\s*server-\$\{\{ matrix\.target \}\}/,
    'release.yml：build job 缺 server-<target> artifact 上传',
  );

  // 以完整 job 键锚定：cli-npm-publish 也含「npm-publish:」子字符串，indexOf 会切到它。
  const job = jobBlock(release, 'npm-publish', 'release.yml');
  assert.match(job, /needs:\s*\[?release\]?/, 'npm-publish 必须 needs: release');
  assertNpmPublishCaller(job, 'npm-publish', {
    artifacts: 'server-*',
    main: '@specseal/server',
    materialize: 'scripts/npm/npm-server-package.mjs',
  });
});

test('release.yml 的 Release 资产只收安装档与更新包本体：dist 只合并 desktop-*，updater-* 保留目录，.sig 不进 dist，无 SHA256SUMS', () => {
  const release = read('.github/workflows/release.yml');
  const job = jobBlock(release, 'release', 'release.yml');

  const blocks = job
    .split(/- uses: actions\/download-artifact@v4/)
    .slice(1)
    .map((block) => block.split(/\n\s*- (?:name:|uses:)/)[0]);

  // 安装档：只有 desktop-* 摊平进 dist（设计 D1）。
  const distBlocks = blocks.filter((block) => /path:\s*dist\b/.test(block));
  assert.equal(distBlocks.length, 1, `release job：下载进 dist 的步骤应恰一个（desktop-*），实际 ${distBlocks.length}`);
  assert.match(distBlocks[0], /pattern:\s*desktop-\*/, 'release job：dist 只能合并 desktop-* artifact');

  // 更新包：保留每平台子目录下载一次，供组装 latest.json。
  const updaterBlocks = blocks.filter((block) => /pattern:\s*updater-\*/.test(block));
  assert.equal(updaterBlocks.length, 1, 'release job：updater-* 应只以目录结构下载一次');
  assert.match(updaterBlocks[0], /path:\s*updater\b/, 'release job：updater-* 必须下载到 updater/');
  assert.doesNotMatch(updaterBlocks[0], /merge-multiple/, 'release job：updater-* 不得摊平合并');

  // CLI 与 server 都不进 Release assets。
  assert.ok(!blocks.some((b) => /pattern:\s*cli-\*/.test(b)), 'release job：不得再下载 cli-*（CLI 通路收敛为 npm）');
  assert.ok(!blocks.some((b) => /pattern:\s*server-/.test(b)), 'release job：不得下载 server-*');

  // 更新包本体补进 dist、签章留在 updater/：签章内容已内嵌 latest.json，发布后零读者。
  // -exec 的结尾必须是跳脱过的 `\;`（YAML 区块字面原样交给 bash）：光溜溜的 `;` 会被
  // bash 当指令结尾，find 拿不到终止符即非零结束，整个 release job 红掉。JS 正则里要写
  // `\\;` 才是字面反斜线——写 `\;` 只等于 `;`，刚好把错形钉成正典。
  assert.match(
    job,
    /find updater -type f ! -name '\*\.sig' -exec cp \{\} dist\/ \\;/,
    'release job：缺「把 updater/ 下非 .sig 的更新包拷贝进 dist」步骤，或 -exec 的结尾 `;` 没跳脱',
  );

  // 校验码档退场：唯一的机器读者（install.sh、formula 产生器）都改读 npm。
  assert.ok(!release.includes('SHA256SUMS'), 'release.yml：不得再产出或下载 SHA256SUMS.txt');
  assert.ok(!job.includes('sha256sum'), 'release job：不得再有 Checksums 步骤');
});

test('release.yml 的 docker 建置逐架构原生分开建、合并 job 打 tag（禁 QEMU 编译路径）', () => {
  const release = read('.github/workflows/release.yml');

  // 单一 job 的 platforms 同时声明双架构＝其中一个在 QEMU 仿真下编译（设计 D10
  // 要根绝的路径）；per-arch 各绑原生 runner。
  for (const m of release.matchAll(/platforms:\s*(\S+)/g)) {
    assert.ok(
      !(m[1].includes('amd64') && m[1].includes('arm64')),
      `release.yml：platforms「${m[1]}」同时声明双架构（QEMU 编译路径）`,
    );
  }
  assert.ok(!release.includes('setup-qemu'), 'release.yml：不应再安装 QEMU');
  assert.match(
    release,
    /os:\s*ubuntu-latest\n\s*platform:\s*linux\/amd64/,
    'release.yml：缺 amd64 的原生建置 matrix 项',
  );
  assert.match(
    release,
    /os:\s*ubuntu-24\.04-arm\n\s*platform:\s*linux\/arm64/,
    'release.yml：缺 arm64 的原生建置 matrix 项',
  );

  // per-arch 以 digest 推、合并 job 以 imagetools 打 tag，发布原子性由合并承担。
  assert.match(release, /push-by-digest=true/, 'release.yml：per-arch 建置必须 push by digest');
  const manifestStart = requireIndex(release, 'docker-manifest:', 'release.yml');
  const tail = release.slice(manifestStart);
  const nextJob = tail.slice(1).search(/\n  [a-z][\w-]*:\s*\n/);
  const manifest = nextJob >= 0 ? tail.slice(0, nextJob + 1) : tail;
  assert.match(manifest, /needs:\s*\[?docker\]?/, 'docker-manifest 必须 needs: docker');
  assert.match(manifest, /imagetools create/, 'docker-manifest 必须以 imagetools create 合并 digest');

  // 全有全无闸门改指向合并 job——两架构 digest 都成功打上 tag 才发布。
  assert.match(
    release,
    /needs:\s*\[build, desktop, docker-manifest\]/,
    'release.yml：release job 的 needs 闸门必须指向 docker-manifest',
  );
});

test('tauri.conf.json 的 NSIS 安装器内置繁中英文语系并用 Specseal 图标', () => {
  const conf = JSON.parse(read('apps/desktop/src-tauri/tauri.conf.json'));
  const nsis = conf.bundle?.windows?.nsis ?? {};
  // 语系跟随系统（desktop-release spec 修订后；设计 D11）：繁中系统显示繁中、
  // 其余落回英文——两者都要在清单内。
  assert.ok(Array.isArray(nsis.languages), 'nsis.languages 必须声明');
  assert.ok(nsis.languages.includes('TradChinese'), 'nsis.languages 缺 TradChinese');
  assert.ok(nsis.languages.includes('English'), 'nsis.languages 缺 English');
  assert.match(nsis.installerIcon ?? '', /icon\.ico$/, 'nsis.installerIcon 必须指向 icon.ico');
});

// --- Dockerfile（server-release「Docker multi-stage 不携带 Node runtime」） ---

test('Dockerfile 以 Node stage 产 dist、Rust stage 内嵌，最终 runtime 仅 server binary＋non-root、无 Node runtime', () => {
  const dockerfile = read('crates/host/specseal-server/Dockerfile');
  const stages = dockerfile.split(/^FROM /m).slice(1); // 每段开头是 image[ AS name]

  // node build → rust build → runtime 至少三段。
  assert.ok(
    stages.length >= 3,
    `Dockerfile 应为多阶段（node→rust→runtime），实际 ${stages.length} 段`,
  );

  // Node stage：以 lockfile 安装并运行 server-web production build。
  // web 阶段必须钉在建置机原生架构（--platform=$BUILDPLATFORM）：Vite 产出的
  // dist 架构无关，而 Node/V8 的 JIT 在 QEMU 仿真 arm64 下会偶发 SIGILL
  // （v0.1.1／v0.1.2 首跑连两次 exit 132，任务 2.7）。
  assert.match(
    dockerfile,
    /FROM --platform=\$BUILDPLATFORM node:/,
    'Dockerfile 的 Node build stage 必须带 --platform=$BUILDPLATFORM（避免 QEMU 下跑 V8）',
  );
  assert.match(dockerfile, /npm ci/, 'Node stage 必须以 lockfile 安装（npm ci）');
  assert.match(
    dockerfile,
    /npm run build -w apps\/server-web/,
    'Node stage 必须运行 apps/server-web production build',
  );

  // Rust stage 带入 Node stage 产出的 dist 供 compile-time embedding。
  assert.match(
    dockerfile,
    /COPY --from=\w+ [^\n]*apps\/server-web\/dist/,
    'Rust stage 必须带入 Node stage 建好的 dist 供内嵌',
  );

  // 最终 runtime stage：无 Node 映像、无携带 Node runtime、以 non-root 运行。
  const runtime = 'FROM ' + stages[stages.length - 1];
  assert.doesNotMatch(runtime, /^FROM node/m, '最终 runtime 不得基于 Node 映像');
  assert.doesNotMatch(
    runtime,
    /COPY --from=\w+ [^\n]*node/,
    '最终 runtime 不得从其他 stage 携带 Node runtime',
  );
  assert.match(runtime, /^USER (?!root\b)\S+/m, '最终 runtime 必须以 non-root USER 运行');
});

// --- .dockerignore 与内嵌来源（server-release fail-closed embedding） ---

test('.dockerignore 保留常规排除且不排除 apps/server-web/dist，内嵌 dist 由 image 内置', () => {
  const dockerignore = read('.dockerignore');
  const dockerfile = read('crates/host/specseal-server/Dockerfile');

  // 常规排除仍在：不把 host 的 node_modules／target 带进 build context。
  assert.match(dockerignore, /node_modules/, '.dockerignore 应排除 node_modules');
  assert.match(dockerignore, /^target$/m, '.dockerignore 应排除 target');

  // 不得以任何非注解行排除 server-web dist——若改采 host build 内嵌会断。
  const ignoresWebDist = dockerignore
    .split('\n')
    .map((line) => line.trim())
    .some((line) => line && !line.startsWith('#') && line.includes('apps/server-web/dist'));
  assert.equal(ignoresWebDist, false, '.dockerignore 不得排除 apps/server-web/dist');

  // 内嵌来源由 image 内的 Node stage 现建，embedding 永不依赖 host 的 dist。
  assert.match(
    dockerfile,
    /npm run build -w apps\/server-web/,
    'Dockerfile 必须在 image 内置 apps/server-web dist（不依赖 host build）',
  );
});

// --- 部署文档（server-release／delivery-baseline 部署面） ---

test('server-deployment 文档涵盖内嵌交付、npm→web→rust 建置顺序、runtime 无 Node/dist/CDN 与 rollback 契约', () => {
  const doc = read('docs/server-deployment.zh-CN.md');

  for (const required of [
    'apps/server-web', // SPA 来源 workspace
    '内嵌', // 资产编入单一 binary/image
    'npm ci', // 建置顺序起点：lockfile 安装
    'npm run build -w apps/server-web', // web production build
    'CDN', // runtime 不需外部 CDN
    '回退', // rollback
    '上一版', // 部署上一版 binary/image
  ]) {
    assert.ok(doc.includes(required), `server-deployment 文档缺少「${required}」`);
  }

  // 建置顺序：npm ci → apps/server-web build → 编译 specseal-server（同一句内，避免跨段误判）。
  assert.match(
    doc,
    /npm ci[\s\S]{0,160}npm run build -w apps\/server-web[\s\S]{0,160}specseal-server/,
    'server-deployment 文档应呈现 npm ci → web build → specseal-server 的建置顺序',
  );
});

// --- engine 的 npm 发布通路（node-sdk-release spec；设计 D1／D2／D3） ---

/// 从 workflow 全文切出一个 job 的区块（沿用本档既有的「下一个 job 开头」切法）。
function jobBlock(workflow, jobName, label) {
  const start = requireIndex(workflow, `\n  ${jobName}:\n`, label);
  const tail = workflow.slice(start + 1);
  const next = tail.slice(1).search(/\n  [a-z][\w-]*:\s*\n/);
  return next >= 0 ? tail.slice(0, next + 1) : tail;
}

/// 把 job 区块切成一个个 step（步骤起首为 6 空格的 `- name:`／`- uses:`）。
/// 断言锚定到单一步骤，否则「整个 job 内出现过这串字」会被注解或别的步骤满足。
function jobSteps(jobText) {
  return jobText.split(/\n {6}- (?=name:|uses:)/).slice(1);
}

/// 找出符合全部条件的唯一步骤，找不到即以带标签的消息 fail。
function requireStep(jobText, predicates, label) {
  const found = jobSteps(jobText).filter((step) => predicates.every((p) => p.test(step)));
  assert.equal(found.length, 1, `${label}: 应恰有一个步骤符合 ${predicates.join('、')}，实际 ${found.length} 个`);
  return found[0];
}

test('node-sdk.yml 可被 release 管线重用，且版号盖章不经字符串内插', () => {
  const nodeSdk = read('.github/workflows/node-sdk.yml');

  // 同档双角色（设计 D1）：push／PR 保留，另开 workflow_call 的选填 version 输入。
  assert.match(nodeSdk, /^on:/m, 'node-sdk.yml 缺 on: 区块');
  assert.match(nodeSdk, /\n  push:/, 'node-sdk.yml：push 触发不得移除');
  assert.match(nodeSdk, /\n  pull_request:/, 'node-sdk.yml：pull_request 触发不得移除');
  assert.match(nodeSdk, /\n  workflow_call:\n\s+inputs:\n\s+version:/, 'node-sdk.yml 缺 workflow_call 的 version 输入');

  const pack = jobBlock(nodeSdk, 'package', 'node-sdk.yml');

  // 盖章排在 napi artifacts 之后、npm pack 之前（设计 D2）。
  const iArtifacts = requireIndex(pack, 'npx napi artifacts', 'node-sdk.yml package job');
  const iStamp = requireIndex(pack, 'npm-engine-package.mjs', 'node-sdk.yml package job');
  // 以步骤名锚定，否则会命中注解里提到的 npm pack。
  const iPack = requireIndex(pack, 'Pack the main package', 'node-sdk.yml package job');
  assert.ok(iArtifacts < iStamp && iStamp < iPack, 'node-sdk.yml：盖章须落在 napi artifacts 与 npm pack 之间');

  // 版号经 env 传入，不得把 ${{ inputs.version }} 直接内插进 run:——tag 名可含
  // 引号与分号，内插等于把 tag 名当 shell 原代码运行。
  assert.ok(
    !/run:[^\n]*\$\{\{\s*inputs\.version\s*\}\}/.test(pack),
    'node-sdk.yml：version 不得内插进 run:，须以 env: 传入',
  );
  assert.match(pack, /env:\s*\n\s+VERSION:\s*\$\{\{ inputs\.version \}\}/, 'node-sdk.yml：盖章步骤须以 env VERSION 传入版号');

  // 平台二进位的下载面须圈定——被 release 重用后与 caller 同一个 run，不圈定
  // 会把 server-*／desktop-* 一起灌进 napi 的扫描目录。
  const binaryDownload = requireStep(
    pack,
    [/actions\/download-artifact@v4/, /path:\s*crates\/adapters\/specseal-node\/artifacts/],
    'node-sdk.yml package job：平台二进位下载步骤',
  );
  assert.match(binaryDownload, /pattern:\s*bindings-\*/, 'node-sdk.yml：平台二进位下载须以 pattern: bindings-* 圈定');

  // binding.js 由 napi build 产生且被 gitignore，主套件的 files 列了它——
  // build 要带一份出去、pack 要取回，否则 npm pack 静默略过，发出去的套件 require 就炸。
  requireStep(
    jobBlock(nodeSdk, 'build', 'node-sdk.yml'),
    [/actions\/upload-artifact@v4/, /name:\s*binding-js/],
    'node-sdk.yml build job：JS loader 上传步骤',
  );
  requireStep(
    pack,
    [/actions\/download-artifact@v4/, /name:\s*binding-js/],
    'node-sdk.yml package job：JS loader 还原步骤',
  );
  // 打包后的 fail-closed 要对称：主套件验 binding.js，子套件验 .node。napi artifacts
  // 对「找不到相符文档名」是静默 return，少了这道就会发出只有 package.json 的子套件。
  const packStep = requireStep(pack, [/name: Pack the main package/], 'node-sdk.yml package job：打包步骤');
  assert.match(packStep, /tar -tzf[\s\S]{0,200}binding\.js/, 'node-sdk.yml：打包后须断言主套件 tarball 含 binding.js');
  assert.match(packStep, /npm\/\*\/\*\.tgz[\s\S]{0,300}\\\.node/, 'node-sdk.yml：打包后须逐一断言子套件 tarball 含 .node');
});

test('release.yml 的 engine 三 job：版号前置把关、重用建置、发布幂等且子套件先发', () => {
  const release = read('.github/workflows/release.yml');

  // 版号与可发布性在单一 job 算好（Actions 表达式没有字符串裁切函数，with: 内
  // 展不开 ${GITHUB_REF_NAME#v}）；非 X.Y.Z 的 tag 不进入五平台建置。
  const version = jobBlock(release, 'engine-version', 'release.yml');
  assert.match(version, /outputs:\s*\n\s+version:/, 'engine-version 须输出 version');
  assert.match(version, /publishable:/, 'engine-version 须输出 publishable 作为前置把关');
  assert.match(version, /GITHUB_REF_NAME#v/, 'engine-version 须自 tag 名去掉 v 前缀');

  const build = jobBlock(release, 'engine-npm-build', 'release.yml');
  assert.match(build, /uses:\s*\.\/\.github\/workflows\/node-sdk\.yml/, 'engine-npm-build 须重用 node-sdk.yml，不得拷贝 build matrix');
  assert.match(build, /version:\s*\$\{\{ needs\.engine-version\.outputs\.version \}\}/, 'engine-npm-build 须传入 engine-version 算出的版号');
  assert.match(build, /if:\s*needs\.engine-version\.outputs\.publishable == 'true'/, 'engine-npm-build 须以 publishable 前置把关');

  const publish = jobBlock(release, 'engine-npm-publish', 'release.yml');
  assert.match(publish, /needs:\s*\[engine-npm-build, release\]/, 'engine-npm-publish 必须 needs: [engine-npm-build, release]');
  // 发布单位是上游打包好的 tarball（node-sdk-release spec「npm 发布闸门与发布顺序」：
  // 发布 job SHALL NOT 重新打包），所以不传 materialize；闸门、幂等、版号 fail-closed、
  // 子套件先发与收尾可见性都在共用 workflow 内，由它自己的测试钉住。
  assertNpmPublishCaller(publish, 'engine-npm-publish', { artifacts: 'npm-tarballs', main: '@specseal/engine' });
});


// --- 仓库路径守门（delivery-baseline「仓库路径守门」） ---

// 扫描面的排除项。前四项是版本控制与建置产物；`.specseal` 与 `.dev` 是本机运行与
// 开发时产生的状态（前者是冻结快照，内容是历史事实；后者由 npm run dev 整档重写）；`specseal/changes` 底下的提案必然逐字引用
// 搬移前的路径；`specseal/discussions` 与 CHANGELOG.md 同理是历史记录。
const SCAN_SKIP_DIRS = new Set(['.git', 'node_modules', 'target', 'dist', '.specseal', '.dev']);
const SCAN_SKIP_PATHS = new Set(['specseal/changes', 'specseal/discussions', 'CHANGELOG.md']);
// 反例文档（正式规格得逐字写出旧形路径）以行标记豁免，否则规格自己就是命中。
const PATH_GUARD_ALLOW = 'path-guard:allow';
const NUL = String.fromCharCode(0);

/// 逐行产出 repo 内文本档的 [相对路径, 行号, 内容]；跳过 @trace 注解区块（封存
/// 工单留下的历史文档清单）与带豁免标记的行。
function* repoTextLines(dir = root) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const rel = path.relative(root, abs).split(path.sep).join('/');
    if (SCAN_SKIP_PATHS.has(rel)) continue;
    if (entry.isDirectory()) {
      if (!SCAN_SKIP_DIRS.has(entry.name)) yield* repoTextLines(abs);
      continue;
    }
    if (!entry.isFile()) continue;
    const text = readFileSync(abs, 'utf8');
    if (text.includes(NUL)) continue; // 二进位档
    let inTrace = false;
    let lineNumber = 0;
    for (const line of text.split('\n')) {
      lineNumber += 1;
      if (inTrace) {
        inTrace = !line.includes('-->');
        continue;
      }
      if (line.includes('<!-- @trace')) {
        inTrace = !line.includes('-->');
        continue;
      }
      if (line.includes(PATH_GUARD_ALLOW)) continue;
      yield [rel, lineNumber, line];
    }
  }
}

/// 已搬进 scripts/<group>/ 的脚本文档名。清单自文档系统读出而非写死 32 个字面——
/// 添加脚本自动纳管，这支测试自己也不含任何旧形字符串。install.sh 与 install.test.mjs
/// 留在 scripts/ 根（README 的 raw GitHub 网址钉死），不在清单内。
function groupedScriptNames() {
  return ['release', 'npm', 'desktop', 'docs', 'dev'].flatMap((group) => {
    const dir = path.join(root, 'scripts', group);
    return existsSync(dir) ? readdirSync(dir) : [];
  });
}

/// 已搬进 crates/engine/specseal-core/src/<group>/ 的引擎模块名。清单写成字面而非
/// 自文档系统读出——守门在搬移前就要红，那时三个文档夹还不存在。根层的 lib、store、
/// util、keylines、testkit、teststore、demo 与 command/ 目录不在清单内。
const CORE_SRC = 'crates/engine/specseal-core/src/';
const GROUPED_CORE_MODULES = new Map([
  [
    'lifecycle',
    ['model', 'newcmd', 'inprogress', 'discard', 'archive', 'tasks',
     'status', 'listing', 'capname', 'preflight', 'discuss', 'trace'],
  ],
  ['quality', ['station', 'validate', 'analyzer', 'drift']],
  ['workspace', ['init', 'skills', 'instructions', 'config', 'schema', 'workspace']],
]);

/// 命中回传 { group, name }，否则 null。needle 由前缀常数与模块名在运行期组出，
/// 源码里没有任何旧形字面，这条断言才不会命中自己。
function findLegacyCoreModule(line) {
  for (const [group, names] of GROUPED_CORE_MODULES) {
    for (const name of names) {
      if (line.includes(`${CORE_SRC}${name}.rs`)) return { group, name };
    }
  }
  return null;
}

/// 已搬进 crates/host/specseal-server/src/<group>/ 的服务器模块名，与已搬进
/// tests/it/<group>/ 的测试档旧名。同 GROUPED_CORE_MODULES 写成字面而非自文档系统
/// 读出——守门在搬移前就要红，那时四个文档夹还不存在。src 根层的 main、lib、app、
/// config、state 与四个主模块档 identity、admin、web、api 不在清单；tests/it 根层的
/// main、e2e_cli、phase2_chain、startup、serverfs_store 与 common/ 目录亦不在清单。
const SERVER_SRC = 'crates/host/specseal-server/src/';
const SERVER_TESTS = 'crates/host/specseal-server/tests/it/';
const GROUPED_SERVER_MODULES = new Map([
  ['identity', ['identity_sqlite', 'auth', 'device', 'setup']],
  ['admin', ['audit', 'backup']],
  ['api', ['routes', 'read_api', 'verb', 'events', 'context', 'error']],
  ['web', ['assets']],
]);
const GROUPED_SERVER_TESTS = new Map([
  [
    'identity',
    ['auth_device', 'auth_pat', 'auth_whoami', 'binding', 'device_e2e',
     'device_flow', 'identity', 'invite', 'refresh_rotation'],
  ],
  [
    'admin',
    ['admin_api', 'admin_audit_filter', 'admin_data', 'admin_e2e',
     'admin_overview_view', 'admin_system', 'admin_system_view',
     'admin_three_entry', 'admin_users_view', 'admin_web_api',
     'audit', 'backup_e2e', 'backup_restore', 'cli_admin'],
  ],
  [
    'api',
    ['board_order', 'command_routes', 'context_api', 'discussion_routes',
     'drift_api', 'health', 'import_api', 'policy_write', 'query_routes',
     'read_api', 'review_api', 'sse_events', 'sync_state', 'verb_api',
     'verify_api'],
  ],
  [
    'web',
    ['web_account', 'web_activate', 'web_assets', 'web_invite',
     'web_session', 'web_setup'],
  ],
]);

/// 命中回传分组后的正典路径，否则 null。needle 由前缀常数与名字在运行期组出，源码
/// 里没有任何旧形字面。搬进组里时只去掉与组同名的前缀（identity_sqlite 成为
/// identity 组的 sqlite、admin_e2e 成为 admin 组的 e2e），其余文档名原样保留。
function findLegacyServerPath(line) {
  for (const [prefix, grouped] of [[SERVER_SRC, GROUPED_SERVER_MODULES], [SERVER_TESTS, GROUPED_SERVER_TESTS]]) {
    for (const [group, names] of grouped) {
      for (const name of names) {
        if (!line.includes(`${prefix}${name}.rs`)) continue;
        const stripped = name.startsWith(`${group}_`) ? name.slice(group.length + 1) : name;
        return `${prefix}${group}/${stripped}.rs`;
      }
    }
  }
  return null;
}

test('repo 不残留搬移前的旧形路径（crates 未分组、scripts 未分组、引擎模块未分组、服务器模块与测试档未分组）', () => {
  // needle 写成正则，源码字面带跳脱斜线，这条断言才不会命中自己。
  const legacyCrate = /crates\/specseal-/;
  const scriptNames = groupedScriptNames();
  const hits = [];

  for (const [rel, lineNumber, line] of repoTextLines()) {
    if (legacyCrate.test(line)) {
      hits.push(`${rel}:${lineNumber} 旧形 crate 路径（正典为 crates/<group>/specseal-…）\n    ${line.trim()}`);
      continue;
    }
    const script = scriptNames.find((name) => line.includes(`scripts/${name}`));
    if (script) {
      hits.push(`${rel}:${lineNumber} 旧形 script 路径（正典为 scripts/<group>/${script}）\n    ${line.trim()}`);
      continue;
    }
    const coreModule = findLegacyCoreModule(line);
    if (coreModule) {
      hits.push(
        `${rel}:${lineNumber} 旧形引擎模块路径（正典为 ${CORE_SRC}${coreModule.group}/${coreModule.name}.rs）\n    ${line.trim()}`,
      );
      continue;
    }
    const serverPath = findLegacyServerPath(line);
    if (serverPath) {
      hits.push(`${rel}:${lineNumber} 旧形服务器路径（正典为 ${serverPath}）\n    ${line.trim()}`);
    }
  }

  assert.equal(
    hits.length,
    0,
    `残留 ${hits.length} 处搬移前的路径，逐一改为分组后的路径；` +
      `只有逐字引用旧路径当反例的文档行才以 ${PATH_GUARD_ALLOW} 标记豁免：\n${hits.join('\n')}`,
  );
});
