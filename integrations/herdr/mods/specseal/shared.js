// 面板和技能跳窗共用的 Herdr 小工具。
import { exec, focused, hc, panes, run, spaces } from "herdr";
import { tr } from "./i18n.js";
import { hasSpecsealSkills, inside, parseStations, pluginFolders, skillEntries, skillFolders, stampedPaths } from "./model.js";

export const firstLine = (text) => text.trim().split("\n")[0];

// 目前 space 所在的文件夹：焦点所在的终端机，否则该 space 第一个终端机。spaces() 的 folder
// 只是开新终端机的起点，不一定是它现在的位置。
export function location() {
  const space = spaces().find((s) => s.active);
  const f = focused();
  const ps = panes();
  const pane = f?.pane ? ps.find((p) => p.pane === f.pane) : null;
  const tabs = new Set(space?.tabs.map((t) => t.id));
  const first = ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd;
  return {
    cwd: pane?.cwd || f?.cwd || first || space?.folder || null,
    on: space?.machine ?? null,
    branch: pane?.branch ?? space?.branch ?? null,
  };
}

// 主文件夹：在 worktree 里也要回到主 checkout，变更清单才完整。
export async function projectRoot(cwd, on) {
  const r = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on });
  return r.code === 0 ? r.stdout.trim().replace(/\/\.git\/?$/, "") : cwd;
}

// 新分页开在已经待在这个文件夹的 space，目前的 space 优先。
export function spaceFor(folder) {
  const all = spaces();
  const ps = panes();
  const holds = (s) => ps.some((p) => s.tabs.some((t) => t.id === p.tab) && inside(p.cwd, folder));
  return all.find((s) => s.active && holds(s)) ?? all.find(holds);
}

// 跑 specseal 动词并读它的 JSON。失败时丢出 CLI 的第一行消息。
export async function specsealJson(verb, cwd, on) {
  const r = await exec("specseal", [...verb, "--json"], { cwd, on });
  if (r.code !== 0) throw new Error(firstLine(r.stderr) || tr("specseal {0} 结束码 {1}", verb.join(" "), r.code));
  return JSON.parse(r.stdout);
}

// 进行中的变更还剩几个程序任务，手动任务（[M]）不算。list 和 plan 没有这个数字，要问 instructions。
// 有 worktree 的要到 worktree 里问，主文件夹的副本不会更新。查不到的不放进结果。
export async function codeRemaining(list, plan, root, on) {
  const folders = new Map(list.changes.map((c) => [c.name, c.worktree?.path ?? root]));
  const names = plan.changes.filter((c) => c.stage === "in-progress").map((c) => c.name);
  const answers = await Promise.all(
    names.map((name) =>
      specsealJson(["instructions", "apply", "--change", name], folders.get(name) ?? root, on).catch(() => null),
    ),
  );
  return Object.fromEntries(names.flatMap((name, i) => (answers[i]?.progress ? [[name, answers[i].progress.codeRemaining]] : [])));
}

// 这个变更的 .meta.yaml，加上开着的工单。
const READ_STATIONS = `for d in specseal openspec; do
  c="$d/changes/$1"
  [ -d "$c" ] || continue
  cat "$c/.meta.yaml" 2>/dev/null; echo
  for s in review verify; do [ -e "$c/$s.md" ] && echo "open_ticket: $s"; done
  exit 0
done`;

// 文件的指纹，规则和引擎的 content_fingerprint_bytes 相同：UTF-8 文本先把 CRLF 换成 LF，其他文件看原始字节。
// 不见的文件不输出。
const FINGERPRINT = String.raw`for my $f (@ARGV) { open(my $h, "<:raw", $f) or next; my $b = <$h> // ""; my $u = $b; $b =~ s/\r\n/\n/g if utf8::decode($u); print sha256_hex($b), "  $f\n" }`;

async function fingerprints(paths, cwd, on) {
  const r = await exec("perl", ["-MDigest::SHA=sha256_hex", "-0777", "-e", FINGERPRINT, "--", ...paths], { cwd, on }).catch(() => null);
  if (r?.code !== 0) return null;
  return Object.fromEntries(r.stdout.split("\n").filter(Boolean).map((line) => [line.slice(66), line.slice(0, 64)]));
}

// 品质关卡的章和工单。CLI 没有给，只好读档；有 worktree 的要到 worktree 里读，主文件夹的副本不会更新。
// 提案中的变更还没有章。读不到时没有章，封存时引擎还会再查一次。
export async function stationFacts(list, plan, root, on) {
  const folders = new Map(list.changes.map((c) => [c.name, c.worktree?.path ?? root]));
  const names = plan.changes.filter((c) => c.stage !== "proposed").map((c) => c.name);
  const facts = await Promise.all(
    names.map(async (name) => {
      const cwd = folders.get(name) ?? root;
      const r = await exec("sh", ["-c", READ_STATIONS, "sh", name], { cwd, on }).catch(() => null);
      const stations = parseStations(r?.stdout ?? "");
      const paths = stampedPaths(stations);
      return [name, { ...stations, hashes: paths.length > 0 ? await fingerprints(paths, cwd, on) : null }];
    }),
  );
  return Object.fromEntries(facts);
}

// hc run 回来时分页可能还没出现，等它出现才能改名。
const nameTabs = (waiting, cx, tries = 20) =>
  new Promise((done) => {
    const left = waiting.filter(({ address, name }) => {
      const pane = panes().find((p) => p.terminal === address);
      if (pane) run("tab.rename", { id: pane.tab, name });
      return !pane;
    });
    if (left.length === 0 || tries === 0) return done();
    cx.timer.after(150, (cx) => nameTabs(left, cx, tries - 1).then(done));
  });

// 依序开新分页并取名。中途失败就停下来，已经开好的分页留着，回传失败的结果；全部成功时回传 null。
export async function openTabs(plans, cx) {
  const opened = [];
  let failed = null;
  for (const plan of plans) {
    const r = await hc(plan.hc);
    if (r.code !== 0) {
      failed = r;
      break;
    }
    opened.push({ address: JSON.parse(r.stdout).address, name: plan.tabName });
  }
  await nameTabs(opened, cx);
  return failed;
}

// Herdr 没有「只粘贴不按 Enter」的指令，所以暂时当一个看不见的查看者：hc attach 要真的终端机才肯跑，
// script 给它一个。送出括号粘贴（程序会当成粘贴，不是打字），再按 ctrl+\ 离开。
// 大小用终端机现在的大小，它才不会跳动。ctrl+\ 要和粘贴分开送，同一次读到时 hc 不会当成离开；
// alarm 确保失败时不会一直挂着。script 的用法是 macOS 的，其他系统会失败并回报。
const PASTE = `{ sleep 0.2; printf '\\033[200~%s\\033[201~' "$4"; sleep 0.15; printf '\\034'; } | perl -e 'alarm 3; exec @ARGV' script -q /dev/null sh -c 'stty rows "$2" cols "$3"; exec hc attach "$1"' sh "$1" "$2" "$3" >/dev/null 2>&1`;

// 照 placePlan 或 attachPlan 的结果贴进输入框，再把焦点切过去。失败时回传结果，sendError 读得懂。
export async function placeInInput(plan) {
  const { address } = plan.agent;
  const got = await hc(["get", address, "--json"]);
  if (got.code !== 0) return got;
  const { rows, cols } = JSON.parse(got.stdout);
  const r = await exec("sh", ["-c", PASTE, "sh", address, String(rows), String(cols), plan.text]);
  if (r.code !== 0) return { ...r, stderr: tr("贴不进 {0}（结束码 {1}）", address, r.code) };
  // 附加名称不算开始做，所以只有技能指令带标签。
  if (plan.labels) await hc(["label", address, ...plan.labels]);
  run("pane.focus", { terminal: address });
  return null;
}

export function sendError(result) {
  try {
    return JSON.parse(result.stderr).error.message;
  } catch {
    return firstLine(result.stderr) || tr("hc 结束码 {0}", result.code);
  }
}

// 读文件夹里每个技能 SKILL.md 开头的字段。多行的值接在同一栏后面。字节原样输出，JSON 还是 UTF-8。
// 参数一个文件夹一个：来源、名称前缀、文件夹，用 tab 隔开。
const READ_SKILLS = String.raw`
my @out;
for my $spec (@ARGV) {
  my ($source, $prefix, $dir) = split /\t/, $spec, 3;
  (my $abs = $dir) =~ s{^~(?=/)}{$ENV{HOME}};
  for my $file (sort glob(qq{"$abs"/*/SKILL.md})) {
    open(my $fh, "<", $file) or next;
    my $first = <$fh>;
    next unless defined $first && $first =~ /^---\s*$/;
    my (%f, $key);
    while (my $line = <$fh>) {
      last if $line =~ /^---\s*$/;
      if ($line =~ /^([A-Za-z-]+):\s*(.*?)\s*$/) { $key = $1; $f{$key} = $2; }
      elsif (defined $key && $line =~ /^\s+(\S.*?)\s*$/) { $f{$key} .= " $1"; }
    }
    my ($base) = $file =~ m{([^/]+)/SKILL\.md$};
    push @out, { source => $source, name => $prefix . ($f{name} // $base), description => $f{description} // "", invocable => $f{"user-invocable"} // "", path => "$dir/$base" };
  }
}
print JSON::PP->new->encode(\@out);
`;

async function readJson(path, options) {
  const r = await exec("sh", ["-c", `cat "${path}"`], options).catch(() => null);
  try {
    return JSON.parse(r?.stdout ?? "");
  } catch {
    return null;
  }
}

// 这个 agent 的技能：我的技能页的清单，和这个项目有没有它用的 Specseal 技能。
export async function readSkills(key, root, on) {
  const options = { cwd: root, on };
  const folders = skillFolders(key);
  if (key === "claude") {
    const paths = ["$HOME/.claude/settings.json", ".claude/settings.json", ".claude/settings.local.json"];
    const [installed, ...settings] = await Promise.all(["$HOME/.claude/plugins/installed_plugins.json", ...paths].map((path) => readJson(path, options)));
    folders.push(...pluginFolders(installed, settings, root));
  }
  const specs = folders.map(({ source, prefix, dir }) => `${source}\t${prefix}\t${dir}`);
  const r = await exec("perl", ["-MJSON::PP", "-e", READ_SKILLS, "--", ...specs], options);
  if (r.code !== 0) throw new Error(firstLine(r.stderr) || tr("perl 结束码 {0}", r.code));
  const found = JSON.parse(r.stdout);
  return { skills: skillEntries(found), hasSpecseal: hasSpecsealSkills(found) };
}
