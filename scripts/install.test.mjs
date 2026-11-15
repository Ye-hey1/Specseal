// CLI 安装脚本的单元测试（cli-distribution spec「安装脚本一行安装对应平台 CLI」，
// design D3／release-assets-trim D6：binary 来源改为 npm registry 的平台子套件 tgz）。
// 以子行程运行 scripts/install.sh。
//
// 平台侦测与下载都靠外部指令，因此测试在 PATH 前置假的 uname 与 curl——脚本本身
// 不必为了可测而开任何测试专用旗标，被验的就是正式路径。integrity 用真的 openssl
// 对 fixture 实算，验的是真正的比对行为而非桩。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts/install.sh');

const VERSION = '0.5.0';
const REGISTRY = 'https://registry.npmjs.org';
const tgzUrl = (platform, version, registry = REGISTRY) =>
  `${registry}/@specseal/cli-${platform}/-/cli-${platform}-${version}.tgz`;

/// 假 uname：依环境变量回答 -s／-m，让五组平台矩阵都能在单一机器上验。
const FAKE_UNAME = `#!/bin/sh
case "$1" in
  -s) echo "$FAKE_UNAME_S" ;;
  -m) echo "$FAKE_UNAME_M" ;;
  *) echo "$FAKE_UNAME_S" ;;
esac
`;

/// 假 curl：记录每次调用，并以 fixture 目录中与 URL 最后一段同名的文件作为回应
/// （registry 的三种请求：.../cli/latest、.../cli-<平台>/<版本>、.../-/<tgz>）。
/// 找不到对应 fixture 时以 22 结束（curl 对 HTTP 错误的惯用码），让脚本的失败路径也走得到。
const FAKE_CURL = `#!/bin/sh
echo "$@" >> "$FAKE_CURL_LOG"
out=""
url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
name=$(basename "$url")
src="$FAKE_FIXTURES/$name"
[ -f "$src" ] || exit 22
if [ -n "$out" ]; then cp "$src" "$out"; else cat "$src"; fi
`;

function integrityOf(buffer) {
  return `sha512-${createHash('sha512').update(buffer).digest('base64')}`;
}

/// 布置一次运行所需的沙盒：假指令目录、fixture 目录、安装目录与 curl 调用纪录。
function sandbox(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'specseal-install-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const binDir = path.join(dir, 'fakebin');
  const fixtures = path.join(dir, 'fixtures');
  const installDir = path.join(dir, 'install');
  mkdirSync(binDir);
  mkdirSync(fixtures);
  mkdirSync(installDir);

  for (const [name, body] of [['uname', FAKE_UNAME], ['curl', FAKE_CURL]]) {
    const file = path.join(binDir, name);
    writeFileSync(file, body);
    chmodSync(file, 0o755);
  }

  return { dir, binDir, fixtures, installDir, curlLog: path.join(dir, 'curl.log') };
}

/// 造出 registry 的三份回应：主套件 latest、平台子套件的版本清单（含 dist.integrity）、
/// 平台子套件的 tgz（npm 布局：package/specseal）。badIntegrity 时故意写错 integrity，
/// noIntegrity 时版本清单缺 dist.integrity。
function stageRegistry(box, { platform, version = VERSION, badIntegrity = false, noIntegrity = false } = {}) {
  const payloadDir = path.join(box.dir, 'payload', 'package');
  mkdirSync(payloadDir, { recursive: true });
  // 内容可辨识——安装后以此断言确实是解出来的那一份；--version 回该版，对齐 spec
  // 「安装完成后版本可验」的 THEN（真 binary 的版本比对留给发版后的手动验证）。
  writeFileSync(
    path.join(payloadDir, 'specseal'),
    `#!/bin/sh\ncase "$1" in --version) echo "specseal ${version}" ;; *) echo specseal-fixture ;; esac\n`,
  );
  chmodSync(path.join(payloadDir, 'specseal'), 0o755);

  const tgzName = `cli-${platform}-${version}.tgz`;
  const archive = path.join(box.fixtures, tgzName);
  const tarResult = spawnSync('tar', ['czf', archive, '-C', path.dirname(payloadDir), 'package'], { encoding: 'utf8' });
  assert.equal(tarResult.status, 0, `创建 fixture tgz 失败：${tarResult.stderr}`);

  const integrity = badIntegrity ? `sha512-${'A'.repeat(86)}==` : integrityOf(readFileSync(archive));
  const manifest = {
    name: `@specseal/cli-${platform}`,
    version,
    dist: noIntegrity ? { tarball: tgzUrl(platform, version) } : { integrity, tarball: tgzUrl(platform, version) },
  };
  writeFileSync(path.join(box.fixtures, version), JSON.stringify(manifest));
  writeFileSync(path.join(box.fixtures, 'latest'), JSON.stringify({ name: '@specseal/cli', version }));

  return { tgzName };
}

function runInstall(box, { unameS, unameM, args = [], env = {} } = {}) {
  const result = spawnSync('sh', [script, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${box.binDir}:${process.env.PATH}`,
      HOME: box.dir,
      FAKE_UNAME_S: unameS,
      FAKE_UNAME_M: unameM,
      FAKE_CURL_LOG: box.curlLog,
      FAKE_FIXTURES: box.fixtures,
      ...env,
    },
  });
  const curlCalls = existsSync(box.curlLog)
    ? readFileSync(box.curlLog, 'utf8').split('\n').filter(Boolean)
    : [];
  return { ...result, curlCalls };
}

// install.sh 只出货给 macOS 与 Linux；Windows 走 npm 或桌面安装器。Git Bash 下以假的
// curl／uname 验 sh 版并不对应任何出货路径（Windows 不会解析无扩展名的假指令），
// 故 Windows 上整组跳过。
const isWindows = process.platform === 'win32';
const shTest = isWindows ? test.skip : test;

// --- 平台映射矩阵（dry-run，不碰网络） ---

const MATRIX = [
  { unameS: 'Darwin', unameM: 'arm64', platform: 'darwin-arm64' },
  { unameS: 'Darwin', unameM: 'x86_64', platform: 'darwin-x64' },
  { unameS: 'Linux', unameM: 'x86_64', platform: 'linux-x64' },
  { unameS: 'Linux', unameM: 'aarch64', platform: 'linux-arm64' },
];

for (const { unameS, unameM, platform } of MATRIX) {
  shTest(`dry-run 映射 ${unameS}/${unameM} 为 ${platform} 并组出 registry 的 tgz URL`, (t) => {
    const box = sandbox(t);

    const result = runInstall(box, {
      unameS,
      unameM,
      args: ['--dry-run'],
      env: { SPECSEAL_INSTALL_VERSION: VERSION },
    });

    assert.equal(result.status, 0, `dry-run 应成功结束\nstderr: ${result.stderr}`);
    assert.match(result.stdout, new RegExp(platform), `输出应含平台 ${platform}`);
    assert.ok(result.stdout.includes(tgzUrl(platform, VERSION)), '输出应含指向该平台子套件 tgz 的 registry URL');
    assert.deepEqual(result.curlCalls, [], 'dry-run 不得调用 curl');
  });
}

shTest('不支持的平台以非零结束并说明', (t) => {
  const box = sandbox(t);

  const result = runInstall(box, { unameS: 'Linux', unameM: 'i686', args: ['--dry-run'] });

  assert.notEqual(result.status, 0, '不支持的架构应以非零结束');
  assert.match(result.stderr, /i686/, '错误消息应点名侦测到的架构');
});

shTest('Windows 上以非零结束并导向 npm 与桌面安装器，不再提 PowerShell 脚本', (t) => {
  const box = sandbox(t);

  const result = runInstall(box, { unameS: 'MINGW64_NT-10.0', unameM: 'x86_64', args: ['--dry-run'] });

  assert.notEqual(result.status, 0, 'Windows 应以非零结束');
  assert.match(result.stderr, /npm i -g @specseal\/cli/, '错误消息应导向 npm 全域安装');
  assert.match(result.stderr, /setup\.exe/, '错误消息应导向桌面安装器');
  assert.doesNotMatch(result.stderr, /install\.ps1/, 'PowerShell 脚本已退役，不得再导向它');
});

// --- dry-run 的两条保证 ---

shTest('dry-run 不发出任何网络请求也不写入文件', (t) => {
  const box = sandbox(t);

  const result = runInstall(box, {
    unameS: 'Darwin',
    unameM: 'arm64',
    args: ['--dry-run'],
    env: { SPECSEAL_INSTALL_DIR: box.installDir },
  });

  assert.equal(result.status, 0, `dry-run 应成功结束\nstderr: ${result.stderr}`);
  assert.deepEqual(result.curlCalls, [], 'dry-run 不得调用 curl');
  assert.deepEqual(readdirSync(box.installDir), [], 'dry-run 不得写入安装目录');
});

shTest('dry-run 未钉选版本时标示将于安装时查找 registry，仍不调用 curl', (t) => {
  const box = sandbox(t);

  const result = runInstall(box, { unameS: 'Linux', unameM: 'x86_64', args: ['--dry-run'] });

  assert.equal(result.status, 0, `dry-run 应成功结束\nstderr: ${result.stderr}`);
  assert.deepEqual(result.curlCalls, [], 'dry-run 不得调用 curl');
  assert.match(result.stdout, /latest/, '未钉选版本时输出应标示为 latest');
});

// --- 环境变量覆写 ---

shTest('SPECSEAL_INSTALL_VERSION 带或不带 v 前缀都映射到同一个 tgz URL', (t) => {
  const box = sandbox(t);
  const outputs = ['v0.5.0', '0.5.0'].map((pin) => {
    const result = runInstall(box, {
      unameS: 'Darwin',
      unameM: 'arm64',
      args: ['--dry-run'],
      env: { SPECSEAL_INSTALL_VERSION: pin },
    });
    assert.equal(result.status, 0, `dry-run 应成功结束（${pin}）\nstderr: ${result.stderr}`);
    return result.stdout;
  });
  assert.equal(outputs[0], outputs[1], '两种写法的 dry-run 输出应完全相同');
  assert.ok(outputs[0].includes(tgzUrl('darwin-arm64', VERSION)), 'URL 的版本段应为去 v 前缀的 0.5.0');
});

shTest('SPECSEAL_INSTALL_REGISTRY 覆写 registry 地址', (t) => {
  const box = sandbox(t);

  const result = runInstall(box, {
    unameS: 'Linux',
    unameM: 'aarch64',
    args: ['--dry-run'],
    env: { SPECSEAL_INSTALL_VERSION: VERSION, SPECSEAL_INSTALL_REGISTRY: 'https://npm.example.test' },
  });

  assert.equal(result.status, 0, `dry-run 应成功结束\nstderr: ${result.stderr}`);
  assert.ok(result.stdout.includes(tgzUrl('linux-arm64', VERSION, 'https://npm.example.test')), 'URL 应以覆写的 registry 为底');
  assert.ok(!result.stdout.includes('registry.npmjs.org'), '覆写后不得残留缺省 registry');
});

shTest('SPECSEAL_INSTALL_DIR 覆写安装目录', (t) => {
  const box = sandbox(t);

  const result = runInstall(box, {
    unameS: 'Darwin',
    unameM: 'arm64',
    args: ['--dry-run'],
    env: { SPECSEAL_INSTALL_VERSION: VERSION, SPECSEAL_INSTALL_DIR: box.installDir },
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, new RegExp(box.installDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

shTest('未覆写时安装目录缺省为 ~/.local/bin', (t) => {
  const box = sandbox(t);

  const result = runInstall(box, {
    unameS: 'Linux',
    unameM: 'x86_64',
    args: ['--dry-run'],
    env: { SPECSEAL_INSTALL_VERSION: VERSION },
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /\.local\/bin/, '缺省安装目录应为 ~/.local/bin');
});

shTest('钉选版本时不查找 latest', (t) => {
  const box = sandbox(t);
  stageRegistry(box, { platform: 'darwin-arm64' });

  const result = runInstall(box, {
    unameS: 'Darwin',
    unameM: 'arm64',
    env: { SPECSEAL_INSTALL_VERSION: VERSION, SPECSEAL_INSTALL_DIR: box.installDir },
  });

  assert.equal(result.status, 0, `安装应成功\nstderr: ${result.stderr}`);
  assert.equal(
    result.curlCalls.some((call) => call.includes('/@specseal/cli/latest')),
    false,
    '版本已钉选时不应查找 latest',
  );
});

// --- 实际安装路径 ---

shTest('安装完成后 binary 落在安装目录且可运行', (t) => {
  const box = sandbox(t);
  stageRegistry(box, { platform: 'linux-x64' });

  const result = runInstall(box, {
    unameS: 'Linux',
    unameM: 'x86_64',
    env: { SPECSEAL_INSTALL_DIR: box.installDir },
  });

  assert.equal(result.status, 0, `安装应成功\nstderr: ${result.stderr}`);
  const installed = path.join(box.installDir, 'specseal');
  assert.ok(existsSync(installed), 'specseal 应存在于安装目录');
  assert.deepEqual(readdirSync(box.installDir), ['specseal'], '安装目录只该多出 specseal 一个档');
  const run = spawnSync(installed, { encoding: 'utf8' });
  assert.match(run.stdout, /specseal-fixture/, '安装的应是 tgz 中 package/specseal 解出的那一份');
  const version = spawnSync(installed, ['--version'], { encoding: 'utf8' });
  assert.match(version.stdout, new RegExp(VERSION.replace(/\./g, '\\.')), 'specseal --version 应印出安装的版本');
});

shTest('未钉选版本时经 registry 的 latest 解析出版本再下载', (t) => {
  const box = sandbox(t);
  stageRegistry(box, { platform: 'darwin-arm64' });

  const result = runInstall(box, {
    unameS: 'Darwin',
    unameM: 'arm64',
    env: { SPECSEAL_INSTALL_DIR: box.installDir },
  });

  assert.equal(result.status, 0, `安装应成功\nstderr: ${result.stderr}`);
  assert.ok(
    result.curlCalls.some((call) => call.includes('/@specseal/cli/latest')),
    '未钉选版本时应查找 registry 的 latest',
  );
  assert.ok(result.curlCalls.some((call) => call.includes(tgzUrl('darwin-arm64', VERSION))), '应下载解析出版本的 tgz');
  assert.ok(existsSync(path.join(box.installDir, 'specseal')));
});

// --- integrity 验证 ---

shTest('integrity 不符时以非零结束且安装目录不留任何文件', (t) => {
  const box = sandbox(t);
  stageRegistry(box, { platform: 'linux-x64', badIntegrity: true });

  const result = runInstall(box, {
    unameS: 'Linux',
    unameM: 'x86_64',
    env: { SPECSEAL_INSTALL_VERSION: VERSION, SPECSEAL_INSTALL_DIR: box.installDir },
  });

  assert.notEqual(result.status, 0, 'integrity 不符应以非零结束');
  assert.match(result.stderr, /integrity|校验/i, '错误消息应指出 integrity 不符');
  assert.deepEqual(readdirSync(box.installDir), [], 'integrity 不符时安装目录不得留下任何文件');
});

shTest('registry 的版本清单缺 integrity 时以非零结束', (t) => {
  const box = sandbox(t);
  stageRegistry(box, { platform: 'linux-x64', noIntegrity: true });

  const result = runInstall(box, {
    unameS: 'Linux',
    unameM: 'x86_64',
    env: { SPECSEAL_INSTALL_VERSION: VERSION, SPECSEAL_INSTALL_DIR: box.installDir },
  });

  assert.notEqual(result.status, 0, '缺 integrity 应以非零结束');
  assert.match(result.stderr, /integrity/i, '错误消息应指出缺少 integrity');
  assert.deepEqual(readdirSync(box.installDir), [], '缺 integrity 时安装目录不得留下任何文件');
});

// --- 参数面的尖角（sharp-edges 稽核） ---

shTest('SPECSEAL_INSTALL_VERSION 不合 X.Y.Z 形即非零结束，不组 URL 也不连网', (t) => {
  const box = sandbox(t);
  for (const bad of ['latest', '1.2', '../../etc', 'v0.5.0/../x', '0.5.0;rm -rf /']) {
    const result = runInstall(box, {
      unameS: 'Linux',
      unameM: 'x86_64',
      env: { SPECSEAL_INSTALL_VERSION: bad, SPECSEAL_INSTALL_DIR: box.installDir },
    });
    assert.notEqual(result.status, 0, `版本「${bad}」不应被接受`);
    assert.match(result.stderr, /X\.Y\.Z/, `错误消息应说明版本格式（${bad}）`);
    assert.deepEqual(result.curlCalls, [], `不合形的版本不得连网（${bad}）`);
  }
});

shTest('SPECSEAL_INSTALL_REGISTRY 非 https 即非零结束（integrity 也来自同一个 registry，明文等于没验）', (t) => {
  const box = sandbox(t);
  for (const bad of ['http://registry.npmjs.org', 'ftp://x', 'registry.npmjs.org']) {
    const result = runInstall(box, {
      unameS: 'Darwin',
      unameM: 'arm64',
      args: ['--dry-run'],
      env: { SPECSEAL_INSTALL_VERSION: VERSION, SPECSEAL_INSTALL_REGISTRY: bad },
    });
    assert.notEqual(result.status, 0, `registry「${bad}」不应被接受`);
    assert.match(result.stderr, /https/, '错误消息应说明只接受 https');
  }
});

shTest('安装目录已有指向别处的 symlink 时，换掉链接本身而不写穿到目标', (t) => {
  const box = sandbox(t);
  stageRegistry(box, { platform: 'linux-x64' });
  // 仿真桌面 app 留下的 symlink：~/.local/bin/specseal → app bundle 内的 CLI。
  const bundled = path.join(box.dir, 'bundle-cli');
  writeFileSync(bundled, '#!/bin/sh\necho bundled\n');
  chmodSync(bundled, 0o755);
  symlinkSync(bundled, path.join(box.installDir, 'specseal'));

  const result = runInstall(box, {
    unameS: 'Linux',
    unameM: 'x86_64',
    env: { SPECSEAL_INSTALL_VERSION: VERSION, SPECSEAL_INSTALL_DIR: box.installDir },
  });

  assert.equal(result.status, 0, `安装应成功\nstderr: ${result.stderr}`);
  const installed = path.join(box.installDir, 'specseal');
  assert.equal(lstatSync(installed).isSymbolicLink(), false, '安装后应是一般档，不再是 symlink');
  assert.match(spawnSync(installed, { encoding: 'utf8' }).stdout, /specseal-fixture/);
  assert.equal(readFileSync(bundled, 'utf8'), '#!/bin/sh\necho bundled\n', 'symlink 原本指到的档不得被改写');
  assert.deepEqual(readdirSync(box.installDir), ['specseal'], '不得留下暂存盘');
});

// --- musl（Alpine 等）不在支持范围 ---

shTest('Linux 上侦测到 musl 时以非零结束并说明只支持 glibc，不下载', (t) => {
  const box = sandbox(t);
  stageRegistry(box, { platform: 'linux-x64' });
  // musl 的 ldd --version 印 "musl libc (x86_64)"；glibc 印 "ldd (GNU libc) 2.39"。
  const fakeLdd = path.join(box.binDir, 'ldd');
  writeFileSync(fakeLdd, '#!/bin/sh\necho "musl libc (x86_64)"\necho "Version 1.2.4"\n');
  chmodSync(fakeLdd, 0o755);

  const result = runInstall(box, {
    unameS: 'Linux',
    unameM: 'x86_64',
    env: { SPECSEAL_INSTALL_VERSION: VERSION, SPECSEAL_INSTALL_DIR: box.installDir },
  });

  assert.notEqual(result.status, 0, 'musl 应以非零结束');
  assert.match(result.stderr, /musl/, '错误消息应点名 musl');
  assert.match(result.stderr, /glibc/, '错误消息应说明只支持 glibc');
  assert.deepEqual(result.curlCalls, [], 'musl 上不该下载');
  assert.deepEqual(readdirSync(box.installDir), [], 'musl 上安装目录不得留下任何文件');
});

// --- 失败路径不留残档 ---

/// 只含指定工具的 PATH 目录：把当前 PATH 找得到的工具以 symlink 收进来，漏掉的那个
/// 就是要仿真「机器上没装」的工具。
function toolboxWithout(box, missing) {
  const toolbox = path.join(box.dir, 'toolbox');
  mkdirSync(toolbox);
  const tools = ['sh', 'grep', 'head', 'sed', 'mktemp', 'rm', 'tar', 'mkdir', 'cp', 'chmod', 'mv', 'basename', 'cat'];
  for (const tool of tools.filter((name) => name !== missing)) {
    const found = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
    assert.ok(found, `测试机缺 ${tool}`);
    symlinkSync(found, path.join(toolbox, tool));
  }
  return toolbox;
}

shTest('找不到 openssl 时以非零结束、不下载也不写入安装目录（integrity 无法验就不装）', (t) => {
  const box = sandbox(t);
  stageRegistry(box, { platform: 'linux-x64' });
  const toolbox = toolboxWithout(box, 'openssl');

  const result = runInstall(box, {
    unameS: 'Linux',
    unameM: 'x86_64',
    env: { SPECSEAL_INSTALL_VERSION: VERSION, SPECSEAL_INSTALL_DIR: box.installDir, PATH: `${box.binDir}:${toolbox}` },
  });

  assert.notEqual(result.status, 0, '缺 openssl 应以非零结束');
  assert.match(result.stderr, /openssl/, '错误消息应点名 openssl');
  assert.deepEqual(result.curlCalls, [], '缺 openssl 时不该先下载');
  assert.deepEqual(readdirSync(box.installDir), [], '缺 openssl 时安装目录不得留下任何文件');
});

shTest('落档途中失败（chmod 非零）时暂存名的档一并清掉，安装目录不留隐藏档', (t) => {
  const box = sandbox(t);
  stageRegistry(box, { platform: 'linux-x64' });
  // 假 chmod 一律失败：cp 到暂存名之后、mv 换名之前的那一步。
  const fakeChmod = path.join(box.binDir, 'chmod');
  writeFileSync(fakeChmod, '#!/bin/sh\nexit 1\n');
  chmodSync(fakeChmod, 0o755);

  const result = runInstall(box, {
    unameS: 'Linux',
    unameM: 'x86_64',
    env: { SPECSEAL_INSTALL_VERSION: VERSION, SPECSEAL_INSTALL_DIR: box.installDir },
  });

  assert.notEqual(result.status, 0, 'chmod 失败应以非零结束');
  assert.deepEqual(readdirSync(box.installDir), [], '失败后安装目录不得留下 .specseal.tmp.* 暂存盘');
});

// --- PATH 提示 ---

shTest('安装目录不在 PATH 时提示用户', (t) => {
  const box = sandbox(t);
  stageRegistry(box, { platform: 'linux-x64' });

  const result = runInstall(box, {
    unameS: 'Linux',
    unameM: 'x86_64',
    env: { SPECSEAL_INSTALL_DIR: box.installDir },
  });

  assert.equal(result.status, 0, `安装应成功\nstderr: ${result.stderr}`);
  assert.match(
    `${result.stdout}${result.stderr}`,
    new RegExp('PATH'),
    '安装目录不在 PATH 时应提示',
  );
});
