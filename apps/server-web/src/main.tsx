import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// Noto Sans TC 随资产打包（脱机可用、不从 Google Fonts 加载——D5/D6）。
import "@fontsource-variable/noto-sans-tc";
import "./index.css";
import { App } from "./App";
import { createHttpClient } from "./api/client";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App client={createHttpClient()} />
    </StrictMode>,
  );
}
