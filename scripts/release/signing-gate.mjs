// OS 签章 secrets 的前置闸门（desktop-release spec「OS 代码签章为可插钥匙开关」，
// design D1：部分设置 fail-closed）。
//
// 用法：node scripts/release/signing-gate.mjs
//
// 输入为各 secret 的环境变量，只读「是否非空」，永不读取或输出其值。每一组 secrets
// 是全有全无：全无即该路径跳过、workflow 照常全绿；全有即激活；部分存在则以列出
// 缺项名称的错误非零结束——「已签章但未公证」对用户与未签章几乎等价，却让维护者
// 误以为已完成，因此视为设置错误而非合法中间态。
//
// 决策写入 $GITHUB_ENV 供后续步骤以 env.<键> 判断，不让各步骤各自重推：
//   SPECSEAL_MACOS_SIGNING=full|none
//   SPECSEAL_WINDOWS_SIGNING=certificate|none
import { appendFileSync } from 'node:fs';

// macOS 的凭证半组与公证半组合为一组：只签章不公证的产物照样被 Gatekeeper 拦。
const MACOS_GROUP = {
  label: 'macOS 签章与公证',
  names: [
    'APPLE_CERTIFICATE',
    'APPLE_CERTIFICATE_PASSWORD',
    'APPLE_SIGNING_IDENTITY',
    'APPLE_ID',
    'APPLE_PASSWORD',
    'APPLE_TEAM_ID',
  ],
};

const WINDOWS_CERT_GROUP = {
  label: 'Windows 本机凭证签章',
  names: ['WINDOWS_CERTIFICATE', 'WINDOWS_CERTIFICATE_PASSWORD'],
};

/// 判断一组 secrets 的状态：'full'、'none'，或列出缺项的 'partial'。
/// 只看 trim 后是否非空——填了空白字符等同未设置，落在安全的一侧（跳过而非半套签章）。
function classify(group) {
  const missing = group.names.filter((name) => (process.env[name] ?? '').trim() === '');
  if (missing.length === 0) return { state: 'full' };
  if (missing.length === group.names.length) return { state: 'none' };
  return { state: 'partial', missing };
}

const groups = [MACOS_GROUP, WINDOWS_CERT_GROUP].map((group) => ({
  group,
  result: classify(group),
}));

const partial = groups.filter(({ result }) => result.state === 'partial');
if (partial.length > 0) {
  for (const { group, result } of partial) {
    console.error(
      `::error::签章组「${group.label}」设置不完整，缺少：${result.missing.join('、')}` +
        '——请补齐该组全部 secrets，或整组移除以产出未签章安装档',
    );
  }
  process.exit(1);
}

const state = Object.fromEntries(groups.map(({ group, result }) => [group.label, result.state]));
const macos = state[MACOS_GROUP.label] === 'full' ? 'full' : 'none';
// Windows 仅本机凭证路径（SignPath 裁定不采用，design D2）。
const windows = state[WINDOWS_CERT_GROUP.label] === 'full' ? 'certificate' : 'none';

console.log(`macOS 签章：${macos}／Windows 签章：${windows}`);

if (process.env.GITHUB_ENV) {
  appendFileSync(
    process.env.GITHUB_ENV,
    `SPECSEAL_MACOS_SIGNING=${macos}\nSPECSEAL_WINDOWS_SIGNING=${windows}\n`,
  );
}
