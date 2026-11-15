// 更新日志弹窗的判定（desktop-app spec「更新日志弹窗」）：纯函数、不依赖 Tauri（比照
// core/updater.ts）。已看过版号存 app 本机持久化，不进任何项目文件（比照 assetPrompt.ts）。
import type { ReleaseNotesEntry } from "../release-notes/release-notes";

export type WhatsNewDecision =
  | { kind: "show"; entries: ReleaseNotesEntry[] }
  | { kind: "record" }
  | { kind: "none" };

/** 规则依序：dev→none；顶端版号≠app 版号→none（版号不齐时不弹错版内容）；无记录→record
 * （首次安装：不弹、记现版号）；已看过现版→none；否则 show 顶端起到已看过那笔之前的全部
 * （已看过版号不在清单内时只含顶端一笔；但已看过的比 app 版号还新＝降版，看过的不再弹）。 */
export function whatsNewDecision(input: {
  appVersion: string;
  entries: ReleaseNotesEntry[];
  lastSeen: string | null;
  dev: boolean;
}): WhatsNewDecision {
  const { appVersion, entries, lastSeen, dev } = input;
  if (dev) return { kind: "none" };
  if (entries.length === 0 || entries[0].version !== appVersion) return { kind: "none" };
  if (lastSeen === null) return { kind: "record" };
  if (lastSeen === appVersion) return { kind: "none" };
  const seenIndex = entries.findIndex((entry) => entry.version === lastSeen);
  if (seenIndex !== -1) return { kind: "show", entries: entries.slice(0, seenIndex) };
  return compareVersions(lastSeen, appVersion) > 0 ? { kind: "none" } : { kind: "show", entries: [entries[0]] };
}

/** X.Y.Z 逐段数值比较：正＝a 新、负＝b 新、0＝同版。 */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

const STORAGE_KEY = "specseal.lastSeenVersion";
const VERSION_SHAPE = /^\d+\.\d+\.\d+$/;

/** 读已看过版号；不是 X.Y.Z 形状的值（JSON、数字、空字符串）一律视为无记录。 */
export function readLastSeenVersion(storage: Storage = localStorage): string | null {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    return raw !== null && VERSION_SHAPE.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** 记下已看过版号；保存不可用时静默（下次启动会再弹一次，比卡住 UI 好）。 */
export function writeLastSeenVersion(version: string, storage: Storage = localStorage): void {
  try {
    storage.setItem(STORAGE_KEY, version);
  } catch {
    // 读取端同样把坏保存视为无记录。
  }
}
