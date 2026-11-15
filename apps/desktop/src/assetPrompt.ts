// 技能档过期提示的裁决与略过记忆（desktop-instruction-staleness-prompt 决策 6/7）：
// 探测回报是引擎事实，是否显示提示则是本机个人决定——「保留现状」写入 app 本机
// 持久化（项目路径 → 已略过的产物层版号），不进 .specseal.yaml、不进任何 repo 文件。
// 规格文件夹迁移由同一张提示承载（desktop-spec-dir-migration D2）。
// remote 项目的基准是 Server 提供的技能（remote-skill-delivery D6）：同一套裁决，略过的键
// 改用 Server 的版本。
import type { AssetProbeResult, MigrationProbe } from "./adapter/workspace";

/** 提示的呈现态：主动作依此分文案（过期→更新、缺失→安装、较新→无改写动作、
 * migrate＝技能档是现版、只有规格文件夹要迁移）。 */
export interface AssetPromptState {
  kind: "stale" | "missing" | "newer" | "migrate";
  /** 将被新建或改写且内容有异的受管档数。 */
  fileCount: number;
  /** 此提示对应的版号（「保留现状」记的就是它）：本机项目是这个 app 内置的技能版号，
   * remote 项目是 Server 提供的技能版本。 */
  version: string;
  /** 项目指令档的标记版号（确认框「这个项目的技能档版本」列）；从未安装为 null。 */
  projectVersion: string | null;
  /** 按更新时规格文件夹会怎样；较新态恒为 none（引擎拒绝这次更新），migrate 态恒为 pending。 */
  migration: MigrationProbe;
  /** remote 项目才有。`appVersion` 是这个 app 内置的技能版号（确认框「你的 Specseal 版本」
   * 列）；`appOlder` 为真时 app 比 Server 旧，确认框多一句说明与「更新 Specseal」。 */
  server?: { appVersion: string; appOlder: boolean };
}

// 沿用改名前的 key：既有用户的略过记忆存在这个名字下，换名等于全部失效。
const STORAGE_KEY = "specseal.instructionSkips";

/** 读取略过记忆（项目 → 已略过版号；本机项目的键是项目路径，remote 项目是分页的键）。坏 JSON 或不识别形状一律视为无记忆。 */
export function readAssetSkips(storage: Storage = localStorage): Record<string, string> {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [root, version] of Object.entries(parsed)) {
      if (typeof version === "string") out[root] = version;
    }
    return out;
  } catch {
    return {};
  }
}

/** 记下「此项目于此版号已保留现状」。同项目再次略过时覆盖旧版号。`skipKey` 是项目在略过
 * 记忆里的键：本机项目是项目路径，remote 项目是分页的键。 */
export function writeAssetSkip(
  skipKey: string,
  version: string,
  storage: Storage = localStorage,
): void {
  const skips = { ...readAssetSkips(storage), [skipKey]: version };
  storage.setItem(STORAGE_KEY, JSON.stringify(skips));
}

/** 显示裁决（规格「技能档过期探测」的提示面）：过期、缺失或较新才提示，技能档是现版
 * 但规格文件夹待迁移时也提示；且该项目未略过当前版号。技能档是现版而迁移暂缓时不提示：
 * 略过以版号为键，暂缓时的略过会压掉排除原因后的待迁移提示——暂缓原因只在过期或缺失的
 * 提示里说明。无法判定一律不提示——无法判定不记入略过、也不视同现版。 */
export function assetPrompt(
  probe: AssetProbeResult,
  skipKey: string,
  skips: Record<string, string>,
): AssetPromptState | null {
  const { migration, status } = probe;
  const kind =
    status === "stale" || status === "missing" || status === "newer"
      ? status
      : status === "current" && migration.state === "pending"
        ? "migrate"
        : null;
  if (!kind) return null;
  const version = probe.serverVersion ?? probe.currentVersion;
  if (skips[skipKey] === version) return null;
  // 项目的技能档版号取触发这个状态的工具：较新取领先的、过期取落后的；缺失（从未安装）为 null；
  // 现版取第一个有版号的工具。
  const flagged =
    kind === "missing"
      ? undefined
      : probe.tools.find(
          (tool) =>
            (kind === "newer" ? tool.newer : kind === "stale" ? tool.stale : true) && tool.workspaceVersion !== null,
        );
  return {
    kind,
    fileCount: probe.differingFiles.length,
    version,
    projectVersion: flagged?.workspaceVersion ?? null,
    migration: kind === "newer" ? { state: "none" } : migration,
    ...(probe.serverVersion === undefined
      ? {}
      : { server: { appVersion: probe.currentVersion, appOlder: probe.appOlderThanServer === true } }),
  };
}
