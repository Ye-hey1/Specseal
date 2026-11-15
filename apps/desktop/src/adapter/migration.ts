import { invoke as tauriInvoke } from "@tauri-apps/api/core";

import type { InvokeFn } from "../session";

export interface MigrationResult {
  report: {
    projectRevision: number;
    documents: unknown[];
  };
  backupPath: string;
  checkoutRoot: string;
}

export interface RemoteAdoptionResult {
  backupPath: string;
  checkoutRoot: string;
}

export interface MigrationAdapter {
  migrate(
    root: string,
    connectionId: string,
    project: string,
    repo: string,
  ): Promise<MigrationResult>;
  /** 并存文件夹采用 server：只保留本机备份，不组 Bundle、不调用 import。 */
  adoptRemote(root: string): Promise<RemoteAdoptionResult>;
}

/** 桌面迁移命令的薄 adapter；Bundle、import 与本机转换顺序皆由 Rust 保证。 */
export function createMigrationAdapter(
  invoke: InvokeFn = tauriInvoke as InvokeFn,
): MigrationAdapter {
  return {
    migrate: (root, connectionId, project, repo) =>
      invoke("migrate_workspace", { root, connectionId, project, repo }),
    adoptRemote: (root) => invoke("adopt_remote_workspace", { root }),
  };
}
