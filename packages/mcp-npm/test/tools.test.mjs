// 工具表与参数构造的单测（纯逻辑，不启动 MCP、不 spawn CLI）。
import test from "node:test";
import assert from "node:assert/strict";
import { TOOL_DEFS, guardArgs, isValidChangeName, WORKFLOW_GUIDE } from "../tools.mjs";

test("工具表：名字唯一、全部以 specseal_ 开头、都有描述与 buildArgs", () => {
  const names = TOOL_DEFS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, "工具名不得重复");
  for (const def of TOOL_DEFS) {
    assert.match(def.name, /^specseal_/);
    assert.ok(def.description.length > 10, `${def.name} 缺描述`);
    assert.equal(typeof def.buildArgs, "function");
  }
});

test("workflow_guide 覆盖环路四个阶段与 verify 纪律", () => {
  for (const word of ["propose", "apply", "verify", "archive", "must-fix"]) {
    assert.ok(WORKFLOW_GUIDE.includes(word), `指南缺 ${word}`);
  }
});

test("isValidChangeName 拒绝路径穿越、空白与特殊字符", () => {
  for (const bad of ["../etc", "a b", "a;b", "a|b", "", "-lead", "a\nb", "x".repeat(129)]) {
    assert.equal(isValidChangeName(bad), false, `应拒绝 ${JSON.stringify(bad.slice(0, 12))}`);
  }
  for (const good of ["mcp-server", "import_export.on-port", "fix1.2"]) {
    assert.equal(isValidChangeName(good), true, `应接受 ${good}`);
  }
});

test("guardArgs：非法名直接抛错", () => {
  const def = TOOL_DEFS.find((t) => t.name === "specseal_show_change");
  assert.throws(() => guardArgs(def, { name: "../escape" }), /invalid name/);
});

test("buildArgs：各工具拼出预期的 argv", () => {
  const build = (name, args) => guardArgs(TOOL_DEFS.find((t) => t.name === name), args);
  assert.deepEqual(build("specseal_list_changes", {}), ["list", "--json"]);
  assert.deepEqual(build("specseal_plan", {}), ["plan", "--json"]);
  assert.deepEqual(build("specseal_validate", {}), ["validate", "--json"]);
  assert.deepEqual(build("specseal_status", {}), ["status"]);
  assert.deepEqual(build("specseal_show_change", { name: "demo" }), ["show", "demo", "--json"]);
  assert.deepEqual(build("specseal_register_change", { name: "mcp-server" }), ["new", "change", "mcp-server"]);
  assert.deepEqual(build("specseal_register_change", { name: "mcp-server", description: "x" }), [
    "new",
    "change",
    "mcp-server",
    "--description",
    "x",
  ]);
  assert.deepEqual(build("specseal_trace", { capability: "client-protocol" }), ["trace", "client-protocol"]);
  assert.deepEqual(build("specseal_drift", {}), ["drift"]);
  assert.deepEqual(build("specseal_drift", { change: "demo" }), ["drift", "demo"]);
  assert.deepEqual(build("specseal_verify_scope", { change: "demo" }), ["verify", "scope", "demo", "--json"]);
  assert.deepEqual(build("specseal_verify_add_round", { change: "demo", content: "x" }), [
    "verify",
    "add-round",
    "demo",
    "--stdin",
  ]);
  assert.deepEqual(build("specseal_verify_show", { change: "demo" }), ["verify", "show", "demo", "--json"]);
  assert.deepEqual(build("specseal_verify_stamp", { change: "demo" }), ["verify", "stamp", "demo"]);
  assert.deepEqual(build("specseal_verify_stamp", { change: "demo", agent: "claude" }), [
    "verify",
    "stamp",
    "demo",
    "--agent",
    "claude",
  ]);
  assert.deepEqual(build("specseal_verify_stamp", { change: "demo", accept: true }), [
    "verify",
    "stamp",
    "demo",
    "--accept",
  ]);
});

test("verify add-round 声明了 stdin 通道", () => {
  const def = TOOL_DEFS.find((t) => t.name === "specseal_verify_add_round");
  assert.equal(def.stdinArg, "content");
});
