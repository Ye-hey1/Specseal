// CLI 布署纯逻辑（desktop-app spec「安装 CLI 指令到 PATH」，design D5）：状态
// 判定与平台分流的布署计划。文件系统与子进程归 Tauri 壳（收集事实、运行计划），
// 这里只做决策——vitest 可测、不依赖 Tauri。
export type CliPlatform = "macos" | "windows" | "linux-appimage" | "linux-unpackaged";

export type CliInstallStatus =
  | { kind: "not-installed" }
  | { kind: "installed"; version: string }
  | { kind: "version-mismatch"; version: string };

export type CliDeployPlan =
  | { action: "symlink"; linkPath: string; targetPath: string }
  | { action: "copy"; destPath: string; sourcePath: string }
  | { action: "none"; reason: "installer-managed" | "unpackaged" };

/** 以侦测到的已布署版本（null＝未侦测到）对 app 版本判定三态。 */
export function cliInstallStatus(
  deployedVersion: string | null,
  appVersion: string,
): CliInstallStatus {
  if (deployedVersion === null) return { kind: "not-installed" };
  if (deployedVersion === appVersion) return { kind: "installed", version: deployedVersion };
  return { kind: "version-mismatch", version: deployedVersion };
}

/** 解析 `specseal --version` 输出的套件版号（如「specseal 0.1.0 (arm64, engine
 * v1.14.0)」取 0.1.0；括号内的引擎版号不参与布署判定）；不合形回 null。 */
export function parseCliVersion(output: string): string | null {
  return output.match(/^specseal (\S+)/)?.[1] ?? null;
}

/** 平台分流的布署计划（design D5）：macOS symlink（app 路径固定、更新后自动指向
 * 新版）；AppImage 拷贝（挂载点随运行变动、symlink 不可行）；Windows 由 NSIS
 * 安装器写 PATH；Linux 非 AppImage（开发建置或手动解开的 app，deb 已退场——
 * release-assets-trim D7）没有可布署的来源——后两者 app 内仅回报状态。 */
export function cliDeployPlan(
  platform: CliPlatform,
  ctx: { home: string; bundledCliPath: string },
): CliDeployPlan {
  switch (platform) {
    case "macos":
      return {
        action: "symlink",
        linkPath: `${ctx.home}/.local/bin/specseal`,
        targetPath: ctx.bundledCliPath,
      };
    case "linux-appimage":
      return {
        action: "copy",
        destPath: `${ctx.home}/.local/bin/specseal`,
        sourcePath: ctx.bundledCliPath,
      };
    case "windows":
      return { action: "none", reason: "installer-managed" };
    case "linux-unpackaged":
      return { action: "none", reason: "unpackaged" };
  }
}

/** 启动自动布署判定（spec 修订「macOS 启动自动布署与自我修复」＋「AppImage
 * 版本不符自我修复」，design D12）：macOS 未安装或版本不符皆自动布署（symlink
 * 幂等无副作用）；AppImage 仅版本不符时修复——未安装仍是用户的显式动作
 * （拷贝布署较重）；Windows 归安装器、Linux 非 AppImage 无来源可布。 */
export function needsRedeploy(platform: CliPlatform, status: CliInstallStatus): boolean {
  if (platform === "macos") return status.kind !== "installed";
  return platform === "linux-appimage" && status.kind === "version-mismatch";
}

/** ~/.zprofile 的识别注解：追加行带着它，幂等判定靠它。 */
export const ZPROFILE_MARKER = "# specseal cli";

export type ZprofilePlan = { action: "append"; line: string } | { action: "none" };

/** macOS PATH 追加决策（design D12）：已在 PATH 或 zprofile 已有识别行→不写；
 * 否则输出带识别注解的一行（zprofile 读不到视为空档）。写档归 adapter。 */
export function zprofilePlan(onPath: boolean, zprofile: string | null): ZprofilePlan {
  if (onPath) return { action: "none" };
  if ((zprofile ?? "").includes(ZPROFILE_MARKER)) return { action: "none" };
  return { action: "append", line: `export PATH="$HOME/.local/bin:$PATH" ${ZPROFILE_MARKER}` };
}

/** 布署目录是否已在 PATH 上；否则接口提示加入方式。 */
export function isDirOnPath(dir: string, pathEnv: string, delimiter: ":" | ";"): boolean {
  return pathEnv.split(delimiter).includes(dir);
}
