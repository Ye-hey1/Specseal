// Pi 的 extension，做的事和 label-skill.mjs 相同：看送出的消息和跑的 specseal 指令，帮这个终端机贴标签。
// 规则在 model.js 的 hookLabels。设置方式见 integrations/herdr/README.md。不在 Herdr 里或贴不上时什么都不做。
import { execFileSync } from "node:child_process";
import { hookLabels } from "./model.js";

const terminal = process.env.HC_TERMINAL_ID;

function label(event: Parameters<typeof hookLabels>[0]) {
  try {
    const labels = hookLabels(event);
    if (labels) execFileSync("hc", ["label", terminal as string, ...labels], { stdio: "ignore", timeout: 3000 });
  } catch {
    // 贴不上标签不能挡住用户送出消息。
  }
}

export default function (pi: any) {
  if (!terminal) return;
  pi.on("input", (event: any) => {
    label({ hook_event_name: "UserPromptSubmit", prompt: event.text });
  });
  pi.on("tool_call", (event: any) => {
    if (event.toolName === "bash") label({ tool_name: "Bash", tool_input: { command: event.input.command } });
  });
  pi.on("session_start", (event: any) => {
    if (event.reason === "new" || event.reason === "resume") label({ hook_event_name: "SessionStart", source: "clear" });
  });
}
