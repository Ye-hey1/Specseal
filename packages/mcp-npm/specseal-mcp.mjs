#!/usr/bin/env node
// Specseal MCP server：把 Specseal 引擎的白名单动词暴露给任意支持 MCP 的编码 agent。
//
// 架构：MCP 工具调用 → 本进程 spawn `speclink <verb> [--json]` → 把 stdout 透传回 agent。
// 引擎不改动；工具表与参数构造在 tools.mjs（可单测），子进程封装在 exec.mjs。
//
// 启动：node specseal-mcp.mjs（stdio 传输；工作目录即 Specseal 项目，通常由 agent 在项目目录拉起）。
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pathToFileURL } from "node:url";
import { resolve as pathResolve } from "node:path";
import { TOOL_DEFS, guardArgs } from "./tools.mjs";
import { runSpeclink } from "./exec.mjs";

const VERSION = "0.1.0";

function textResult(text, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

async function runTool(def, args) {
  if (def.noCli) {
    return textResult(def.text(args));
  }
  let argv;
  try {
    argv = guardArgs(def, args ?? {});
  } catch (err) {
    return textResult(`invalid arguments: ${err.message}`, true);
  }
  let result;
  try {
    result = await runSpeclink(argv, { cwd: process.cwd(), stdin: def.stdinArg ? args?.[def.stdinArg] : undefined });
  } catch (err) {
    return textResult(`speclink failed: ${err.message}`, true);
  }
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    return textResult(`speclink ${argv.join(" ")} exited ${codeStr(result.code)}\n${detail}`.trim(), true);
  }
  const out = def.text ? def.text(args) : result.stdout.trim();
  return textResult(out.length > 0 ? out : "(empty output)");
}

function codeStr(code) {
  return code < 0 ? "with a signal" : `with code ${code}`;
}

export function buildServer() {
  const server = new McpServer({ name: "specseal-mcp", version: VERSION });
  for (const def of TOOL_DEFS) {
    server.tool(def.name, def.description, def.inputSchema, (args) => runTool(def, args));
  }
  return server;
}

// 直接被 node 执行时才连接 stdio；被测试 import 时不启动。
const isMain = process.argv[1] && import.meta.url === pathToFileURL(pathResolve(process.argv[1])).href;
if (process.env.SPECSEAL_MCP_SELFTEST === "1") {
  // 冒烟：工具数量打印，立即退出（供部署检查用）。
  console.log(`specseal-mcp ${VERSION}: ${TOOL_DEFS.length} tools registered`);
} else if (isMain) {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
  // stdio 传输靠 stdin 存活；client 断开（stdin EOF）即干净退出。
}
