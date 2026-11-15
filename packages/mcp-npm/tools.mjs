// Specseal MCP 工具定义：纯逻辑（工具表 + CLI 参数构造），不碰 MCP SDK，可直接单测。
import { z } from "zod";

//
// 原则：
// - 只暴露白名单动词；每个工具的 argv 由 buildArgs 从已校验的参数拼出，
//   runSpeclink 用 spawn(不走 shell)，命令注入没有入口。
// - --json 只标在实测支持结构化输出的动词上（validate/plan/list/show/verify scope/
//   verify show）；status/trace/drift 的输出保持引擎原文。

export const BIN = "speclink";

/** 变更名合法性：kebab-case/字母数字 + 点、下划线；拒绝路径段、空白、引号 */
export function isValidChangeName(name) {
  return typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && name.length <= 128;
}

export const WORKFLOW_GUIDE = `Specseal 规格驱动开发（SDD）工作流指南

目录：speclink/ 下 specs/<capability>/spec.md 是现行规格，changes/<name>/ 是每个变更的
proposal、规格 delta 与 tasks.md（复选框任务），changes/archive/ 是封存历史。

环路：propose → apply ⇄ ingest → review? ∥ verify? → archive
（带 ? 的站点可选，按风险裁剪；低风险变更可两站都跳过）

你（agent）在各阶段的职责：
1. propose：先写 changes/<name>/ 下的 proposal.md（为什么/问题/摘要）、规格 delta
   （## ADDED/MODIFIED/REMOVED Requirements + WHEN/THEN 场景）和 tasks.md
   （- [ ] 1.1 短标题），然后用 specseal_register_change 登记，再跑 specseal_validate，
   把错误修完再交给人审。
2. apply：逐个实现任务，完成即勾选复选框；需求中途变化用 ingest 记录，不悄悄扩范围。
3. verify（建议做）：specseal_verify_scope 冻结范围 → 按范围核对并写验证轮次
   （specseal_verify_add_round，内容里记录 Scope/Phase 与发现）→
   specseal_verify_show 确认最后一轮 must-fix 为空 → specseal_verify_stamp 盖章。
   引擎强制：任务没全勾、must-fix 没清空，stamp 会被拒绝（--accept 只在用户明确同意时用）。
4. archive：盖章后由人触发封存；未暴露给工具，需要时请用户在 CLI/面板操作。

纪律：
- 写码前先读相关 specs/<capability>/spec.md；没有规格且用户没说免规格修复，先提案。
- 需求有歧义就停下来问，不替用户做决定。
- 不编辑 changes/archive/（历史）；proposal/delta/tasks 随手保持真实，它们是记录。
`;

/**
 * 工具定义表。inputSchema 用 zod raw shape（SDK 要求）；buildArgs 返回 argv 数组。
 */
export const TOOL_DEFS = [
  {
    name: "specseal_workflow_guide",
    description:
      "Read the Specseal SDD workflow guide (loop, stage duties, discipline). Call this first if you are unsure how to proceed with Specseal.",
    inputSchema: {},
    noCli: true,
    buildArgs: () => [],
    text: () => WORKFLOW_GUIDE,
  },
  {
    name: "specseal_status",
    description: "Show the Specseal workspace status (current changes, stations). Plain text.",
    inputSchema: {},
    json: false,
    buildArgs: () => ["status"],
  },
  {
    name: "specseal_list_changes",
    description: "List all Specseal changes with stage, tasks progress and station stamps (JSON).",
    inputSchema: {},
    json: true,
    buildArgs: () => ["list", "--json"],
  },
  {
    name: "specseal_show_change",
    description: "Show one change's artifacts (proposal, spec delta, tasks) or a spec, by name (JSON).",
    inputSchema: { name: z.string().describe("Change or spec name, e.g. mcp-server") },
    json: true,
    buildArgs: (a) => ["show", a.name, "--json"],
    nameArg: "name",
  },
  {
    name: "specseal_plan",
    description:
      "Order ready changes into dependency waves and show the next change to start (JSON: waves/changes/next/skipped).",
    inputSchema: {},
    json: true,
    buildArgs: () => ["plan", "--json"],
  },
  {
    name: "specseal_validate",
    description:
      "Validate the whole Specseal workspace structure (proposals, tasks checkboxes, spec deltas). Returns [] when valid.",
    inputSchema: {},
    json: true,
    buildArgs: () => ["validate", "--json"],
  },
  {
    name: "specseal_register_change",
    description:
      "Register a new change AFTER you wrote its folder (proposal.md, spec delta, tasks.md with checkboxes) under speclink/changes/<name>/. Then run specseal_validate.",
    inputSchema: {
      name: z.string().describe("Change name (kebab-case), e.g. mcp-server"),
      description: z.string().optional().describe("One-line description of the change"),
    },
    json: false,
    buildArgs: (a) => {
      const args = ["new", "change", a.name];
      if (a.description) args.push("--description", a.description);
      return args;
    },
    nameArg: "name",
  },
  {
    name: "specseal_trace",
    description: "Trace a capability's provenance chain: archived changes, discussions and evidence behind a spec.",
    inputSchema: { capability: z.string().describe("Canonical spec directory name") },
    json: false,
    buildArgs: (a) => ["trace", a.capability],
    nameArg: "capability",
  },
  {
    name: "specseal_drift",
    description: "Detect drift between a change and the current codebase state (run when resuming a paused change).",
    inputSchema: { change: z.string().optional().describe("Change name; auto-detects if only one exists") },
    json: false,
    buildArgs: (a) => (a.change ? ["drift", a.change] : ["drift"]),
    nameArg: "change",
  },
  {
    name: "specseal_verify_scope",
    description: "Resolve and freeze the verify scope for a change (structured JSON payload).",
    inputSchema: { change: z.string().describe("Change name") },
    json: true,
    buildArgs: (a) => ["verify", "scope", a.change, "--json"],
    nameArg: "change",
  },
  {
    name: "specseal_verify_add_round",
    description:
      "Append a verification round to the change's verify ticket. Content is read from stdin. Engine requires every task checked first.",
    inputSchema: {
      change: z.string().describe("Change name"),
      content: z.string().describe("Round content: a **Scope**: line, **Phase** line, findings and Rules"),
    },
    json: false,
    buildArgs: (a) => ["verify", "add-round", a.change, "--stdin"],
    nameArg: "change",
    stdinArg: "content",
  },
  {
    name: "specseal_verify_show",
    description: "Print the change's verify ticket: scope, rounds, findings and stamp state (JSON).",
    inputSchema: { change: z.string().describe("Change name") },
    json: true,
    buildArgs: (a) => ["verify", "show", a.change, "--json"],
    nameArg: "change",
  },
  {
    name: "specseal_verify_stamp",
    description:
      "Stamp the verification (the change is then considered verified). Engine refuses while tasks are unchecked or must-fix findings are open; do not pass accept unless the user explicitly agreed.",
    inputSchema: {
      change: z.string().describe("Change name"),
      agent: z.string().optional().describe("Tool identity recorded as verified_with, e.g. claude, codex"),
      accept: z.boolean().optional().describe("Stamp despite outstanding must-fix findings — only with explicit user consent"),
    },
    json: false,
    buildArgs: (a) => {
      const args = ["verify", "stamp", a.change];
      if (a.agent) args.push("--agent", a.agent);
      if (a.accept) args.push("--accept");
      return args;
    },
    nameArg: "change",
  },
];

/** 供测试与装配共用的参数安全检查 */
export function guardArgs(def, args) {
  const nameField = def.nameArg;
  if (nameField && args[nameField] !== undefined && !isValidChangeName(args[nameField])) {
    throw new Error(`invalid ${nameField}: ${String(args[nameField]).slice(0, 64)}`);
  }
  return def.buildArgs(args);
}
