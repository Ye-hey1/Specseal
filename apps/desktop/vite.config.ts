import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Tauri 读取 build.outDir（tauri.conf.json 的 frontendDist=../dist）作为 release 前端资产；
// dev 模式改由下方 server 供应（tauri.conf.json 的 devUrl 指向同一个端口）。
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "./",
  // devUrl 是写死的字符串，端口一旦浮动就对不上——strictPort 让端口被占用时直接报错，
  // 而不是自动换端口后开出一个没有错误消息的空白窗口。
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      // 多页入口：main（主窗口）＋ panel（系统匣面板样式，design D5）。
      input: {
        main: fileURLToPath(new URL("index.html", import.meta.url)),
        panel: fileURLToPath(new URL("panel.html", import.meta.url)),
      },
    },
  },
});
