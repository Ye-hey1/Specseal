// e2e：真 MCP Client 经 stdio 连上 server，验握手、工具清单与真实工具调用。
// 前置：specseal CLI 在 PATH（e2e 在临时目录跑 init 建工作区）。
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "specseal-mcp.mjs");

async function withClient(cwd, fn) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], cwd });
  const client = new Client({ name: "specseal-e2e", version: "0.0.0" });
  try {
    await client.connect(transport);
    return await fn(client);
  } finally {
    await client.close();
  }
}

test("e2e：握手、工具清单、真实调用 guide/validate/list", async () => {
  const dir = mkdtempSync(join(tmpdir(), "specseal-mcp-e2e-"));
  try {
    execFileSync("specseal", ["init", "--tools", "claude"], { cwd: dir, stdio: "pipe" });

    await withClient(dir, async (client) => {
      const { tools } = await client.listTools();
      assert.ok(tools.length >= 13, `工具数应 ≥13，实得 ${tools.length}`);
      assert.ok(tools.some((t) => t.name === "specseal_verify_stamp"), "缺 verify_stamp");

      const guide = await client.callTool({ name: "specseal_workflow_guide", arguments: {} });
      assert.match(guide.content[0].text, /propose/, "指南应含 propose");

      const validate = await client.callTool({ name: "specseal_validate", arguments: {} });
      assert.equal(validate.content[0].text, "[]", "空工作区校验应为 []");

      const list = await client.callTool({ name: "specseal_list_changes", arguments: {} });
      assert.match(list.content[0].text, /"changes"/, "list 应返回 JSON");

      const bad = await client.callTool({ name: "specseal_show_change", arguments: { name: "../escape" } });
      assert.equal(bad.isError, true, "路径穿越参数应返回 isError");
      assert.match(bad.content[0].text, /invalid name/, "应报 invalid name");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
