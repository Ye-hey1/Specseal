import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";

import { App } from "./App";
import {
  createLocalSession,
  createRemoteSession,
  normalizeRemoteOpenFailure,
  RemoteOpenError,
  type RemoteOpenInfo,
} from "./session";
import { createConnectionsAdapter } from "./adapter/connections";
import { createWorkspaceAdapter } from "./adapter/workspace";
import { tauriUpdaterAdapter } from "./adapter/updater";
import { tauriCliInstallAdapter } from "./adapter/cliInstall";
import { tauriFsActionsAdapter } from "./adapter/fsActions";
import { loadAppInfo } from "./adapter/appInfo";
// Noto Sans TC 随 app 打包（脱机、未装字体的机器皆生效）。可变字重版：
// 单一 woff2 档族涵盖 100-900 全字重（含 600），且无静态版的 woff 旧格式死重
// ——WebView2 只取 woff2（design D3）。
import "@fontsource-variable/noto-sans-tc";
import "./index.css";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App
        createSession={(dir, name) => createLocalSession(dir, { name })}
        openRemote={async (connectionId, target, checkoutRoot) => {
          // handshake fail-closed（remote-data-source 决策 6）：remote_open 成功
          // 才建 session；失败原样上抛由打开表单呈现。
          try {
            const info = await invoke<RemoteOpenInfo>("remote_open", { connectionId, target });
            return createRemoteSession(connectionId, info, checkoutRoot);
          } catch (error) {
            throw new RemoteOpenError(normalizeRemoteOpenFailure(error));
          }
        }}
        workspace={createWorkspaceAdapter()}
        connections={createConnectionsAdapter()}
        updater={tauriUpdaterAdapter()}
        cliInstall={tauriCliInstallAdapter()}
        fsActions={tauriFsActionsAdapter()}
        loadAppInfo={loadAppInfo}
      />
    </StrictMode>,
  );
}
