import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Specseal Server Web Console 的 production build（D5）：单一 index.html 入口，
// base "/"（由 specseal-server 从 root origin 服务），Vite 缺省输出内容哈希资产，
// 供编译期内嵌 binary。不做独立部署、CDN 或第二 origin。
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
