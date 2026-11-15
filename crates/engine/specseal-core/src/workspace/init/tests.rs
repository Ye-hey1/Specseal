use super::*;

/// Throwaway project root, removed on drop.
struct TempRoot {
    dir: PathBuf,
}

impl TempRoot {
    fn new(tag: &str) -> TempRoot {
        let dir = std::env::temp_dir().join(format!(
            "specseal-init-test-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        TempRoot { dir }
    }

    fn read(&self, rel: &str) -> String {
        std::fs::read_to_string(self.dir.join(rel.split('/').collect::<PathBuf>())).unwrap()
    }

    fn at(&self, rel: &str) -> PathBuf {
        self.dir.join(rel.split('/').collect::<PathBuf>())
    }

    fn write(&self, rel: &str, content: &str) {
        let path = self.at(rel);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, content).unwrap();
    }

    fn exists(&self, rel: &str) -> bool {
        self.at(rel).exists()
    }
}

impl Drop for TempRoot {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

// Spec requirement: init 范本的政策写入位置 — policy examples live in the
// openspec/config.yaml template; the .specseal.yaml template carries none.

#[test]
fn init_workflow_config_template_has_commented_policy_examples() {
    let root = TempRoot::new("wf-template");
    init(&root.dir, &[], false, "openspec").unwrap();
    let wf = root.read("openspec/config.yaml");
    for example in ["# locale:", "# spec_locale:", "# tdd:", "# audit:"] {
        assert!(
            wf.contains(example),
            "config.yaml template must show a commented {example} example:\n{wf}"
        );
    }
}

#[test]
fn init_app_config_template_has_no_policy_keys() {
    let root = TempRoot::new("app-template");
    init(&root.dir, &[], false, "openspec").unwrap();
    let app = root.read(".specseal.yaml");
    // Not even commented examples: the workspace file must not teach policy keys.
    // ("locale" also catches "spec_locale".)
    for word in ["locale", "tdd", "audit"] {
        assert!(
            !app.contains(word),
            ".specseal.yaml template must not mention policy key {word}:\n{app}"
        );
    }
    // Its actual concerns stay: workspace binding (tools) and spec_dir.
    assert!(app.contains("tools"));
    assert!(app.contains("spec_dir"));
}

#[test]
fn init_app_config_template_links_the_real_repository() {
    let root = TempRoot::new("app-template-url");
    init(&root.dir, &[], false, "openspec").unwrap();
    let app = root.read(".specseal.yaml");
    assert!(
        app.contains("https://github.com/MomoChenisMe/speclink"),
        ".specseal.yaml template must link the project repository:\n{app}"
    );
    assert!(
        !app.contains("specseal-app"),
        ".specseal.yaml template must not link the wrong organization:\n{app}"
    );
}

#[test]
fn init_over_a_specseal_entry_that_is_no_spec_folder_names_it() {
    // 同名的 specseal 不是规格文件夹（例如同名的 repo clone）：说清楚原因、零写入，
    // 不回误导的「Already initialized」。
    let root = TempRoot::new("init-specseal-taken");
    root.write("specseal/src/main.rs", "fn main() {}\n");
    let before = snapshot(&root);
    let Err(err) = init(&root.dir, &[Tool::Claude], false, DEFAULT_SPEC_DIR) else {
        panic!("init must refuse");
    };
    let err = err.to_string();
    assert!(err.contains("specseal") && err.contains("not a spec folder"), "{err}");
    assert_eq!(snapshot(&root), before, "零写入");
}

#[test]
fn init_with_tools_records_selection_without_policy_keys() {
    let root = TempRoot::new("app-tools");
    init(&root.dir, &[Tool::Claude, Tool::Codex], false, "openspec").unwrap();
    let app = root.read(".specseal.yaml");
    assert!(app.contains("tools: [claude, codex]"));
    for word in ["locale", "tdd", "audit"] {
        assert!(!app.contains(word), "no policy key {word} expected:\n{app}");
    }
}

// --- 共用 built-in tools reconciliation ---
// Spec requirement: 「built-in tools 权威收敛」＋ design「Core 单一 Workspace 工具同步入口」
// ／「Built-in 选择收敛且保留自订描述子」与 Implementation Contract 的
// 「Core and configuration contract」。

const CUSTOM_DESCRIPTOR: &str = "  - name: wad-harness\n    skills_dir: .wad/skills\n    instructions_file: WAD.md\n";
/// 第二份描述子夹具：规格「技能档过期探测」Example 的字面值（name my-harness、
/// skills_dir .my-harness/skills），且不带已弃用的 instructions_file——探测测试要的是
/// 干净的描述子，不是剥除路径。
const MY_HARNESS_DESCRIPTOR: &str = "  - name: my-harness\n    skills_dir: .my-harness/skills\n";
const REMOTE_URL: &str = "https://team.example.test/api/specseal/v1/projects/acme";
const CLAUDE_USER_TEXT: &str = "用户写在 CLAUDE.md 的段落";
const CODEX_USER_TEXT: &str = "用户写在 AGENTS.md 的段落";

fn instructions_file(tool: Tool) -> &'static str {
    instructions_path(tool).expect("只有 claude 与 codex 有指令档")
}

fn user_text(tool: Tool) -> &'static str {
    match tool {
        Tool::Claude => CLAUDE_USER_TEXT,
        Tool::Codex => CODEX_USER_TEXT,
        Tool::Copilot | Tool::Pi | Tool::Cursor => unreachable!("{} 没有指令档", tool.name()),
    }
}

fn propose_skill(tool: Tool) -> String {
    format!("{}/specseal-propose/SKILL.md", tool.skills_dir())
}

/// Remote 模式 workspace，其 `.specseal.yaml` 除 built-in 选集外还带 custom
/// descriptor、remote section 与未知顶层键；两份指令档先有用户自有文本。
fn seed_remote_workspace(root: &TempRoot, builtins: &[Tool]) {
    root.write("CLAUDE.md", &format!("{CLAUDE_USER_TEXT}\n"));
    root.write("AGENTS.md", &format!("{CODEX_USER_TEXT}\n"));
    let listed: String = builtins.iter().map(|t| format!("  - {}\n", t.name())).collect();
    root.write(
        ".specseal.yaml",
        &format!(
            "tools:\n{listed}{CUSTOM_DESCRIPTOR}remote:\n  url: {REMOTE_URL}\n  repo: desktop\nfuture_top_level: keep me\n"
        ),
    );
    update(&root.dir, false).expect("seed update");
}

fn builtin_names(root: &TempRoot) -> Vec<String> {
    let app = crate::config::AppConfig::load(&root.at(".specseal.yaml")).expect("config parses");
    let mut names: Vec<String> = app
        .tools
        .iter()
        .filter_map(|e| match e {
            ToolEntry::Builtin(n) => Some(n.clone()),
            ToolEntry::Descriptor(_) => None,
        })
        .collect();
    names.sort();
    names
}

fn marker_count(text: &str) -> usize {
    text.matches("<!-- SPECSEAL:START").count()
}

/// 目录快照（文件内容与目录项目），供「零写入」断言逐字节比对。
fn snapshot(root: &TempRoot) -> Vec<(String, Vec<u8>)> {
    walk_snapshot(root, false)
}

fn walk_snapshot(root: &TempRoot, skip_git: bool) -> Vec<(String, Vec<u8>)> {
    fn walk(dir: &Path, prefix: &str, skip_git: bool, out: &mut Vec<(String, Vec<u8>)>) {
        let mut entries: Vec<_> = std::fs::read_dir(dir).unwrap().flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let name = entry.file_name().to_string_lossy().to_string();
            if skip_git && prefix.is_empty() && name == ".git" {
                continue;
            }
            let rel = if prefix.is_empty() { name } else { format!("{prefix}/{name}") };
            // symlink 记录它指向哪里、不跟进去：悬空链接读不到内容，指向目录的链接也不该
            // 把同一批文件记两次。
            if let Ok(target) = std::fs::read_link(entry.path()) {
                out.push((format!("{rel}@"), target.to_string_lossy().as_bytes().to_vec()));
            } else if entry.path().is_dir() {
                out.push((format!("{rel}/"), Vec::new()));
                walk(&entry.path(), &rel, skip_git, out);
            } else {
                out.push((rel, std::fs::read(entry.path()).unwrap()));
            }
        }
    }
    let mut out = Vec::new();
    walk(&root.dir, "", skip_git, &mut out);
    out
}

/// Spec example「built-in 选集转换」逐列：转换后 built-in 集合等于请求，
/// custom descriptor／未知顶层键／remote 原值保留，marker 不重复，用户文本不动。
#[test]
fn reconcile_converts_builtin_selection_row_by_row() {
    let rows: [(&[Tool], &[Tool]); 10] = [
        (&[Tool::Claude], &[Tool::Codex]),
        (&[Tool::Claude, Tool::Codex], &[Tool::Claude]),
        (&[Tool::Codex], &[Tool::Claude, Tool::Codex]),
        (&[Tool::Claude], &[Tool::Claude, Tool::Copilot]),
        (&[Tool::Claude, Tool::Copilot], &[Tool::Claude]),
        (&[Tool::Codex], &[Tool::Copilot]),
        (&[Tool::Codex], &[Tool::Codex, Tool::Pi]),
        (&[Tool::Codex, Tool::Pi], &[Tool::Codex]),
        (&[Tool::Claude], &[Tool::Claude, Tool::Cursor]),
        (&[Tool::Claude, Tool::Cursor], &[Tool::Claude]),
    ];
    for (i, (from, to)) in rows.iter().enumerate() {
        let root = TempRoot::new(&format!("reconcile-row-{i}"));
        seed_remote_workspace(&root, from);
        // Spec Scenario 的 GIVEN：指令档「同时含遗留 Specseal 区块和用户文本」
        // ——seed 的 update 已把区块剥掉，reconcile 前重新注入，让收敛路径自己剥。
        for tool in [Tool::Claude, Tool::Codex] {
            root.write(
                instructions_file(tool),
                &format!(
                    "<!-- SPECSEAL:START v1.0.0 -->\n旧路由表\n<!-- SPECSEAL:END -->\n{}\n",
                    user_text(tool)
                ),
            );
        }

        reconcile_builtin_tools(&root.dir, to).expect("reconcile succeeds");

        let want: Vec<String> = {
            let mut v: Vec<String> = to.iter().map(|t| t.name().to_string()).collect();
            v.sort();
            v
        };
        assert_eq!(builtin_names(&root), want, "row {i}: built-in 集合须等于请求");

        let app_text = root.read(".specseal.yaml");
        assert!(app_text.contains("wad-harness"), "row {i}: custom descriptor 须保留:\n{app_text}");
        assert!(app_text.contains("keep me"), "row {i}: 未知顶层键须保留:\n{app_text}");
        let app = crate::config::AppConfig::load(&root.at(".specseal.yaml")).expect("config parses");
        let remote = app.remote.as_ref().expect("remote section 须保留");
        assert_eq!(remote.url.as_deref(), Some(REMOTE_URL), "row {i}");
        assert_eq!(remote.repo.as_deref(), Some("desktop"), "row {i}");

        for tool in Tool::ALL {
            let skill = propose_skill(tool);
            if to.contains(&tool) {
                assert!(root.exists(&skill), "row {i}: {skill} 应被补齐");
            } else {
                assert!(!root.exists(&skill), "row {i}: {skill} 应被清理");
            }
            // 指令档已退出受管：不论选取与否都只剩用户自己的内容（copilot 没有指令档）。
            let Some(md) = instructions_path(tool) else {
                continue;
            };
            let text = root.read(md);
            assert_eq!(marker_count(&text), 0, "row {i}: {md} 不得带受管区块:\n{text}");
            assert_eq!(text, format!("{}\n", user_text(tool)), "row {i}: {md} 须比特级不变");
        }
        assert!(!root.exists("openspec"), "row {i}: remote 模式不得创建 openspec/");
    }
}

/// 既有选集缺少产物时自动补齐，其他用户文件不受影响。
#[test]
fn reconcile_backfills_missing_managed_artifacts() {
    let root = TempRoot::new("reconcile-backfill");
    seed_remote_workspace(&root, &[Tool::Codex]);
    root.write("AGENTS.md", &format!("{CODEX_USER_TEXT}\n"));
    std::fs::remove_dir_all(root.at(".agents/skills/specseal-propose")).unwrap();
    root.write("docs/notes.md", "用户文件\n");

    reconcile_builtin_tools(&root.dir, &[Tool::Codex]).expect("reconcile succeeds");

    let text = root.read("AGENTS.md");
    assert_eq!(text, format!("{CODEX_USER_TEXT}\n"), "指令档须比特级不变:\n{text}");
    assert!(root.exists(".agents/skills/specseal-propose/SKILL.md"), "缺席的 Skill 应补齐");
    assert_eq!(root.read("docs/notes.md"), "用户文件\n");
}

/// 空选集在任何写入之前被拒（build-in 选集是非空契约）。
#[test]
fn reconcile_rejects_an_empty_selection_without_writing() {
    let root = TempRoot::new("reconcile-empty");
    seed_remote_workspace(&root, &[Tool::Codex]);
    let before = snapshot(&root);

    let err = reconcile_builtin_tools(&root.dir, &[]).expect_err("空选集必须失败");

    let message = err.to_string();
    assert!(message.contains("claude") && message.contains("codex"), "{message}");
    assert_eq!(snapshot(&root), before, "失败不得留下任何写入");
}

/// 坏 YAML 以单行错误失败，设置与受管产物逐字节不变。
#[test]
fn reconcile_bad_config_fails_loud_with_zero_writes() {
    let root = TempRoot::new("reconcile-bad-yaml");
    seed_remote_workspace(&root, &[Tool::Codex]);
    root.write(".specseal.yaml", "tools: [unclosed\n");
    let before = snapshot(&root);

    let err = reconcile_builtin_tools(&root.dir, &[Tool::Claude]).expect_err("坏 YAML 必须失败");

    let message = err.to_string();
    assert!(message.contains(".specseal.yaml"), "错误须指名文件：{message}");
    assert_eq!(message.lines().count(), 1, "错误须为单行：{message}");
    assert_eq!(snapshot(&root), before, "失败不得留下任何写入");
}

/// Remote 模式不生成任何指令档内容，也不创建本机规格树。
#[test]
fn reconcile_in_remote_mode_writes_no_instruction_file_and_no_spec_tree() {
    let root = TempRoot::new("reconcile-remote-wording");
    seed_remote_workspace(&root, &[Tool::Claude]);

    reconcile_builtin_tools(&root.dir, &[Tool::Claude, Tool::Codex]).expect("reconcile succeeds");

    for tool in [Tool::Claude, Tool::Codex] {
        let md = instructions_file(tool);
        let text = root.read(md);
        assert_eq!(text, format!("{}\n", user_text(tool)), "{md} 须比特级不变:\n{text}");
    }
    assert!(!root.exists("openspec"), "remote 模式不得创建 openspec/");
}

// --- adopt：工作区补齐入口 ---
// Spec requirement:「工作区补齐入口」（desktop-enable-specseal-prompt；desktop-spec-dir-migration
// D3）——OpenSpec 项目先以 init 导入的同一套程序改名为 specseal/，再幂等补骨架缺件、写 tools、
// 生成受管档；既有规格文档内容不被改写。

const CUSTOM_WORKFLOW_CONFIG: &str =
    "schema: spec-driven\nlocale: tw\nrules:\n  proposal:\n    - 保持提案精简\n";

/// 未激活目录：openspec/ 内有规格文档、变更、讨论与自订 config.yaml，
/// 但项目根无 .specseal.yaml。
fn seed_unadopted(root: &TempRoot) {
    root.write("openspec/specs/auth/spec.md", "## Purpose\n既有规格文档。\n");
    root.write("openspec/changes/add-auth/proposal.md", "## Why\n既有变更。\n");
    root.write("openspec/changes/add-auth/.openspec.yaml", "schema: spec-driven\ncreated: 2026-10-01\n");
    root.write("openspec/discussions/auth-scope.md", "# Discussion\n既有讨论。\n");
    root.write("openspec/config.yaml", CUSTOM_WORKFLOW_CONFIG);
}

/// 目录快照去掉 `.git/`：git status 会刷新 index，零写入断言只看项目档。
/// 同 snapshot，但不走进 `.git/`：commit 后 git 可能在背景整理，`.git/` 里的文件
/// 会在读到一半时消失。
fn project_snapshot(root: &TempRoot) -> Vec<(String, Vec<u8>)> {
    walk_snapshot(root, true)
}

/// Spec Scenario「导入后既有内容比特级不变」：openspec/ 改名为 specseal/、数据档改名为
/// .meta.yaml，内容逐字节不变；.specseal.yaml 记录 tools、不写 spec_dir。
#[test]
fn adopt_imports_an_openspec_project_byte_for_byte() {
    let root = TempRoot::new("adopt-import");
    seed_unadopted(&root);
    commit_all(&root);
    let before = project_snapshot(&root);

    adopt(&root.dir, &[Tool::Claude]).expect("adopt succeeds");

    assert!(!root.exists("openspec"), "openspec/ 必须已改名");
    let after = project_snapshot(&root);
    for (rel, bytes) in before.iter().filter(|(rel, _)| rel.starts_with("openspec/") && !rel.ends_with('/')) {
        let moved = rel.replacen("openspec/", "specseal/", 1).replace(".openspec.yaml", ".meta.yaml");
        let found = after.iter().find(|(r, _)| *r == moved).map(|(_, b)| b);
        assert_eq!(found, Some(bytes), "{rel} 必须比特级搬到 {moved}");
    }
    assert!(!root.exists("specseal/changes/add-auth/.openspec.yaml"));
    let app = root.read(".specseal.yaml");
    assert!(app.contains("claude"), "tools 须记录 claude：{app}");
    assert!(!app.lines().any(|l| l.trim_start().starts_with("spec_dir")), "不得写入 spec_dir：{app}");
    assert!(!root.exists("CLAUDE.md"), "工作区补齐不得产生指令档");
    assert!(root.exists(".claude/skills/specseal-propose/SKILL.md"));
}

/// Spec Scenario「骨架缺件补齐」：缺 specs/ 与 config.yaml 时，导入后在 specseal/ 补齐目录与范本。
#[test]
fn adopt_backfills_missing_skeleton() {
    let root = TempRoot::new("adopt-skeleton");
    root.write("openspec/changes/add-auth/proposal.md", "## Why\n既有变更。\n");

    adopt(&root.dir, &[Tool::Claude]).expect("adopt succeeds");

    assert!(!root.exists("openspec"));
    assert!(root.at("specseal/specs").is_dir());
    assert!(root.at("specseal/changes/archive").is_dir());
    assert_eq!(root.read("specseal/config.yaml"), WORKFLOW_CONFIG_TEMPLATE);
}

/// Spec Scenario「有未提交修改时拒绝导入」：单行错误、零写入；另有 worktree 时同样拒绝。
#[test]
fn adopt_refuses_an_unsafe_import_with_zero_writes() {
    let root = TempRoot::new("adopt-dirty");
    seed_unadopted(&root);
    commit_all(&root);
    root.write("openspec/changes/add-auth/proposal.md", "## Why\n改到一半。\n");
    let before = project_snapshot(&root);

    let err = adopt(&root.dir, &[Tool::Claude]).expect_err("未提交修改必须拒绝").to_string();
    assert!(err.contains("openspec/ has uncommitted changes"), "{err}");
    assert_eq!(err.lines().count(), 1, "错误须为单行：{err}");
    assert_eq!(project_snapshot(&root), before, "拒绝不得留下任何写入");

    let clean = TempRoot::new("adopt-worktree");
    seed_unadopted(&clean);
    commit_all(&clean);
    git(&clean, &["worktree", "add", "-q", clean.at("wt").to_str().unwrap(), "-b", "side"]);
    let err = adopt(&clean.dir, &[Tool::Claude]).expect_err("另有 worktree 必须拒绝").to_string();
    assert!(err.contains("other worktrees"), "{err}");
    assert!(clean.exists("openspec") && !clean.exists("specseal") && !clean.exists(".specseal.yaml"));
}

/// adopt 依实际的规格文件夹补骨架：只有 `specseal/` 的项目不得另建 `openspec/`。
#[test]
fn adopt_fills_the_folder_the_project_actually_uses() {
    let root = TempRoot::new("adopt-specseal-only");
    root.write("specseal/changes/add-auth/proposal.md", "## Why\n既有变更。\n");

    adopt(&root.dir, &[Tool::Claude]).expect("adopt succeeds");

    assert!(root.at("specseal/specs").is_dir());
    assert!(root.at("specseal/config.yaml").is_file());
    assert!(!root.at("openspec").exists(), "no second spec folder");
}

/// Spec Scenario「工作文件夹纳入版控忽略」：.gitignore 缺席时创建并涵盖 `.specseal/`。
#[test]
fn adopt_creates_gitignore_covering_the_work_dir() {
    let root = TempRoot::new("adopt-gitignore-new");
    seed_unadopted(&root);

    adopt(&root.dir, &[Tool::Claude]).expect("adopt succeeds");

    assert!(root.read(".gitignore").contains(".specseal/"));
}

/// Spec Example「既有 .gitignore 追加而非覆写」逐值：原有两行保留，多出 `.specseal/`。
#[test]
fn adopt_appends_to_an_existing_gitignore_without_overwriting() {
    let root = TempRoot::new("adopt-gitignore-append");
    seed_unadopted(&root);
    root.write(".gitignore", "node_modules/\ndist/\n");

    adopt(&root.dir, &[Tool::Claude]).expect("adopt succeeds");

    let text = root.read(".gitignore");
    for line in ["node_modules/", "dist/", ".specseal/"] {
        assert!(text.contains(line), "{line} 须存在于 .gitignore：\n{text}");
    }
}

/// 已涵盖时重跑不重复追加（文件比特级不变）。
#[test]
fn adopt_does_not_duplicate_an_existing_work_dir_entry() {
    let root = TempRoot::new("adopt-gitignore-idem");
    seed_unadopted(&root);
    adopt(&root.dir, &[Tool::Claude]).expect("first adopt");
    let first = root.read(".gitignore");

    adopt(&root.dir, &[Tool::Claude]).expect("second adopt");

    assert_eq!(root.read(".gitignore"), first, "重跑不得重复追加");
    assert_eq!(first.matches(".specseal/").count(), 1, "条目须恰有一笔：\n{first}");
}

// --- 工具档生成不写入 AI 工具的用户设置档 ---
// Spec requirement:「工具档生成不写入 AI 工具的用户设置档」
// （remove-claude-settings-write）——settings.json 属用户数据，
// 任何生成路径不得创建或改写。

const USER_SETTINGS: &str =
    "{\"enabledPlugins\":{\"frontend-design\":true},\"includeGitInstructions\":false}";

/// Spec Scenario「init 不产生用户设置档」。
#[test]
fn init_does_not_create_the_user_settings_file() {
    let root = TempRoot::new("no-settings-init");
    init(&root.dir, &[Tool::Claude], false, "openspec").unwrap();
    assert!(root.exists(".claude/skills/specseal-propose/SKILL.md"), "技能档照常生成");
    assert!(!root.exists(".claude/settings.json"), "不得产生用户设置档");
}

/// Spec Scenario「既有用户设置档在工具同步后比特级不变」
/// ＋ Example「自订插件设置不被清空」逐值。
#[test]
fn update_leaves_an_existing_user_settings_file_untouched() {
    let root = TempRoot::new("no-settings-update");
    init(&root.dir, &[Tool::Claude], false, "openspec").unwrap();
    root.write(".claude/settings.json", USER_SETTINGS);
    std::fs::remove_dir_all(root.at(".claude/skills/specseal-propose")).unwrap();

    update(&root.dir, false).expect("update succeeds");

    assert_eq!(root.read(".claude/settings.json"), USER_SETTINGS, "用户设置档比特级不变");
    assert!(root.exists(".claude/skills/specseal-propose/SKILL.md"), "受管技能档照常再生");
}

/// Spec Scenario「工作区补齐不产生用户设置档」。
#[test]
fn adopt_does_not_create_the_user_settings_file() {
    let root = TempRoot::new("no-settings-adopt");
    seed_unadopted(&root);
    adopt(&root.dir, &[Tool::Claude]).expect("adopt succeeds");
    assert!(!root.exists(".claude/settings.json"), "不得产生用户设置档");
}

/// Spec Scenario「重复运行幂等」：相同 tools 连续运行两次，全树比特级相同。
#[test]
fn adopt_twice_with_same_tools_is_idempotent() {
    let root = TempRoot::new("adopt-idem");
    seed_unadopted(&root);
    adopt(&root.dir, &[Tool::Claude, Tool::Codex]).expect("first adopt");
    let first = snapshot(&root);

    adopt(&root.dir, &[Tool::Claude, Tool::Codex]).expect("second adopt");

    assert_eq!(snapshot(&root), first, "重复运行必须收敛于相同结果");
}

/// Spec Scenario「tools 空清单拒绝」：回单行错误且目录零写入。
#[test]
fn adopt_rejects_empty_tools_with_zero_writes() {
    let root = TempRoot::new("adopt-empty");
    seed_unadopted(&root);
    let before = snapshot(&root);

    let err = adopt(&root.dir, &[]).expect_err("空 tools 必须失败");

    let message = err.to_string();
    assert!(message.contains("claude") && message.contains("codex"), "{message}");
    assert_eq!(message.lines().count(), 1, "错误须为单行：{message}");
    assert_eq!(snapshot(&root), before, "失败不得留下任何写入");
}

/// 同一选集下，既有 Workspace 收敛的受管产物与 filesystem init 的产物相同。
#[test]
fn reconcile_matches_init_output_for_the_same_selection() {
    let both = [Tool::Claude, Tool::Codex];
    let fresh = TempRoot::new("reconcile-parity-init");
    init(&fresh.dir, &both, false, "openspec").unwrap();

    let converged = TempRoot::new("reconcile-parity-converged");
    init(&converged.dir, &[Tool::Claude], false, "openspec").unwrap();
    reconcile_builtin_tools(&converged.dir, &both).expect("reconcile succeeds");

    for tool in both {
        let skill = propose_skill(tool);
        assert_eq!(converged.read(&skill), fresh.read(&skill), "{skill} 须与 init 相同");
    }
    assert!(converged.exists("openspec/specs"), "既有 filesystem 规格树须保留");
}

// --- 遗留 marker 剥除（design D2；规格「built-in tools 权威收敛」
// 「描述子的同步与清理生命周期」） ---

/// 旧版引擎注入过的指令档：marker 区块在上，用户段落在下。
fn legacy_marker_file(user_text: &str) -> String {
    format!(
        "<!-- SPECSEAL:START v1.0.0 -->\n\n# Specseal Instructions\n\n旧版注入的路由表。\n\n<!-- SPECSEAL:END -->\n{user_text}"
    )
}

#[test]
fn update_strips_a_legacy_marker_and_keeps_user_content() {
    // Scenario「更新时剥除内置工具的遗留 marker」：区块消失、用户段落原样
    // 保留，摘要列出被剥除的文件，技能档照常再生。
    let root = TempRoot::new("strip-keeps-user");
    init(&root.dir, &[Tool::Claude], false, "openspec").unwrap();
    root.write("CLAUDE.md", &legacy_marker_file(CLAUDE_USER_TEXT));

    let out = update(&root.dir, false).expect("update succeeds");

    let text = root.read("CLAUDE.md");
    assert!(!text.contains("<!-- SPECSEAL:START"), "区块须被剥除:\n{text}");
    assert_eq!(text, CLAUDE_USER_TEXT, "用户段落须原样保留:\n{text}");
    assert_eq!(out.stripped, vec!["CLAUDE.md".to_string()], "摘要须列出剥除的文件");
    assert!(root.exists(&propose_skill(Tool::Claude)), "技能档照常再生");
}

#[test]
fn update_deletes_an_instruction_file_that_was_only_a_marker() {
    // 剥除后全空的文件整份删除——不留一个空壳在项目根。
    let root = TempRoot::new("strip-deletes-empty");
    init(&root.dir, &[Tool::Claude, Tool::Codex], false, "openspec").unwrap();
    root.write("CLAUDE.md", &legacy_marker_file(""));
    root.write("AGENTS.md", &legacy_marker_file(""));

    let out = update(&root.dir, false).expect("update succeeds");

    assert!(!root.exists("CLAUDE.md"), "纯 marker 档须删除");
    assert!(!root.exists("AGENTS.md"), "纯 marker 档须删除");
    assert_eq!(out.stripped, vec!["CLAUDE.md".to_string(), "AGENTS.md".to_string()]);
}

#[test]
fn update_leaves_an_instruction_file_without_a_marker_byte_identical() {
    // 无区块＝零触碰：用户自己写的 CLAUDE.md 不得被 update 改动一个字节。
    let root = TempRoot::new("strip-untouched");
    init(&root.dir, &[Tool::Claude], false, "openspec").unwrap();
    let user_only = "# 我自己的 CLAUDE.md\n\n没有任何受管区块。\n";
    root.write("CLAUDE.md", user_only);

    let out = update(&root.dir, false).expect("update succeeds");

    assert_eq!(root.read("CLAUDE.md"), user_only, "无区块的文件须比特级不变");
    assert!(out.stripped.is_empty(), "没剥除任何东西时摘要须为空：{:?}", out.stripped);
}

#[test]
fn update_strips_a_descriptors_legacy_marker() {
    // Scenario「更新时剥除描述子的遗留 marker」：仍带 instructions_file 字段的
    // 描述子，其指令档同受剥除语意。
    let root = TempRoot::new("strip-descriptor");
    init(&root.dir, &[Tool::Claude], false, "openspec").unwrap();
    root.write(".specseal.yaml", &format!("tools:\n{CUSTOM_DESCRIPTOR}"));
    root.write("WAD.md", &legacy_marker_file("用户写在 WAD.md 的段落\n"));

    let out = update(&root.dir, false).expect("update succeeds");

    let text = root.read("WAD.md");
    assert!(!text.contains("<!-- SPECSEAL:START"), "描述子的区块须被剥除:\n{text}");
    assert_eq!(text, "用户写在 WAD.md 的段落\n", "用户段落须原样保留:\n{text}");
    assert_eq!(out.stripped, vec!["WAD.md".to_string()]);
    assert!(root.exists(".wad/skills/specseal-apply/SKILL.md"), "描述子技能档照常生成");
}

#[test]
fn init_force_over_a_legacy_workspace_strips_the_marker() {
    // design D2：对既有 marker 的项目 re-init（--force）同样走剥除。
    let root = TempRoot::new("strip-init-force");
    init(&root.dir, &[Tool::Claude], false, "openspec").unwrap();
    root.write("CLAUDE.md", &legacy_marker_file(CLAUDE_USER_TEXT));

    init(&root.dir, &[Tool::Claude], true, "openspec").expect("re-init succeeds");

    assert_eq!(root.read("CLAUDE.md"), CLAUDE_USER_TEXT, "区块须被剥除、用户段落保留");
}

/// 一个目标 skills 目录下的 `specseal-*` 目录名集合（排序后）。
fn skill_dirs(root: &TempRoot, rel: &str) -> Vec<String> {
    let mut names: Vec<String> = match std::fs::read_dir(root.at(rel)) {
        Ok(entries) => entries
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.starts_with("specseal-"))
            .collect(),
        Err(_) => Vec::new(),
    };
    names.sort();
    names
}

/// 一个内置工具在 worktree 政策关闭（`init` 样板的缺省）下应有的 `specseal-*`
/// 目录名集合（排序后）——与生成端同源，取自 `managed_skills`，不另抄一份过滤规则。
fn expected_dirs(tool: Tool) -> Vec<String> {
    let mut names: Vec<String> =
        managed_skills(skills::RenderTarget::Builtin(tool), false, "openspec", SpecLocation::InCheckout)
            .into_iter()
            .map(|(dir, _)| dir)
            .collect();
    names.sort();
    names
}

#[test]
fn init_force_switching_tools_prunes_the_deselected_footprint() {
    // Scenario「init --force 切换工具时清除下架足迹」：--force 的选集是内置工具的
    // 完整期望状态，未选工具不得留下可加载的技能档。
    let root = TempRoot::new("init-force-switch");
    init(&root.dir, &[Tool::Claude], false, "openspec").unwrap();
    assert!(!skill_dirs(&root, ".claude/skills").is_empty(), "前置：Claude 技能已生成");

    init(&root.dir, &[Tool::Codex], true, "openspec").expect("re-init 成功");

    assert!(
        skill_dirs(&root, ".claude/skills").is_empty(),
        "未选工具的技能目录须全数移除"
    );
    assert!(!root.exists(".claude"), "空掉的 .claude 目录一并移除");
    assert_eq!(
        skill_dirs(&root, ".agents/skills"),
        expected_dirs(Tool::Codex),
        "选中工具补齐为本次生成集合"
    );
    let app = root.read(".specseal.yaml");
    assert!(app.contains("tools: [codex]"), "{app}");
}

#[test]
fn init_force_prunes_a_renamed_skill_directory() {
    // Scenario「init --force 清除改名技能的旧目录与描述子足迹」的前半：孤儿清理
    // 不再是 update 专属。
    let root = TempRoot::new("init-force-orphan");
    init(&root.dir, &[Tool::Claude], false, "openspec").unwrap();
    root.write(".claude/skills/specseal-onboard/SKILL.md", "旧版生成物\n");

    init(&root.dir, &[Tool::Claude], true, "openspec").expect("re-init 成功");

    assert!(
        !root.exists(".claude/skills/specseal-onboard"),
        "改名前的旧目录须清除"
    );
    assert!(root.exists(".claude/skills/specseal-baseline"), "现行技能仍在");
}

#[test]
fn init_force_resets_custom_footprint_state() {
    // Scenario「init --force 清除改名技能的旧目录与描述子足迹」的后半：--force 把
    // .specseal.yaml 写回样板（描述子一并清掉），足迹与生成物必须同步归零。
    let root = TempRoot::new("init-force-custom-reset");
    init(&root.dir, &[Tool::Claude], false, "openspec").unwrap();
    root.write(".specseal.yaml", &format!("tools:\n  - claude\n{CUSTOM_DESCRIPTOR}"));
    update(&root.dir, false).expect("先生成描述子受管档与足迹");
    assert!(root.exists(".wad/skills/specseal-propose/SKILL.md"), "前置：描述子生成物在");
    assert!(root.exists(".specseal/generated-tools.yaml"), "前置：足迹已记录");

    init(&root.dir, &[Tool::Claude], true, "openspec").expect("re-init 成功");

    assert!(
        skill_dirs(&root, ".wad/skills").is_empty(),
        "描述子的生成物须随设置重写一并清除"
    );
    assert!(
        !root.exists(".specseal/generated-tools.yaml"),
        "足迹状态档须归零"
    );
    let app = root.read(".specseal.yaml");
    assert!(!app.contains("wad-harness"), "--force 重写为样板：{app}");
    assert!(app.contains("tools: [claude]"), "选集重写为本次的 claude：{app}");
}

#[test]
fn init_strips_the_unselected_tools_legacy_marker() {
    // Scenario「init --force 剥除未选工具的遗留区块」：剥除与选取与否无关——
    // 旧版注入的路由表留在 CLAUDE.md 会与技能路由并存。
    let root = TempRoot::new("init-force-strip-unselected");
    init(&root.dir, &[Tool::Claude], false, "openspec").unwrap();
    root.write("CLAUDE.md", &legacy_marker_file(CLAUDE_USER_TEXT));

    init(&root.dir, &[Tool::Codex], true, "openspec").expect("re-init 成功");

    assert_eq!(root.read("CLAUDE.md"), CLAUDE_USER_TEXT, "区块剥除、用户段落保留");
    assert!(!root.exists("AGENTS.md"), "不生成指令档");
}

#[test]
fn init_over_residual_skill_files_rewrites_them() {
    // Scenario「不带 force 的 init 改写残留技能档」：没有 .specseal.yaml 也没有
    // openspec/ 时「已初始化」守门不成立，残留的旧技能档静默保留才是漏洞。
    let root = TempRoot::new("init-residual");
    root.write(".claude/skills/specseal-apply/SKILL.md", "旧版内容\n");
    root.write(".claude/skills/specseal-onboard/SKILL.md", "改名前的旧目录\n");

    init(&root.dir, &[Tool::Claude], false, "openspec").expect("init 成功");

    let applied = root.read(".claude/skills/specseal-apply/SKILL.md");
    assert!(applied.contains(ASSET_VERSION), "残留档须改写为现版：{applied}");
    assert!(
        !root.exists(".claude/skills/specseal-onboard"),
        "残留孤儿目录须清除"
    );
    assert_eq!(
        skill_dirs(&root, ".claude/skills"),
        expected_dirs(Tool::Claude),
        "其余生成集合补齐"
    );
}

#[test]
fn init_on_a_fresh_project_writes_no_instruction_file() {
    // Scenario「指令档零受管区块」：全新目录以两个工具 init 后，项目根不存在
    // 任何指令档，技能档照常生成。
    let root = TempRoot::new("fresh-no-instructions");
    init(&root.dir, &[Tool::Claude, Tool::Codex], false, "openspec").unwrap();

    assert!(!root.exists("CLAUDE.md"), "不得生成 CLAUDE.md");
    assert!(!root.exists("AGENTS.md"), "不得生成 AGENTS.md");
    for tool in [Tool::Claude, Tool::Codex] {
        assert!(root.exists(&propose_skill(tool)), "{} 技能档照常生成", tool.name());
    }
}

#[test]
fn strip_leaves_a_file_with_an_unpaired_start_untouched() {
    // R1：END 行被手动删掉或 merge conflict 弄坏时，剥除不得把 START 之后的
    // 内容吞掉——不成对就整档不动（比特级不变），宁可留一块死文本。
    let root = TempRoot::new("strip-unpaired");
    init(&root.dir, &[Tool::Claude], false, "openspec").unwrap();
    let broken = "<!-- SPECSEAL:START v1.0.0 -->\n\n旧路由表。\n\n用户的重要内容\n";
    root.write("CLAUDE.md", broken);

    let out = update(&root.dir, false).expect("update succeeds");

    assert_eq!(root.read("CLAUDE.md"), broken, "不成对的文件必须比特级不变");
    assert!(out.stripped.is_empty(), "不成对不算剥除：{:?}", out.stripped);
}

#[test]
fn strip_removes_every_legacy_block_in_one_run() {
    // R2：多个遗留区块（坏 merge 叠出来的）一次 update 全剥干净，不用跑第二次。
    let root = TempRoot::new("strip-multi");
    init(&root.dir, &[Tool::Claude], false, "openspec").unwrap();
    root.write(
        "CLAUDE.md",
        "<!-- SPECSEAL:START v1.0.0 -->\nA\n<!-- SPECSEAL:END -->\n中间的用户文本\n<!-- SPECSEAL:START v1.1.0 -->\nB\n<!-- SPECSEAL:END -->\n结尾文本\n",
    );

    let out = update(&root.dir, false).expect("update succeeds");

    let text = root.read("CLAUDE.md");
    assert!(!text.contains("SPECSEAL:START"), "两个区块都要剥掉:\n{text}");
    assert!(text.contains("中间的用户文本") && text.contains("结尾文本"), "{text}");
    assert_eq!(out.stripped, vec!["CLAUDE.md".to_string()]);
}

#[test]
fn strip_handles_crlf_files_without_leaving_blank_lines() {
    // R3：Windows checkout（CRLF）剥除后不得留下前导空行。
    let root = TempRoot::new("strip-crlf");
    init(&root.dir, &[Tool::Claude], false, "openspec").unwrap();
    root.write(
        "CLAUDE.md",
        "<!-- SPECSEAL:START v1.0.0 -->\r\n\r\n旧路由表。\r\n\r\n<!-- SPECSEAL:END -->\r\n用户段落\r\n",
    );

    update(&root.dir, false).expect("update succeeds");

    assert_eq!(root.read("CLAUDE.md"), "用户段落\r\n", "CRLF 分隔空行须一并消失");
}

// --- 技能档过期探测（规格「技能档过期探测」；design D6） ---

/// 比现版领先一个主版号的版号：工作区文件由更新的引擎生成的情境。
fn ahead_of_current() -> String {
    let major: u64 = ASSET_VERSION
        .trim_start_matches('v')
        .split('.')
        .next()
        .and_then(|s| s.parse().ok())
        .expect("ASSET_VERSION 主版号可解析");
    format!("v{}.0.0", major + 1)
}

/// 把某工具 skills 目录下每份技能档的 frontmatter 版号改成指定值
///（仿真以别版引擎生成的工作区——旧值仿真落后、新值仿真领先）。
fn set_skill_version(root: &TempRoot, tool: Tool, version: &str) {
    crate::testkit::set_skill_version(&root.at(tool.skills_dir()), version);
}

#[test]
fn skill_probe_reports_stale_and_lists_differing_files() {
    // Scenario「旧版工作区判过期并列差异档」：技能版号旧于现版即过期。
    let root = TempRoot::new("skill-probe-stale");
    init(&root.dir, &[Tool::Claude], false, "openspec").unwrap();
    set_skill_version(&root, Tool::Claude, "v0.9.0");

    let probe = probe_assets(&root.dir);
    assert_eq!(probe.status, AssetStatus::Stale, "{probe:?}");
    assert_eq!(probe.current_version, ASSET_VERSION);
    assert_eq!(probe.tools.len(), 1);
    assert_eq!(probe.tools[0].tool, "claude");
    assert_eq!(probe.tools[0].workspace_version.as_deref(), Some("v0.9.0"));
    assert!(probe.tools[0].stale && !probe.tools[0].missing && !probe.tools[0].newer);
    assert!(
        probe.differing_files.contains(&propose_skill(Tool::Claude)),
        "改动过的技能档须列入差异清单：{:?}",
        probe.differing_files
    );
}

#[test]
fn skill_probe_reports_newer_when_the_workspace_leads_the_engine() {
    // Example「引擎 v1.11.0 探测 v1.14.0 工作区」的字面版号由
    // `workspace_version_direction_only_orders_parsable_versions` 钉住方向判定；
    // 这里用 ahead_of_current() 让断言不随 ASSET_VERSION 递增而过期。
    // Scenario「工作区文件领先引擎判较新」。
    let root = TempRoot::new("skill-probe-newer");
    init(&root.dir, &[Tool::Claude], false, "openspec").unwrap();
    let ahead = ahead_of_current();
    set_skill_version(&root, Tool::Claude, &ahead);

    let probe = probe_assets(&root.dir);
    assert_eq!(probe.status, AssetStatus::Newer, "{probe:?}");
    assert_eq!(probe.tools[0].workspace_version.as_deref(), Some(ahead.as_str()));
    assert!(probe.tools[0].newer && !probe.tools[0].stale && !probe.tools[0].missing);
    assert!(!probe.differing_files.is_empty(), "较新时仍须回报差异档清单");
}

#[test]
fn skill_probe_reports_missing_when_the_skills_dir_has_no_specseal_skill() {
    // Scenario「技能目录缺少判缺失」：整组技能不在（clone 后技能未进版控），
    // 且缺失胜过另一支的过期。
    let root = TempRoot::new("skill-probe-missing");
    init(&root.dir, &[Tool::Claude, Tool::Codex], false, "openspec").unwrap();
    std::fs::remove_dir_all(root.at(Tool::Codex.skills_dir())).unwrap();
    set_skill_version(&root, Tool::Claude, "v0.9.0");

    let probe = probe_assets(&root.dir);
    assert_eq!(probe.status, AssetStatus::Missing, "{probe:?}");
    let codex = probe.tools.iter().find(|t| t.tool == "codex").expect("codex 在列");
    assert!(codex.missing && !codex.stale, "{codex:?}");
    assert_eq!(codex.workspace_version, None);
    assert!(
        probe.differing_files.contains(&propose_skill(Tool::Codex)),
        "不存在的受管档须列入（内容视为空）：{:?}",
        probe.differing_files
    );
}

#[test]
fn skill_probe_prefers_newer_over_missing_and_stale() {
    // Scenario「较新优先于缺失与过期」。
    let root = TempRoot::new("skill-probe-newer-wins");
    init(&root.dir, &[Tool::Claude, Tool::Codex], false, "openspec").unwrap();
    set_skill_version(&root, Tool::Claude, &ahead_of_current());
    std::fs::remove_dir_all(root.at(Tool::Codex.skills_dir())).unwrap();

    let probe = probe_assets(&root.dir);
    assert_eq!(probe.status, AssetStatus::Newer, "{probe:?}");
    let codex = probe.tools.iter().find(|t| t.tool == "codex").expect("codex 在列");
    assert!(codex.missing && !codex.newer, "缺失的工具不得被标成较新：{codex:?}");
}

#[test]
fn skill_probe_falls_back_to_equality_for_an_unparsable_version() {
    // Scenario「无法解析的版号退回相等判定」。
    let root = TempRoot::new("skill-probe-unparsable");
    init(&root.dir, &[Tool::Claude], false, "openspec").unwrap();
    set_skill_version(&root, Tool::Claude, "v-not-a-version");

    let probe = probe_assets(&root.dir);
    assert_eq!(probe.status, AssetStatus::Stale, "{probe:?}");
    assert!(probe.tools[0].stale && !probe.tools[0].newer, "{:?}", probe.tools[0]);
}

#[test]
fn dropping_the_deprecated_instructions_file_field_does_not_prune_the_descriptor() {
    // R6：用户照弃用提示把 instructions_file 从描述子移除——同一工具不得被
    // 误判「已下架」而整组删掉重建（pruned 与 updated 同列一个工具的自相矛盾）。
    let root = TempRoot::new("descriptor-drop-deprecated-field");
    init(&root.dir, &[Tool::Claude], false, "openspec").unwrap();
    root.write(".specseal.yaml", &format!("tools:\n{CUSTOM_DESCRIPTOR}"));
    update(&root.dir, false).expect("先以带字段的描述子生成足迹");

    // 移除 instructions_file 字段（skills_dir 不变）。
    root.write(
        ".specseal.yaml",
        "tools:\n  - name: wad-harness\n    skills_dir: .wad/skills\n",
    );
    // 在技能目录放一个用户自己的文件：整组 prune 重建会让它消失。
    root.write(".wad/skills/my-note.md", "用户自己的文件\n");

    let out = update(&root.dir, false).expect("update succeeds");

    assert!(
        !out.pruned.contains(&"wad-harness".to_string()),
        "移除弃用字段不得触发 prune：{:?}",
        out.pruned
    );
    assert!(out.updated.contains(&"wad-harness".to_string()));
    assert_eq!(root.read(".wad/skills/my-note.md"), "用户自己的文件\n");
}

#[test]
fn skill_version_parsing_stays_inside_the_frontmatter() {
    // skill_version_of 只认 frontmatter：body 里恰好叫 version: 的内文行不算，
    // body 的 ---- 分隔线也不会提前截断 frontmatter 搜索。
    assert_eq!(
        skill_version_of("---\nname: x\nmetadata:\n  version: \"v9.9.9\"\n---\n\nbody version: \"v0.0.1\"\n"),
        Some("v9.9.9")
    );
    assert_eq!(
        skill_version_of("---\nname: x\n---\n\n----\n\nversion: \"v0.0.1\"\n"),
        None,
        "frontmatter 没有版本行时，body 的 version 行不得被捡走"
    );
    assert_eq!(skill_version_of("no frontmatter\nversion: \"v1\"\n"), None);
}

#[test]
fn skill_probe_reports_unknown_when_the_version_line_is_gone() {
    // R4：SKILL.md 在但 frontmatter 版本行遗失（手改坏）＝「技能档存在但读取
    // 错误」→ 无法判定，绝不可回报现版——那会让坏档永远不被提示修复。
    let root = TempRoot::new("skill-probe-no-version");
    init(&root.dir, &[Tool::Claude], false, "openspec").unwrap();
    for entry in std::fs::read_dir(root.at(Tool::Claude.skills_dir())).unwrap().flatten() {
        let file = entry.path().join("SKILL.md");
        if file.is_file() {
            let text: String = std::fs::read_to_string(&file)
                .unwrap()
                .lines()
                .filter(|l| !l.trim_start().starts_with("version:"))
                .collect::<Vec<_>>()
                .join("\n");
            std::fs::write(&file, text).unwrap();
        }
    }

    let probe = probe_assets(&root.dir);
    assert_eq!(probe.status, AssetStatus::Unknown, "{probe:?}");
}

#[test]
fn skill_probe_reports_unknown_when_the_skills_dir_is_unreadable() {
    // R5：read_dir 失败（路径是文件、权限）不得与「从未安装」混同——回无法
    // 判定，否则 desktop 会给一个按下去必然失败的「安装」动作。
    let root = TempRoot::new("skill-probe-dir-is-file");
    init(&root.dir, &[Tool::Claude], false, "openspec").unwrap();
    std::fs::remove_dir_all(root.at(".claude/skills")).unwrap();
    root.write(".claude/skills", "这是一个文件不是目录");

    let probe = probe_assets(&root.dir);
    assert_eq!(probe.status, AssetStatus::Unknown, "{probe:?}");
}

#[test]
fn skill_update_refuses_a_workspace_whose_skills_lead_the_engine() {
    // 降级守门的版本来源同步改基准：领先的技能档不得被任何再生路径改写。
    let root = TempRoot::new("skill-guard-refuse");
    init(&root.dir, &[Tool::Claude], false, "openspec").unwrap();
    let ahead = ahead_of_current();
    set_skill_version(&root, Tool::Claude, &ahead);
    let before = snapshot(&root);

    let err = update(&root.dir, false).expect_err("领先的工作区必须被拒");
    let msg = err.to_string();
    assert!(msg.contains(&ahead) && msg.contains(ASSET_VERSION), "消息须含两版号：{msg}");
    assert_eq!(msg.lines().count(), 1, "单行错误：{msg}");
    assert_eq!(snapshot(&root), before, "拒绝＝零写入");

    update(&root.dir, true).expect("明示越过后照常再生");
    assert!(
        root.read(&propose_skill(Tool::Claude)).contains(ASSET_VERSION),
        "受管档须再生为引擎现版"
    );
}

#[test]
fn workspace_version_direction_only_orders_parsable_versions() {
    // 规格「技能档过期探测」的数值比较规则：去 v 前缀、以点拆段、逐段数值比较、
    // 段数不足补零；任一边无法完整解析为数字段时不排序方向——宁可误报过期，
    // 不可误报较新（会封锁 update）。
    // spec Example「引擎 v1.11.0 探测 v1.14.0 工作区」的字面值：
    assert!(is_newer_version("v1.14.0", "v1.11.0"), "工作区领先引擎");
    assert!(!is_newer_version("v1.11.0", "v1.14.0"), "工作区落后引擎");
    assert!(!is_newer_version("v1.14.0", "v1.14.0"), "同版不算领先");
    // 逐段数值（非字典序）：v1.9.0 < v1.10.0
    assert!(is_newer_version("v1.10.0", "v1.9.0"), "以数值而非字典序比较");
    // 段数不足补零
    assert!(is_newer_version("v1.14.1", "v1.14"), "缺段视为 0");
    assert!(!is_newer_version("v1.14", "v1.14.0"), "补零后相等不算领先");
    // 无法解析：两个方向都不判较新
    assert!(!is_newer_version("bogus", "v1.14.0"), "无法解析不得判较新");
    assert!(!is_newer_version("v1.14.0-beta", "v1.14.0"), "非纯数字段不得判较新");
    assert!(!is_newer_version("v1.14.0", "bogus"), "引擎端无法解析亦不判较新");
}

#[test]
fn init_force_refuses_a_workspace_that_leads_the_engine() {
    // `--force` 的语意是「覆盖既有文件」，不是「同意降级」——重新初始化同样
    // 不得把领先的技能档改写回旧内容。
    let root = TempRoot::new("init-force-guard");
    init(&root.dir, &[Tool::Claude], false, "openspec").unwrap();
    let ahead = ahead_of_current();
    set_skill_version(&root, Tool::Claude, &ahead);
    let before = snapshot(&root);

    let Err(err) = init(&root.dir, &[Tool::Claude], true, "openspec") else {
        panic!("领先的工作区不得被 --force 重建改写");
    };
    let msg = err.to_string();
    assert!(msg.contains(&ahead) && msg.contains(ASSET_VERSION), "消息须含两版号：{msg}");
    assert_eq!(snapshot(&root), before, "拒绝＝零写入");
}

#[test]
fn the_guard_covers_the_legacy_fallback_without_a_tools_list() {
    // 守门与写入集同源：无 tools: 键的工作区走 .claude/ 目录侦测再生，
    // 探测却因选集为空判现版——这类 legacy 工作区同样必须拒绝降级。
    let root = TempRoot::new("guard-legacy");
    init(&root.dir, &[Tool::Claude], false, "openspec").unwrap();
    // 仿真 legacy 工作区：config 没有 tools 清单，但 .claude/ 目录在。
    root.write(".specseal.yaml", "# Specseal application config\n");
    let ahead = ahead_of_current();
    set_skill_version(&root, Tool::Claude, &ahead);
    let before = snapshot(&root);

    let err = update(&root.dir, false).expect_err("legacy fallback 同样必须被拒");
    let msg = err.to_string();
    assert!(msg.contains(&ahead) && msg.contains(ASSET_VERSION), "{msg}");
    assert_eq!(snapshot(&root), before, "拒绝＝零写入");

    update(&root.dir, true).expect("明示越过照常再生");
    assert!(root.read(&propose_skill(Tool::Claude)).contains(ASSET_VERSION));
}

#[test]
fn the_guard_covers_custom_descriptor_skill_files() {
    // Scenario「自订描述子的技能档同受守门」：只用描述子的工作区不得因判定面
    // 只收 builtin 而被降级。
    let root = TempRoot::new("guard-descriptor");
    init(&root.dir, &[Tool::Claude], false, "openspec").unwrap();
    root.write(".specseal.yaml", &format!("tools:\n{CUSTOM_DESCRIPTOR}"));
    update(&root.dir, false).expect("先生成描述子受管档");
    let ahead = ahead_of_current();
    let skill = root.at(".wad/skills/specseal-propose/SKILL.md");
    let text = std::fs::read_to_string(&skill).unwrap().replace(ASSET_VERSION, &ahead);
    std::fs::write(&skill, text).unwrap();
    let before = snapshot(&root);

    let err = update(&root.dir, false).expect_err("领先的描述子技能档必须被拒");
    assert!(err.to_string().contains(&ahead), "{err}");
    assert_eq!(snapshot(&root), before, "拒绝＝零写入");
}

#[test]
fn reconcile_refuses_a_leading_workspace_before_touching_the_config() {
    // 方向检查在 .specseal.yaml 写入之前：拒绝＝整体零写入，不留
    // 「config 已改、受管档未同步」的半状态。
    let root = TempRoot::new("reconcile-guard");
    init(&root.dir, &[Tool::Claude], false, "openspec").unwrap();
    set_skill_version(&root, Tool::Claude, &ahead_of_current());
    let before = snapshot(&root);

    let err = reconcile_builtin_tools(&root.dir, &[Tool::Claude, Tool::Codex])
        .expect_err("领先的工作区必须在写入 config 前被拒");
    assert!(err.to_string().contains(ASSET_VERSION), "{err}");
    assert_eq!(snapshot(&root), before, "拒绝＝零写入（含 .specseal.yaml）");
}

#[test]
fn probe_reports_current_for_a_freshly_generated_workspace() {
    // Scenario「现版工作区不过期」：差异清单为空。
    let root = TempRoot::new("probe-current");
    init(&root.dir, &[Tool::Claude, Tool::Codex], false, "openspec").unwrap();

    let probe = probe_assets(&root.dir);
    assert_eq!(probe.status, AssetStatus::Current, "{probe:?}");
    assert!(probe.differing_files.is_empty(), "{:?}", probe.differing_files);
    assert!(probe.tools.iter().all(|t| !t.stale && !t.missing));
}

#[test]
fn probe_reports_unknown_for_a_malformed_config() {
    // Scenario「设置损坏回报无法判定」：不得与现版或过期混同。
    let root = TempRoot::new("probe-badconfig");
    init(&root.dir, &[Tool::Claude], false, "openspec").unwrap();
    root.write(".specseal.yaml", "tools: [\n");

    let probe = probe_assets(&root.dir);
    assert_eq!(probe.status, AssetStatus::Unknown, "{probe:?}");
    assert!(probe.tools.is_empty(), "{:?}", probe.tools);
    assert!(probe.differing_files.is_empty(), "{:?}", probe.differing_files);
}

#[test]
fn probe_ignores_line_ending_differences() {
    // Scenario「换行差异不误报」：CRLF 工作区（Windows core.autocrlf）仅换行
    // 形式不同的文件不得列入差异清单。
    let root = TempRoot::new("probe-crlf");
    init(&root.dir, &[Tool::Claude], false, "openspec").unwrap();
    // 只让一份技能档落后（探测依此判过期），另一份维持现版内容但改成 CRLF。
    let stale = ".claude/skills/specseal-analyze/SKILL.md";
    root.write(stale, &root.read(stale).replace(ASSET_VERSION, "v0.9.0"));
    let skill = propose_skill(Tool::Claude);
    let crlf = root.read(&skill).replace('\n', "\r\n");
    root.write(&skill, &crlf);

    let probe = probe_assets(&root.dir);
    assert_eq!(probe.status, AssetStatus::Stale, "{probe:?}");
    assert!(
        !probe.differing_files.contains(&skill),
        "仅换行形式不同的文件不得列入：{:?}",
        probe.differing_files
    );
}

/// tools 清单＝claude 加一个描述子，并让两边的受管档都生成到现版。
fn workspace_with_descriptor(tag: &str) -> TempRoot {
    let root = TempRoot::new(tag);
    init(&root.dir, &[Tool::Claude], false, "openspec").unwrap();
    root.write(".specseal.yaml", &format!("tools:\n  - claude\n{MY_HARNESS_DESCRIPTOR}"));
    update(&root.dir, false).expect("先把两边的受管档生成到现版");
    root
}

#[test]
fn probe_reports_missing_for_a_descriptor_without_skills() {
    // Scenario「描述子技能档缺失判缺失」：描述子的技能档与内置技能档同为受管档，
    // 整组不在即缺失，差异清单以描述子的 skills_dir 起头。
    let root = workspace_with_descriptor("probe-descriptor-missing");
    std::fs::remove_dir_all(root.at(".my-harness/skills")).unwrap();

    let probe = probe_assets(&root.dir);
    assert_eq!(probe.status, AssetStatus::Missing, "{probe:?}");
    let harness = probe
        .tools
        .iter()
        .find(|t| t.tool == "my-harness")
        .expect("逐工具信息须含描述子的 name");
    assert!(harness.missing, "{harness:?}");
    assert_eq!(harness.workspace_version, None, "{harness:?}");
    let claude = probe.tools.iter().find(|t| t.tool == "claude").unwrap();
    assert!(!claude.missing && !claude.stale && !claude.newer, "{claude:?}");
    assert!(
        !probe.differing_files.is_empty(),
        "缺失须列出描述子的受管档"
    );
    for path in &probe.differing_files {
        assert!(
            path.starts_with(".my-harness/skills/specseal-") && path.ends_with("/SKILL.md"),
            "差异清单只该含描述子技能档：{path}"
        );
    }
    // 非 Claude 子集＋worktree 政策关闭：两颗 worktree 技能不在预期生成集合内。
    for gated in ["specseal-apply-with-worktree", "specseal-worktree-merge"] {
        assert!(
            !probe.differing_files.iter().any(|p| p.contains(gated)),
            "被政策排除的技能不得列入：{:?}",
            probe.differing_files
        );
    }
}

#[test]
fn probe_lists_descriptor_paths_in_differing_files() {
    // Scenario「描述子技能档过期判过期」：描述子侧落后即整体过期，且两侧同时落后
    // 时差异清单同时涵盖内置与描述子——判定面不再只有 builtin。
    let root = workspace_with_descriptor("probe-descriptor-both");
    for skill in [
        ".claude/skills/specseal-propose/SKILL.md",
        ".my-harness/skills/specseal-propose/SKILL.md",
    ] {
        root.write(skill, &root.read(skill).replace(ASSET_VERSION, "v0.9.0"));
    }

    let probe = probe_assets(&root.dir);
    assert_eq!(probe.status, AssetStatus::Stale, "{probe:?}");
    let harness = probe.tools.iter().find(|t| t.tool == "my-harness").unwrap();
    assert!(harness.stale && !harness.newer && !harness.missing, "{harness:?}");
    for expected in [
        ".claude/skills/specseal-propose/SKILL.md",
        ".my-harness/skills/specseal-propose/SKILL.md",
    ] {
        assert!(
            probe.differing_files.iter().any(|p| p == expected),
            "{expected} 须列入：{:?}",
            probe.differing_files
        );
    }
}

#[test]
fn tool_selection_keeps_valid_descriptors_after_a_bad_one() {
    // 第一个坏描述子只决定 descriptor_error；它后面的合法描述子仍要进 customs，
    // 否则探测会看不见那个工具（update 反正在写入前就以错误停下）。
    let root = TempRoot::new("tool-selection-bad-then-good");
    let sel = ToolSelection::resolve(
        &root.dir,
        &app_config(&format!("tools:\n  - codex\n  - name: broken-harness\n{CUSTOM_DESCRIPTOR}")),
    );
    assert_eq!(
        sel.descriptor_error.as_deref(),
        Some("tool descriptor: missing required field 'skills_dir'"),
        "第一个问题被保留"
    );
    assert_eq!(sel.customs.len(), 1, "坏描述子后面的合法描述子仍被收下：{:?}", sel.customs);
    assert_eq!(sel.customs[0].name, "wad-harness");
}

#[test]
fn probe_still_covers_a_valid_descriptor_after_an_invalid_one() {
    // 探测面＝计划的 targets：合法描述子不得因为前面排了一个坏描述子而消失。
    let root = workspace_with_descriptor("probe-descriptor-after-invalid");
    root.write(
        ".specseal.yaml",
        &format!("tools:\n  - claude\n  - name: broken-harness\n{MY_HARNESS_DESCRIPTOR}"),
    );
    std::fs::remove_dir_all(root.at(".my-harness/skills")).unwrap();

    let probe = probe_assets(&root.dir);
    assert_eq!(probe.status, AssetStatus::Missing, "{probe:?}");
    let harness = probe.tools.iter().find(|t| t.tool == "my-harness").expect("my-harness 仍在判定面");
    assert!(harness.missing, "{harness:?}");
}

#[test]
fn probe_normalizes_a_descriptor_skills_dir_with_a_trailing_slash() {
    // 描述子的 skills_dir 是用户手写的字符串：结尾斜线不得在差异清单里变成 `//`。
    let root = TempRoot::new("probe-descriptor-trailing-slash");
    init(&root.dir, &[Tool::Claude], false, "openspec").unwrap();
    root.write(
        ".specseal.yaml",
        "tools:\n  - claude\n  - name: my-harness\n    skills_dir: .my-harness/skills/\n",
    );
    update(&root.dir, false).expect("结尾斜线的 skills_dir 合法，先生成到现版");
    std::fs::remove_dir_all(root.at(".my-harness/skills")).unwrap();

    let probe = probe_assets(&root.dir);
    assert_eq!(probe.status, AssetStatus::Missing, "{probe:?}");
    assert!(!probe.differing_files.is_empty());
    for path in &probe.differing_files {
        assert!(
            path.starts_with(".my-harness/skills/specseal-") && !path.contains("//"),
            "路径须范式：{path}"
        );
    }
}

#[test]
fn probe_ignores_an_invalid_descriptor() {
    // Scenario「无效描述子不影响探测」：坏描述子不成为 target，探测是唯读提示面，
    // 「设置里有个坏描述子」由 update 的错误告知，不得让探测转为无法判定。
    let root = TempRoot::new("probe-descriptor-invalid");
    init(&root.dir, &[Tool::Claude], false, "openspec").unwrap();
    root.write(".specseal.yaml", "tools:\n  - claude\n  - name: my-harness\n");

    let probe = probe_assets(&root.dir);
    assert_eq!(probe.status, AssetStatus::Current, "{probe:?}");
    assert_eq!(probe.tools.len(), 1, "{:?}", probe.tools);
    assert_eq!(probe.tools[0].tool, "claude");
    assert!(probe.differing_files.is_empty(), "{:?}", probe.differing_files);
}

#[test]
fn probe_with_an_empty_tools_list_reports_current_and_writes_nothing() {
    // tools 空清单＝没有受管工具可查：回报现版、零差异；且探测全程零写入。
    let root = TempRoot::new("probe-empty-tools");
    init(&root.dir, &[], false, "openspec").unwrap();
    let before = snapshot(&root);

    let probe = probe_assets(&root.dir);
    assert_eq!(probe.status, AssetStatus::Current, "{probe:?}");
    assert!(probe.tools.is_empty());
    assert_eq!(snapshot(&root), before, "探测不得写入任何文件");
}

// --- 探测回报迁移状态（desktop-spec-dir-migration D1；需求「技能档提示承载规格文件夹迁移」）---

fn git(root: &TempRoot, args: &[&str]) {
    let ok = std::process::Command::new("git")
        .arg("-C")
        .arg(&root.dir)
        .args(["-c", "user.name=T", "-c", "user.email=t@example.com"])
        .args(args)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    assert!(ok, "git {args:?} failed");
}

fn commit_all(root: &TempRoot) {
    git(root, &["init", "-q"]);
    git(root, &["add", "-A"]);
    git(root, &["commit", "-qm", "init"]);
}

/// 旧布局项目：`.specseal.yaml` 没有 spec_dir、规格在 openspec/，两个变更数据档
///（一个作用中、一个已封存），技能档为现版。
fn legacy_workspace(tag: &str) -> TempRoot {
    let root = TempRoot::new(tag);
    init(&root.dir, &[Tool::Claude], false, "openspec").unwrap();
    root.write(".specseal.yaml", "tools: [claude]\n");
    root.write("openspec/changes/demo/.openspec.yaml", "schema: spec-driven\n");
    root.write("openspec/changes/archive/2026-01-01-done/.openspec.yaml", "schema: spec-driven\n");
    root
}

fn pending(meta_files: usize) -> crate::migrate::MigrationProbe {
    crate::migrate::MigrationProbe::Pending { folder: crate::migrate::SpecFolder::Openspec, meta_files }
}

fn deferred(reason: crate::migrate::DeferCode, worktrees: Vec<String>) -> crate::migrate::MigrationProbe {
    crate::migrate::MigrationProbe::Deferred { folder: crate::migrate::SpecFolder::Openspec, reason, worktrees }
}

#[test]
fn probe_reports_a_pending_migration_even_when_the_skills_are_current() {
    // Scenario「技能档不过期也提示迁移」：技能档是现版，迁移状态照样回报。
    let root = legacy_workspace("probe-migration-pending");
    commit_all(&root);
    let before = project_snapshot(&root);

    let probe = probe_assets(&root.dir);
    assert_eq!(probe.status, AssetStatus::Current, "{probe:?}");
    assert_eq!(probe.migration, pending(2), "{probe:?}");
    // Scenario「app 升版不在背景迁移」：探测只读，openspec/ 原封不动。
    assert_eq!(project_snapshot(&root), before, "探测不得移动或写入任何文件");
    assert!(root.exists("openspec/changes/demo/.openspec.yaml"));
}

#[test]
fn probe_reports_the_migration_beside_stale_skills() {
    let root = legacy_workspace("probe-migration-stale");
    set_skill_version(&root, Tool::Claude, "v0.9.0");

    let probe = probe_assets(&root.dir);
    assert_eq!(probe.status, AssetStatus::Stale, "{probe:?}");
    assert_eq!(probe.migration, pending(2), "{probe:?}");
}

#[test]
fn probe_defers_the_migration_while_other_worktrees_exist() {
    // Scenario「暂缓时只更新技能档」：主目录看到其他 worktree 的路径；
    // linked worktree 本身回报 linkedWorktree。
    let root = legacy_workspace("probe-migration-worktrees");
    commit_all(&root);
    let wt = root.at("wt");
    git(&root, &["worktree", "add", "-q", wt.to_str().unwrap(), "-b", "side"]);
    let listed: Vec<String> =
        crate::testkit::listed_worktrees(&root.dir).iter().map(|p| p.display().to_string()).collect();
    assert_eq!(listed.len(), 1);

    assert_eq!(probe_assets(&root.dir).migration, deferred(crate::migrate::DeferCode::OtherWorktrees, listed));
    assert_eq!(probe_assets(&wt).migration, deferred(crate::migrate::DeferCode::LinkedWorktree, Vec::new()));
}

#[test]
fn probe_defers_the_migration_while_openspec_has_uncommitted_changes() {
    let root = legacy_workspace("probe-migration-dirty");
    commit_all(&root);
    root.write("openspec/changes/demo/tasks.md", "- [ ] 1.1 x\n");

    assert_eq!(probe_assets(&root.dir).migration, deferred(crate::migrate::DeferCode::Uncommitted, Vec::new()));
}

#[test]
fn probe_reports_no_migration_for_the_new_layout_an_explicit_spec_dir_or_remote_mode() {
    let fresh = TempRoot::new("probe-migration-new-layout");
    init(&fresh.dir, &[Tool::Claude], false, DEFAULT_SPEC_DIR).unwrap();
    assert_eq!(probe_assets(&fresh.dir).migration, crate::migrate::MigrationProbe::None, "new layout");

    // init 以非缺省文件夹初始化会写入 `spec_dir: openspec`。
    let explicit = TempRoot::new("probe-migration-explicit");
    init(&explicit.dir, &[Tool::Claude], false, "openspec").unwrap();
    explicit.write("openspec/changes/demo/.openspec.yaml", "schema: spec-driven\n");
    assert_eq!(probe_assets(&explicit.dir).migration, crate::migrate::MigrationProbe::None, "explicit spec_dir");

    let remote = TempRoot::new("probe-migration-remote");
    seed_remote_workspace(&remote, &[Tool::Claude]);
    remote.write("openspec/changes/demo/.openspec.yaml", "schema: spec-driven\n");
    assert_eq!(probe_assets(&remote.dir).migration, crate::migrate::MigrationProbe::None, "remote");
}

#[test]
fn sync_skills_regenerates_without_moving_the_spec_folder() {
    // spec「技能足迹同步不迁移规格文件夹」（desktop-spec-dir-migration D6）：worktree 政策
    // 切换的技能同步不迁移；降级守门照旧。
    let root = legacy_workspace("sync-skills-no-migration");
    commit_all(&root);
    std::fs::remove_dir_all(root.at(".claude/skills/specseal-propose")).unwrap();

    let outcome = sync_skills(&root.dir).expect("sync succeeds");
    assert_eq!(outcome.migration, crate::migrate::MigrationPlan::Nothing);
    assert!(root.exists("openspec/changes/demo/.openspec.yaml"), "openspec/ 原封不动");
    assert!(!root.exists("specseal"));
    assert!(root.exists(".claude/skills/specseal-propose/SKILL.md"), "技能档照常再生");

    set_skill_version(&root, Tool::Claude, &ahead_of_current());
    assert!(sync_skills(&root.dir).is_err(), "工作区领先引擎时照样拒绝");
}

#[test]
fn probe_serializes_the_migration_in_camel_case() {
    let root = legacy_workspace("probe-migration-json");
    let value = serde_json::to_value(probe_assets(&root.dir)).unwrap();
    assert_eq!(
        value["migration"],
        serde_json::json!({ "state": "pending", "folder": "openspec", "metaFiles": 2 })
    );

    let value = serde_json::to_value(deferred(crate::migrate::DeferCode::OtherWorktrees, vec!["/w".into()])).unwrap();
    assert_eq!(
        value,
        serde_json::json!({ "state": "deferred", "folder": "openspec", "reason": "otherWorktrees", "worktrees": ["/w"] })
    );
    assert_eq!(
        serde_json::to_value(crate::migrate::MigrationProbe::None).unwrap(),
        serde_json::json!({ "state": "none" })
    );
}

// --- worktree 政策闸：生成集合随 openspec/config.yaml 的 worktree 档值 ---
// Spec requirement「worktree 技能的政策条件式生成」。

/// 两颗受闸控技能于某工具 skills 目录下的相对路径。
fn worktree_skill_dirs(tool: Tool) -> [String; 2] {
    [
        format!("{}/specseal-apply-with-worktree", tool.skills_dir()),
        format!("{}/specseal-worktree-merge", tool.skills_dir()),
    ]
}

/// 覆写 workflow config 的 worktree 政策（其余字段不留，测试只关心这一键）。
fn set_worktree_policy(root: &TempRoot, on: bool) {
    root.write("openspec/config.yaml", &format!("schema: spec-driven\nworktree: {on}\n"));
}

#[test]
fn generation_omits_worktree_skills_when_the_policy_key_is_absent() {
    // Scenario「政策关闭时生成集合不含 worktree 技能」的键缺席分支：init 范本
    // 只留注解示例，等同未设＝关。
    let root = TempRoot::new("gate-absent");
    init(&root.dir, &[Tool::Claude], true, "openspec").unwrap();

    for dir in worktree_skill_dirs(Tool::Claude) {
        assert!(!root.exists(&dir), "政策未设时不得生成 {dir}");
    }
    // 其余技能照常生成。
    assert!(root.exists(".claude/skills/specseal-apply"), "非闸控技能须照常生成");
}

#[test]
fn generation_omits_worktree_skills_when_the_policy_is_false() {
    let root = TempRoot::new("gate-false");
    init(&root.dir, &[Tool::Claude], true, "openspec").unwrap();
    set_worktree_policy(&root, false);

    update(&root.dir, false).unwrap();

    for dir in worktree_skill_dirs(Tool::Claude) {
        assert!(!root.exists(&dir), "政策为 false 时不得生成 {dir}");
    }
    assert!(root.exists(".claude/skills/specseal-apply"));
}

#[test]
fn generation_includes_worktree_skills_when_the_policy_is_on() {
    // Scenario「政策打开时注入两颗技能」。
    let root = TempRoot::new("gate-on");
    init(&root.dir, &[Tool::Claude], true, "openspec").unwrap();
    set_worktree_policy(&root, true);

    update(&root.dir, false).unwrap();

    for dir in worktree_skill_dirs(Tool::Claude) {
        assert!(root.exists(&format!("{dir}/SKILL.md")), "政策为 true 时须生成 {dir}");
    }
}

#[test]
fn the_gate_applies_to_codex_and_custom_descriptors_alike() {
    // 需求句「此过滤对 claude、codex 与自订描述子工具一视同仁」。
    let root = TempRoot::new("gate-all-targets");
    init(&root.dir, &[Tool::Claude, Tool::Codex], true, "openspec").unwrap();
    // init 以非缺省文件夹初始化时会写明 spec_dir；改写时保留它，免得变成待迁移的旧布局。
    root.write(
        ".specseal.yaml",
        &format!("spec_dir: openspec\ntools:\n  - claude\n  - codex\n{CUSTOM_DESCRIPTOR}"),
    );

    update(&root.dir, false).unwrap();
    for dir in worktree_skill_dirs(Tool::Codex) {
        assert!(!root.exists(&dir), "政策关闭时 codex 不得生成 {dir}");
    }
    assert!(!root.exists(".wad/skills/specseal-apply-with-worktree"), "描述子亦受闸控");
    assert!(root.exists(".wad/skills/specseal-apply"), "描述子的非闸控技能照常生成");

    set_worktree_policy(&root, true);
    update(&root.dir, false).unwrap();
    for dir in worktree_skill_dirs(Tool::Codex) {
        assert!(root.exists(&dir), "政策打开时 codex 须生成 {dir}");
    }
    assert!(root.exists(".wad/skills/specseal-apply-with-worktree/SKILL.md"));
}

#[test]
fn an_unparseable_workflow_config_keeps_the_worktree_skills() {
    // 删除是不可逆方向：政策读不出来时（用户手改坏了 config.yaml）一律保留
    // 技能，由技能内的运行期政策检查兜底，绝不以「读不到＝关」为由清掉文件。
    let root = TempRoot::new("gate-broken-config");
    init(&root.dir, &[Tool::Claude], true, "openspec").unwrap();
    set_worktree_policy(&root, true);
    update(&root.dir, false).unwrap();

    root.write("openspec/config.yaml", "schema: [unterminated\n");
    update(&root.dir, false).unwrap();

    for dir in worktree_skill_dirs(Tool::Claude) {
        assert!(root.exists(&dir), "政策文档坏掉时不得清掉 {dir}");
    }
}

// --- update 清除孤儿技能目录 ---
// Spec requirement: workspace-tools「update 清除孤儿技能目录」——specseal- 前缀
// 且不在本次应生成集合的目录于 update 时清除；非前缀目录不动。

#[test]
fn update_prunes_renamed_skill_directory() {
    let root = TempRoot::new("prune-renamed");
    init(&root.dir, &[Tool::Claude, Tool::Codex], false, "openspec").unwrap();
    // 旧版生成的目录：registry 已无此技能名（onboard → baseline 改名迁移）。
    root.write(".claude/skills/specseal-onboard/SKILL.md", "old\n");
    root.write(".agents/skills/specseal-onboard/SKILL.md", "old\n");
    update(&root.dir, false).unwrap();
    assert!(!root.exists(".claude/skills/specseal-onboard"), "旧目录须被清除");
    assert!(!root.exists(".agents/skills/specseal-onboard"), "旧目录须被清除");
    assert!(root.exists(".claude/skills/specseal-baseline/SKILL.md"));
    assert!(root.exists(".agents/skills/specseal-baseline/SKILL.md"));
}

#[test]
fn update_keeps_user_skill_directories_without_prefix() {
    let root = TempRoot::new("prune-user-dir");
    init(&root.dir, &[Tool::Claude], false, "openspec").unwrap();
    let content = "user skill\n";
    root.write(".claude/skills/conventional-commit/SKILL.md", content);
    update(&root.dir, false).unwrap();
    assert_eq!(
        root.read(".claude/skills/conventional-commit/SKILL.md"),
        content,
        "非 specseal- 前缀的用户技能不受清理影响"
    );
}

#[test]
fn update_prunes_prefixed_directories_not_in_registry() {
    let root = TempRoot::new("prune-prefixed");
    init(&root.dir, &[Tool::Claude], false, "openspec").unwrap();
    root.write(".claude/skills/specseal-myown/SKILL.md", "mine\n");
    update(&root.dir, false).unwrap();
    // specseal- 前缀保留给生成物：非 registry 的前缀目录一律清除。
    assert!(!root.exists(".claude/skills/specseal-myown"));
}

fn app_config(yaml: &str) -> crate::config::AppConfig {
    serde_yaml::from_str(yaml).expect("app config parses")
}

/// 工具选集是 `.specseal.yaml` tools 清单的唯一解析点：内置名去重、顺序固定
/// claude → codex，没有清单时才是 legacy 回退。
#[test]
fn tool_selection_resolves_builtins_without_duplicates() {
    let root = TempRoot::new("tool-selection-builtins");
    let sel = ToolSelection::resolve(&root.dir, &app_config("tools: [claude, codex, claude]\n"));
    assert_eq!(sel.builtins, vec![Tool::Claude, Tool::Codex]);
    assert!(!sel.legacy_fallback, "a non-empty list is not the legacy path");
    assert!(sel.customs.is_empty());
    assert!(sel.notes.is_empty());
    assert_eq!(sel.descriptor_error, None);
}

/// 合法描述子与内置名混在同一份清单：两边都解析出来，没有错误。
#[test]
fn tool_selection_carries_a_valid_descriptor_beside_the_builtins() {
    let root = TempRoot::new("tool-selection-descriptor");
    let sel = ToolSelection::resolve(
        &root.dir,
        &app_config(&format!("tools:\n  - claude\n{CUSTOM_DESCRIPTOR}")),
    );
    assert_eq!(sel.builtins, vec![Tool::Claude]);
    assert_eq!(sel.customs.len(), 1, "the descriptor resolves: {:?}", sel.customs);
    assert_eq!(sel.customs[0].name, "wad-harness");
    assert_eq!(sel.customs[0].skills_dir, ".wad/skills");
    assert_eq!(sel.descriptor_error, None);
}

/// 坏描述子不在解析时就变成 `Err`：错误留在值上由消费端裁决（update 转错误、
/// probe 忽略），内置名照样解析出来。
#[test]
fn tool_selection_defers_a_bad_descriptor_to_its_consumer() {
    let root = TempRoot::new("tool-selection-bad-descriptor");
    let sel = ToolSelection::resolve(
        &root.dir,
        &app_config("tools:\n  - codex\n  - name: broken-harness\n"),
    );
    assert_eq!(sel.builtins, vec![Tool::Codex], "the builtins still resolve");
    assert!(sel.customs.is_empty(), "an invalid descriptor never reaches the filesystem");
    let message = sel.descriptor_error.expect("the descriptor error is carried on the value");
    assert_eq!(message, "tool descriptor: missing required field 'skills_dir'");
}

/// 空 tools 清单＝legacy 回退：只有 `.claude` 目录存在时才把 Claude 算进选集。
#[test]
fn tool_selection_falls_back_to_the_claude_footprint_for_an_empty_list() {
    let root = TempRoot::new("tool-selection-empty");
    let app = app_config("tools: []\n");
    let sel = ToolSelection::resolve(&root.dir, &app);
    assert!(sel.builtins.is_empty(), "no .claude directory means nothing to regenerate");
    assert!(sel.legacy_fallback);

    std::fs::create_dir_all(root.at(".claude")).unwrap();
    let sel = ToolSelection::resolve(&root.dir, &app);
    assert_eq!(sel.builtins, vec![Tool::Claude]);
    assert!(sel.legacy_fallback);
}

/// 未知内置名只是警告：消息字面与今天 `update` 的一模一样。
#[test]
fn tool_selection_notes_an_unknown_builtin_name() {
    let root = TempRoot::new("tool-selection-unknown");
    let sel = ToolSelection::resolve(&root.dir, &app_config("tools: [claude, windsurf]\n"));
    assert_eq!(sel.builtins, vec![Tool::Claude]);
    assert_eq!(
        sel.notes,
        vec![
            "unknown tool 'windsurf' in .specseal.yaml tools list (supported: claude, codex, copilot, pi, cursor)"
                .to_string()
        ]
    );
    assert!(!sel.legacy_fallback);
}

/// `builtins_only` 是 init／reconcile 的内存入口：选集逐字带过，没有描述子、
/// 没有回退、没有警告。
#[test]
fn tool_selection_builtins_only_takes_the_selection_verbatim() {
    let sel = ToolSelection::builtins_only(&[Tool::Codex]);
    assert_eq!(sel.builtins, vec![Tool::Codex]);
    assert!(sel.customs.is_empty());
    assert!(sel.notes.is_empty());
    assert!(!sel.legacy_fallback);
    assert_eq!(sel.descriptor_error, None);
}

/// 与 `CUSTOM_DESCRIPTOR` 同一个描述子的已验证形式。
fn custom_target() -> CustomTool {
    CustomTool {
        name: "wad-harness".to_string(),
        skills_dir: ".wad/skills".to_string(),
        instructions_file: Some("WAD.md".to_string()),
        invocation: crate::config::Invocation::Cli,
    }
}

fn dir_names(set: &[(String, String)]) -> Vec<String> {
    set.iter().map(|(dir, _)| dir.clone()).collect()
}

/// registry 依 `non_claude` 过滤后的 `specseal-<name>` 目录名（顺序同 registry）。
fn registry_dirs(non_claude: bool) -> Vec<String> {
    skills::registry()
        .iter()
        .filter(|s| !(non_claude && s.claude_only))
        .map(|s| format!("specseal-{}", s.name))
        .collect()
}

/// 受管技能集合只有一个拥有者：Claude 目标拿 registry 全集，非 Claude 目标拿
/// 非 Claude 子集，每一笔内容逐字等于同参数的 render。
#[test]
fn managed_skills_covers_the_registry_per_target() {
    let custom = custom_target();
    let claude = managed_skills(skills::RenderTarget::Builtin(Tool::Claude), true, "openspec", SpecLocation::InCheckout);
    let codex = managed_skills(skills::RenderTarget::Builtin(Tool::Codex), true, "openspec", SpecLocation::InCheckout);
    let neutral = managed_skills(skills::RenderTarget::Custom(&custom), true, "openspec", SpecLocation::InCheckout);

    assert_eq!(dir_names(&claude), registry_dirs(false));
    assert_eq!(dir_names(&codex), registry_dirs(true));
    assert_eq!(dir_names(&neutral), registry_dirs(true));

    let registry = skills::registry();
    for (target, set) in [
        (skills::RenderTarget::Builtin(Tool::Claude), &claude),
        (skills::RenderTarget::Builtin(Tool::Codex), &codex),
        (skills::RenderTarget::Custom(&custom), &neutral),
    ] {
        // 集合里的每一笔都比内容——不是「找得到才比」。
        for (dir, content) in set {
            let skill = registry
                .iter()
                .find(|s| format!("specseal-{}", s.name) == *dir)
                .unwrap_or_else(|| panic!("{dir} 不在 registry"));
            assert_eq!(
                content,
                &skills::render_skill_file_for(target, skill, "openspec", SpecLocation::InCheckout),
                "{dir} 的内容必须等于同参数的 render"
            );
        }
    }
}

/// worktree 政策关闭时，三个目标的受管集合都不含两颗 worktree 技能。
#[test]
fn managed_skills_drops_the_gated_skills_when_the_policy_is_off() {
    let custom = custom_target();
    for set in [
        managed_skills(skills::RenderTarget::Builtin(Tool::Claude), false, "openspec", SpecLocation::InCheckout),
        managed_skills(skills::RenderTarget::Builtin(Tool::Codex), false, "openspec", SpecLocation::InCheckout),
        managed_skills(skills::RenderTarget::Custom(&custom), false, "openspec", SpecLocation::InCheckout),
    ] {
        for gated in ["specseal-apply-with-worktree", "specseal-worktree-merge"] {
            assert!(
                !set.iter().any(|(dir, _)| dir == gated),
                "政策关闭时受管集合不得含 {gated}"
            );
        }
    }
}

/// 计划的每个 target 带自己的 skills_root；未选中的内置进 `deselected_builtins`。
#[test]
fn sync_plan_builds_one_target_per_selected_tool() {
    let root = TempRoot::new("sync-plan-targets");
    let plan =
        SyncPlan::resolve(&root.dir, ToolSelection::builtins_only(&[Tool::Codex]), "openspec", SpecLocation::InCheckout);
    assert_eq!(plan.targets.len(), 1, "只选 codex 就只有一个 target");
    assert_eq!(plan.targets[0].label, "codex");
    assert_eq!(plan.targets[0].skills_root, root.at(".agents/skills"));
    assert_eq!(
        plan.deselected_builtins,
        vec![Tool::Claude, Tool::Copilot, Tool::Pi, Tool::Cursor]
    );
}

/// legacy 回退（没有 tools 清单）不下架任何内置工具。
#[test]
fn sync_plan_prunes_nothing_on_the_legacy_fallback() {
    let root = TempRoot::new("sync-plan-legacy");
    std::fs::create_dir_all(root.at(".claude")).unwrap();
    let selection = ToolSelection::resolve(&root.dir, &app_config("tools: []\n"));
    let plan = SyncPlan::resolve(&root.dir, selection, "openspec", SpecLocation::InCheckout);
    assert_eq!(plan.targets.len(), 1);
    assert_eq!(plan.targets[0].label, "claude");
    assert!(plan.deselected_builtins.is_empty(), "没有清单就没有「下架」这回事");
}

/// 描述子各自成为一个 target，skills_root 就是描述子声明的目录。
#[test]
fn sync_plan_adds_a_target_for_each_descriptor() {
    let root = TempRoot::new("sync-plan-descriptor");
    let selection = ToolSelection::resolve(
        &root.dir,
        &app_config(&format!("tools:\n  - claude\n{CUSTOM_DESCRIPTOR}")),
    );
    let plan = SyncPlan::resolve(&root.dir, selection, "openspec", SpecLocation::InCheckout);
    assert_eq!(plan.targets.len(), 2);
    assert_eq!(plan.targets[0].label, "claude");
    assert_eq!(plan.targets[1].label, "wad-harness");
    assert_eq!(plan.targets[1].skills_root, root.at(".wad/skills"));
    assert_eq!(
        plan.deselected_builtins,
        vec![Tool::Codex, Tool::Copilot, Tool::Pi, Tool::Cursor]
    );
}

/// 守门的检查面就是 targets 的 skills_root 集合：只有描述子目录领先版本时
/// 一样被拒，消息含工作区与引擎两个版号。
#[test]
fn sync_plan_guard_checks_every_targets_skills_root() {
    let root = TempRoot::new("sync-plan-guard");
    init(&root.dir, &[Tool::Claude], false, "openspec").unwrap();
    root.write(".specseal.yaml", &format!("tools:\n{CUSTOM_DESCRIPTOR}"));
    update(&root.dir, false).expect("先生成描述子受管档");
    let ahead = ahead_of_current();
    crate::testkit::set_skill_version(&root.at(".wad/skills"), &ahead);

    let app = crate::config::AppConfig::load(&root.at(".specseal.yaml")).expect("config parses");
    let plan = SyncPlan::resolve(&root.dir, ToolSelection::resolve(&root.dir, &app), "openspec", SpecLocation::InCheckout);
    assert_eq!(
        plan.targets.iter().map(|t| t.skills_root.clone()).collect::<Vec<PathBuf>>(),
        vec![root.at(".wad/skills")],
        "守门的检查面等于 targets 的 skills_root"
    );

    let message = plan.guard().expect_err("只有描述子目录领先也必须被拒").to_string();
    assert!(message.contains(&ahead), "消息须含工作区版号：{message}");
    assert!(message.contains(ASSET_VERSION), "消息须含引擎版号：{message}");
}

/// `init --force` 会把 `openspec/config.yaml` 写回范本（worktree 政策关闭）：上一次
/// 政策打开留下的两颗 worktree 技能目录必须跟着消失（旧 `skip_gated_skill` 的行为），
/// 其余技能照常在。
#[test]
fn init_force_removes_gated_skill_directories_the_reset_policy_no_longer_allows() {
    let root = TempRoot::new("init-force-gated");
    init(&root.dir, &[Tool::Claude], false, "openspec").unwrap();
    set_worktree_policy(&root, true);
    update(&root.dir, false).unwrap();
    for dir in worktree_skill_dirs(Tool::Claude) {
        assert!(root.exists(&format!("{dir}/SKILL.md")), "前置：政策打开时 {dir} 存在");
    }

    init(&root.dir, &[Tool::Claude], true, "openspec").unwrap();

    assert!(
        !root.read("openspec/config.yaml").contains("\nworktree: true"),
        "--force 把 config.yaml 写回范本"
    );
    for dir in worktree_skill_dirs(Tool::Claude) {
        assert!(!root.exists(&dir), "政策被重置为关闭后 {dir} 不得留下");
    }
    assert!(root.exists(".claude/skills/specseal-apply/SKILL.md"));
}

// --- 内置 copilot（change: add-copilot-tool）---
// Spec requirement「Copilot 渲染目标」与「worktree 技能的政策条件式生成」的 copilot
// 分支：技能落在 .github/skills、子集与内容沿用 codex，只有叫用前缀与 agent 名不同。

#[test]
fn copilot_generates_the_codex_subset_under_github_skills() {
    // Scenario「Copilot 与 Codex 生成集合相同」：非 Claude 子集，政策关闭时不含两颗
    // worktree 技能。
    let root = TempRoot::new("copilot-subset");
    init(&root.dir, &[Tool::Copilot], false, "openspec").unwrap();

    assert_eq!(Tool::Copilot.skills_dir(), ".github/skills");
    let generated = skill_dirs(&root, ".github/skills");
    assert_eq!(
        generated,
        expected_dirs(Tool::Codex),
        "copilot 的生成集合须等于 codex 的"
    );
    assert!(
        !generated.contains(&"specseal-analyze".to_string()),
        "analyze 只给 claude"
    );
    for dir in worktree_skill_dirs(Tool::Copilot) {
        assert!(!root.exists(&dir), "政策关闭时不得生成 {dir}");
    }
}

#[test]
fn copilot_follows_the_worktree_policy_like_the_other_targets() {
    // Requirement「worktree 技能的政策条件式生成」对 copilot 一视同仁：打开即生成、
    // 改回关闭后再生即清理。
    let root = TempRoot::new("copilot-worktree");
    init(&root.dir, &[Tool::Copilot], false, "openspec").unwrap();

    set_worktree_policy(&root, true);
    update(&root.dir, false).unwrap();
    for dir in worktree_skill_dirs(Tool::Copilot) {
        assert!(root.exists(&dir), "政策打开时须生成 {dir}");
    }

    set_worktree_policy(&root, false);
    update(&root.dir, false).unwrap();
    for dir in worktree_skill_dirs(Tool::Copilot) {
        assert!(!root.exists(&dir), "政策改回关闭后须清除 {dir}");
    }
}

#[test]
fn copilot_skill_has_neutral_frontmatter_and_slash_references() {
    // Scenario「选取 Copilot 生成正确的技能档」。
    let root = TempRoot::new("copilot-render");
    init(&root.dir, &[Tool::Copilot], false, "openspec").unwrap();

    let propose = root.read(&propose_skill(Tool::Copilot));
    assert_eq!(
        frontmatter_keys(&propose),
        ["name", "description", "license", "compatibility", "metadata"]
    );
    assert!(propose.contains("name: specseal-propose\n"), "{propose}");
    assert!(
        propose.contains("/specseal-apply"),
        "技能引用须写成 /specseal-<name>"
    );
    assert!(
        !propose.contains("$specseal-"),
        "不得出现 Codex 的 $ 叫用语法"
    );
    assert!(
        propose.contains("--agent copilot"),
        "创建变更须记录 agent 为 copilot"
    );

    // fork 与唯读技能在 claude 版才带专用字段与前言；copilot 版一律不带。
    for skill in ["drift", "trace", "discuss", "verify"] {
        let text = root.read(&format!(".github/skills/specseal-{skill}/SKILL.md"));
        for claude_only in [
            "context: fork",
            "agent: Explore",
            "disallowedTools",
            "## Claude fork context",
        ] {
            assert!(
                !text.contains(claude_only),
                "specseal-{skill} 不得含 {claude_only}"
            );
        }
    }
}

/// 各内置工具的技能叫用前缀（规格「内置工具的渲染差异」表的「技能引用写法」栏）。
/// 测试自带一份：拿来比对的期望值不从被测的程序取。
fn invocation_prefix(tool: Tool) -> &'static str {
    match tool {
        Tool::Claude | Tool::Copilot | Tool::Cursor => "/specseal-",
        Tool::Codex => "$specseal-",
        Tool::Pi => "/skill:specseal-",
    }
}

/// 把一个内置工具的技能内文换成另一个工具的：叫用前缀，加上 `{{TOOL}}` 代换值出现的
/// 每个位置——`--agent` 的值、子代理模型的格子路径与写入指令范例。只换这些位置，其他
/// 差异照样失败（例如 `~/.codex/config.toml` 这类写死的路径不能跟着换）。
fn swap_tool(text: &str, from: Tool, to: Tool) -> String {
    let (from_tool, to_tool) = (from.name(), to.name());
    let mut out = text
        .replace(invocation_prefix(from), invocation_prefix(to))
        .replace(&format!("--agent {from_tool}"), &format!("--agent {to_tool}"));
    for prefix in ["subagentModel", "subagent_model"] {
        for station in ["<station>", "review", "verify"] {
            out = out.replace(
                &format!("{prefix}.{station}.{from_tool}"),
                &format!("{prefix}.{station}.{to_tool}"),
            );
        }
    }
    out.replace(
        &format!("subagent-model <station> {from_tool}"),
        &format!("subagent-model <station> {to_tool}"),
    )
}

#[test]
fn copilot_skills_differ_from_codex_only_by_prefix_and_agent_name() {
    // Requirement「Copilot 渲染目标」：除叫用前缀与 {{TOOL}} 代换值以外逐字相同。
    let root = TempRoot::new("copilot-vs-codex");
    init(&root.dir, &[Tool::Codex, Tool::Copilot], false, "openspec").unwrap();

    for dir in expected_dirs(Tool::Codex) {
        let codex = root.read(&format!(".agents/skills/{dir}/SKILL.md"));
        let copilot = root.read(&format!(".github/skills/{dir}/SKILL.md"));
        assert_eq!(copilot, swap_tool(&codex, Tool::Codex, Tool::Copilot), "{dir}");
    }
}

#[test]
fn copilot_writes_no_instruction_file() {
    // Scenario「选取 Copilot 不产生指令档」。
    let root = TempRoot::new("copilot-no-instructions");
    init(&root.dir, &[Tool::Copilot], false, "openspec").unwrap();

    for file in ["AGENTS.md", "CLAUDE.md", ".github/copilot-instructions.md"] {
        assert!(!root.exists(file), "{file} 不得生成");
    }
    let entries: Vec<String> = std::fs::read_dir(root.at(".github"))
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    assert_eq!(entries, ["skills"], ".github/ 下只能有 skills/");
}

#[test]
fn footprint_detection_never_infers_copilot() {
    // Scenario「footprint 侦测不推断 Copilot」：多数 GitHub repo 都有 .github/，
    // 它不代表用户要 Copilot；legacy 回退的 update 也只依 .claude/ 再生。
    let root = TempRoot::new("copilot-footprint");
    root.write(".github/workflows/ci.yml", "on: push\n");
    std::fs::create_dir_all(root.at(".github/skills/my-skill")).unwrap();
    std::fs::create_dir_all(root.at(".claude")).unwrap();

    assert_eq!(detect_footprint_tools(&root.dir), vec![Tool::Claude]);

    root.write(".specseal.yaml", "# Specseal application config\n");
    update(&root.dir, false).expect("legacy update");
    assert!(
        root.exists(&propose_skill(Tool::Claude)),
        "claude 技能照常再生"
    );
    assert!(
        skill_dirs(&root, ".github/skills").is_empty(),
        "不得生成任何 copilot 技能"
    );
    assert_eq!(root.read(".github/workflows/ci.yml"), "on: push\n");
}

#[test]
fn deselecting_copilot_removes_only_specseal_skill_dirs() {
    // Scenario「取消 Copilot 只移除 specseal 技能目录」（built-in tools 权威收敛）。
    let root = TempRoot::new("copilot-deselect");
    init(&root.dir, &[Tool::Claude, Tool::Copilot], false, "openspec").unwrap();
    root.write(
        ".github/skills/my-skill/SKILL.md",
        "---\nname: my-skill\n---\n",
    );
    root.write(".github/workflows/ci.yml", "on: push\n");
    root.write(".github/copilot-instructions.md", "团队自己的指示\n");

    reconcile_builtin_tools(&root.dir, &[Tool::Claude]).expect("reconcile succeeds");

    assert!(
        skill_dirs(&root, ".github/skills").is_empty(),
        "specseal- 目录须全数移除"
    );
    assert_eq!(
        root.read(".github/skills/my-skill/SKILL.md"),
        "---\nname: my-skill\n---\n"
    );
    assert_eq!(root.read(".github/workflows/ci.yml"), "on: push\n");
    assert_eq!(
        root.read(".github/copilot-instructions.md"),
        "团队自己的指示\n"
    );
    assert!(
        root.exists(&propose_skill(Tool::Claude)),
        "claude 技能照常更新"
    );
    assert_eq!(builtin_names(&root), ["claude"]);
}

#[test]
fn deselecting_copilot_drops_the_emptied_skills_dir_but_keeps_github() {
    // 只剩 specseal 技能的 .github/skills/ 变空即移除；.github/ 还有 workflows 就留着。
    let root = TempRoot::new("copilot-deselect-empty");
    init(&root.dir, &[Tool::Claude, Tool::Copilot], false, "openspec").unwrap();
    root.write(".github/workflows/ci.yml", "on: push\n");

    reconcile_builtin_tools(&root.dir, &[Tool::Claude]).expect("reconcile succeeds");

    assert!(
        !root.exists(".github/skills"),
        "变空的 .github/skills/ 须移除"
    );
    assert_eq!(root.read(".github/workflows/ci.yml"), "on: push\n");
}

#[cfg(unix)]
#[test]
fn update_never_prunes_through_a_symlinked_github_skills_dir() {
    // 没选 copilot 的 update 会清 .github/skills；它若是指向 .claude/skills 的
    // symlink，清理不得穿过去删掉 claude 刚写好的技能。
    let root = TempRoot::new("copilot-symlink");
    init(&root.dir, &[Tool::Claude], false, "openspec").unwrap();
    std::fs::create_dir_all(root.at(".github")).unwrap();
    std::os::unix::fs::symlink("../.claude/skills", root.at(".github/skills")).unwrap();

    let outcome = update(&root.dir, false).expect("update succeeds");

    assert!(
        root.exists(&propose_skill(Tool::Claude)),
        "claude 技能不得被删"
    );
    let link = std::fs::symlink_metadata(root.at(".github/skills")).unwrap();
    assert!(link.file_type().is_symlink(), "symlink 本身留着");
    assert!(
        !outcome.pruned.iter().any(|p| p == "copilot"),
        "没有清掉任何东西就不回报 copilot：{:?}",
        outcome.pruned
    );
}

#[test]
fn update_keeps_a_preexisting_empty_github_skills_dir() {
    // 从没选过 copilot：本来就空的 .github/skills/ 不是这次清空的，不得被收掉。
    let root = TempRoot::new("copilot-empty-kept");
    init(&root.dir, &[Tool::Claude], false, "openspec").unwrap();
    std::fs::create_dir_all(root.at(".github/skills")).unwrap();

    update(&root.dir, false).expect("update succeeds");

    assert!(
        root.exists(".github/skills"),
        "原本就空的 .github/skills/ 须保留"
    );
}

#[test]
fn update_prunes_an_orphan_skill_dir_under_github_skills() {
    // Requirement「update 清除孤儿技能目录」：copilot 与 codex 同为非 Claude 子集，
    // 改名留下的旧目录一样被清。
    let root = TempRoot::new("copilot-orphan");
    init(&root.dir, &[Tool::Copilot], false, "openspec").unwrap();
    root.write(".github/skills/specseal-onboard/SKILL.md", "old\n");

    update(&root.dir, false).expect("update succeeds");

    assert!(
        !root.exists(".github/skills/specseal-onboard"),
        "旧目录须被清除"
    );
    assert!(root.exists(".github/skills/specseal-baseline/SKILL.md"));
}

#[test]
fn skill_probe_reports_missing_copilot_skills() {
    // Requirement「技能档过期探测」：逐工具信息的内置名含 copilot，缺失的差异清单
    // 落在 .github/skills/ 底下。
    let root = TempRoot::new("copilot-probe-missing");
    init(&root.dir, &[Tool::Claude, Tool::Copilot], false, "openspec").unwrap();
    std::fs::remove_dir_all(root.at(Tool::Copilot.skills_dir())).unwrap();

    let probe = probe_assets(&root.dir);
    assert_eq!(probe.status, AssetStatus::Missing, "{probe:?}");
    let copilot = probe
        .tools
        .iter()
        .find(|t| t.tool == "copilot")
        .expect("copilot 在列");
    assert!(
        copilot.missing && copilot.workspace_version.is_none(),
        "{copilot:?}"
    );
    assert!(!probe.differing_files.is_empty());
    for file in &probe.differing_files {
        assert!(file.starts_with(".github/skills/specseal-"), "{file}");
        assert!(file.ends_with("/SKILL.md"), "{file}");
    }
}

#[test]
fn skill_probe_reports_stale_copilot_skills() {
    let root = TempRoot::new("copilot-probe-stale");
    init(&root.dir, &[Tool::Copilot], false, "openspec").unwrap();
    set_skill_version(&root, Tool::Copilot, "v0.9.0");

    let probe = probe_assets(&root.dir);
    assert_eq!(probe.status, AssetStatus::Stale, "{probe:?}");
    assert_eq!(probe.tools.len(), 1);
    assert_eq!(probe.tools[0].tool, "copilot");
    assert!(probe.tools[0].stale);
    assert!(probe
        .differing_files
        .contains(&propose_skill(Tool::Copilot)));
}

// --- 内置 pi 与 cursor（change: add-pi-cursor-tools）---
// Spec requirement「Pi 渲染目标」「Cursor 渲染目标」与「worktree 技能的政策条件式生成」
// 的 pi、cursor 分支：技能落在 .pi/skills、.cursor/skills，子集与内容沿用 codex，
// 只有叫用前缀与 agent 名不同。

/// 这次添加的两个内置工具。
const PI_AND_CURSOR: [Tool; 2] = [Tool::Pi, Tool::Cursor];

/// 一个项目根相对目录下的项目名（排序后）。
fn entry_names(root: &TempRoot, rel: &str) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(root.at(rel))
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    names.sort();
    names
}

/// frontmatter 的顶层键（依出现顺序）。
fn frontmatter_keys(skill_file: &str) -> Vec<String> {
    skill_file
        .split("---\n")
        .nth(1)
        .expect("frontmatter block")
        .lines()
        .filter(|l| !l.starts_with(' '))
        .filter_map(|l| l.split(':').next())
        .map(str::to_string)
        .collect()
}

#[test]
fn pi_and_cursor_generate_the_codex_subset_under_their_own_skills_dir() {
    // Scenario「Pi 与 Codex 并存时各写各的目录」「Cursor 与 Codex 生成集合相同」的
    // 集合面：非 Claude 子集，政策关闭时不含两颗 worktree 技能。
    assert_eq!(Tool::Pi.skills_dir(), ".pi/skills");
    assert_eq!(Tool::Cursor.skills_dir(), ".cursor/skills");
    for tool in PI_AND_CURSOR {
        let root = TempRoot::new(&format!("{}-subset", tool.name()));
        init(&root.dir, &[tool], false, "openspec").unwrap();

        let generated = skill_dirs(&root, tool.skills_dir());
        assert_eq!(generated, expected_dirs(Tool::Codex), "{tool:?} 的生成集合须等于 codex 的");
        assert!(!generated.contains(&"specseal-analyze".to_string()), "analyze 只给 claude");
        for dir in worktree_skill_dirs(tool) {
            assert!(!root.exists(&dir), "政策关闭时不得生成 {dir}");
        }
    }
}

#[test]
fn pi_and_cursor_follow_the_worktree_policy_like_the_other_targets() {
    // Requirement「worktree 技能的政策条件式生成」对 pi、cursor 一视同仁。
    for tool in PI_AND_CURSOR {
        let root = TempRoot::new(&format!("{}-worktree", tool.name()));
        init(&root.dir, &[tool], false, "openspec").unwrap();

        set_worktree_policy(&root, true);
        update(&root.dir, false).unwrap();
        for dir in worktree_skill_dirs(tool) {
            assert!(root.exists(&format!("{dir}/SKILL.md")), "政策打开时须生成 {dir}");
        }

        set_worktree_policy(&root, false);
        update(&root.dir, false).unwrap();
        for dir in worktree_skill_dirs(tool) {
            assert!(!root.exists(&dir), "政策改回关闭后须清除 {dir}");
        }
    }
}

#[test]
fn pi_and_cursor_skills_have_neutral_frontmatter_and_their_own_references() {
    // Scenario「选取 Pi 生成正确的技能档」「选取 Cursor 生成正确的技能档」：name 与目录名
    // 相同；pi 的技能档连斜线形式的引用都不得有（`/skill:specseal-` 不含 `/specseal-`）。
    let rows: [(Tool, &str, &[&str]); 2] = [
        (Tool::Pi, "/skill:specseal-apply", &["/specseal-"]),
        (Tool::Cursor, "/specseal-apply", &[]),
    ];
    for (tool, reference, extra_forbidden) in rows {
        let root = TempRoot::new(&format!("{}-render", tool.name()));
        init(&root.dir, &[tool], false, "openspec").unwrap();

        let propose = root.read(&propose_skill(tool));
        assert_eq!(
            frontmatter_keys(&propose),
            ["name", "description", "license", "compatibility", "metadata"],
            "{tool:?}"
        );
        assert!(propose.contains("name: specseal-propose\n"), "{tool:?}: {propose}");
        assert!(propose.contains(reference), "{tool:?}: 技能引用须写成 {reference}");
        assert!(
            propose.contains(&format!("--agent {}", tool.name())),
            "{tool:?}: 创建变更须记录 agent 为 {}",
            tool.name()
        );

        let forbidden = ["$specseal-", "## Claude fork context", "context: fork", "agent: Explore", "disallowedTools"];
        for dir in expected_dirs(tool) {
            let text = root.read(&format!("{}/{dir}/SKILL.md", tool.skills_dir()));
            for needle in forbidden.iter().chain(extra_forbidden) {
                assert!(!text.contains(needle), "{tool:?} {dir} 不得含 {needle}");
            }
        }
    }
}

#[test]
fn pi_and_cursor_skills_differ_from_codex_only_by_prefix_and_tool_name() {
    // Requirement「Pi 渲染目标」「Cursor 渲染目标」：除叫用前缀与 {{TOOL}} 代换值以外，
    // 与同一技能的 codex 内容逐字相同；同时选取时各写各的目录、不合并。
    for tool in PI_AND_CURSOR {
        let root = TempRoot::new(&format!("{}-vs-codex", tool.name()));
        init(&root.dir, &[Tool::Codex, tool], false, "openspec").unwrap();

        assert_eq!(
            skill_dirs(&root, tool.skills_dir()),
            skill_dirs(&root, ".agents/skills"),
            "{tool:?} 与 codex 的目录名集合须相同"
        );
        for dir in expected_dirs(Tool::Codex) {
            let codex = root.read(&format!(".agents/skills/{dir}/SKILL.md"));
            let own = root.read(&format!("{}/{dir}/SKILL.md", tool.skills_dir()));
            assert_eq!(swap_tool(&own, tool, Tool::Codex), codex, "{tool:?} {dir}");
        }
    }
}

#[test]
fn builtin_render_differences_match_the_spec_table() {
    // Example「内置工具的渲染差异」逐列：skills 目录、技能引用写法、--agent 值、
    // Claude 专用 frontmatter、是否含 analyze。
    let rows: [(Tool, &str, &str, &str, bool); 5] = [
        (Tool::Claude, ".claude/skills", "/specseal-apply", "claude", true),
        (Tool::Codex, ".agents/skills", "$specseal-apply", "codex", false),
        (Tool::Copilot, ".github/skills", "/specseal-apply", "copilot", false),
        (Tool::Pi, ".pi/skills", "/skill:specseal-apply", "pi", false),
        (Tool::Cursor, ".cursor/skills", "/specseal-apply", "cursor", false),
    ];
    assert_eq!(Tool::ALL.to_vec(), rows.map(|r| r.0).to_vec(), "内置工具的固定顺序");
    for (tool, dir, reference, agent, claude) in rows {
        let root = TempRoot::new(&format!("render-table-{agent}"));
        init(&root.dir, &[tool], false, "openspec").unwrap();

        assert_eq!(tool.skills_dir(), dir);
        let propose = root.read(&format!("{dir}/specseal-propose/SKILL.md"));
        assert!(propose.contains(reference), "{agent}: 技能引用须写成 {reference}");
        assert!(propose.contains(&format!("--agent {agent}")), "{agent}: --agent 值");
        assert_eq!(root.exists(&format!("{dir}/specseal-analyze")), claude, "{agent}: analyze");
        let drift = root.read(&format!("{dir}/specseal-drift/SKILL.md"));
        assert_eq!(drift.contains("context: fork\nagent: Explore\n"), claude, "{agent}: fork 字段");
        assert_eq!(drift.contains("disallowedTools"), claude, "{agent}: 唯读字段");
    }
}

#[test]
fn pi_and_cursor_write_no_instruction_file_and_nothing_beside_skills() {
    // Requirement「Pi 渲染目标」「Cursor 渲染目标」：不产生指令档，`.pi/`、`.cursor/`
    // 下只有 skills/（没有 .cursor/rules/、.cursor/agents/）。
    for tool in PI_AND_CURSOR {
        let root = TempRoot::new(&format!("{}-no-instructions", tool.name()));
        init(&root.dir, &[tool], false, "openspec").unwrap();

        for file in ["AGENTS.md", "CLAUDE.md"] {
            assert!(!root.exists(file), "{tool:?}: {file} 不得生成");
        }
        let own_dir = tool.skills_dir().trim_end_matches("/skills");
        assert_eq!(entry_names(&root, own_dir), ["skills"], "{own_dir}/ 下只能有 skills/");
        assert_eq!(instructions_path(tool), None, "{tool:?} 没有指令档");
    }
}

#[test]
fn footprint_detection_never_infers_pi_or_cursor() {
    // Scenario「footprint 侦测不推断 Pi」「footprint 侦测不推断 Cursor」：`.pi/`、
    // `.cursor/` 存在不代表用户要这个工具；legacy 回退的 update 只依 .claude/ 再生。
    for (tool, user_file, content) in [
        (Tool::Pi, ".pi/settings.json", "{\"theme\": \"dark\"}\n"),
        (Tool::Cursor, ".cursor/rules/style.mdc", "---\nalwaysApply: true\n---\n"),
    ] {
        let root = TempRoot::new(&format!("{}-footprint", tool.name()));
        root.write(user_file, content);
        // skills 目录本身存在（放着用户自己的技能）也不算 footprint。
        let user_skill = format!("{}/my-skill/SKILL.md", tool.skills_dir());
        root.write(&user_skill, "---\nname: my-skill\n---\n");
        std::fs::create_dir_all(root.at(".claude")).unwrap();

        assert_eq!(detect_footprint_tools(&root.dir), vec![Tool::Claude]);

        root.write(".specseal.yaml", "# Specseal application config\n");
        update(&root.dir, false).expect("legacy update");
        assert!(root.exists(&propose_skill(Tool::Claude)), "claude 技能照常再生");
        assert!(
            skill_dirs(&root, tool.skills_dir()).is_empty(),
            "{} 下不得生成 specseal 技能",
            tool.skills_dir()
        );
        assert_eq!(root.read(user_file), content, "{user_file} 须比特级不变");
        assert_eq!(root.read(&user_skill), "---\nname: my-skill\n---\n", "{user_skill} 须比特级不变");
    }
}

#[test]
fn deselecting_cursor_removes_only_specseal_skill_dirs() {
    // Scenario「取消 Cursor 只移除 specseal 技能目录」（built-in tools 权威收敛）。
    let root = TempRoot::new("cursor-deselect");
    init(&root.dir, &[Tool::Claude, Tool::Cursor], false, "openspec").unwrap();
    root.write(".cursor/skills/my-skill/SKILL.md", "---\nname: my-skill\n---\n");
    root.write(".cursor/rules/style.mdc", "---\nalwaysApply: true\n---\n");

    reconcile_builtin_tools(&root.dir, &[Tool::Claude]).expect("reconcile succeeds");

    assert!(skill_dirs(&root, ".cursor/skills").is_empty(), "specseal- 目录须全数移除");
    assert_eq!(root.read(".cursor/skills/my-skill/SKILL.md"), "---\nname: my-skill\n---\n");
    assert_eq!(root.read(".cursor/rules/style.mdc"), "---\nalwaysApply: true\n---\n");
    assert_eq!(entry_names(&root, ".cursor"), ["rules", "skills"], ".cursor/ 下不得多出别的项目");
    assert!(root.exists(&propose_skill(Tool::Claude)), "claude 技能照常更新");
    assert_eq!(builtin_names(&root), ["claude"]);
}

#[test]
fn deselecting_pi_drops_the_emptied_skills_dir_and_its_parent() {
    // Scenario「取消 Pi 后变空的目录一并移除」：`.pi/` 下只有生成物时整个收掉。
    let root = TempRoot::new("pi-deselect-empty");
    init(&root.dir, &[Tool::Codex, Tool::Pi], false, "openspec").unwrap();
    assert!(root.exists(&propose_skill(Tool::Pi)), "前置：pi 技能已生成");

    reconcile_builtin_tools(&root.dir, &[Tool::Codex]).expect("reconcile succeeds");

    assert!(!root.exists(".pi/skills"), "变空的 .pi/skills/ 须移除");
    assert!(!root.exists(".pi"), "变空的 .pi/ 须移除");
    assert_eq!(skill_dirs(&root, ".agents/skills"), expected_dirs(Tool::Codex), "codex 技能照常更新");
    assert_eq!(builtin_names(&root), ["codex"]);
}

#[test]
fn deselecting_pi_keeps_the_users_own_files_under_pi() {
    // Implementation Contract：取消勾选不动 `.pi/` 下其他内容（pi 的 settings.json）。
    let root = TempRoot::new("pi-deselect-settings");
    init(&root.dir, &[Tool::Codex, Tool::Pi], false, "openspec").unwrap();
    root.write(".pi/settings.json", "{\"theme\": \"dark\"}\n");

    reconcile_builtin_tools(&root.dir, &[Tool::Codex]).expect("reconcile succeeds");

    assert!(!root.exists(".pi/skills"), "变空的 .pi/skills/ 须移除");
    assert_eq!(root.read(".pi/settings.json"), "{\"theme\": \"dark\"}\n");
}

#[test]
fn update_prunes_an_orphan_skill_dir_under_pi_skills() {
    // Requirement「update 清除孤儿技能目录」：pi 与 codex 同为非 Claude 子集。
    let root = TempRoot::new("pi-orphan");
    init(&root.dir, &[Tool::Pi], false, "openspec").unwrap();
    root.write(".pi/skills/specseal-onboard/SKILL.md", "old\n");

    update(&root.dir, false).expect("update succeeds");

    assert!(!root.exists(".pi/skills/specseal-onboard"), "旧目录须被清除");
    assert!(root.exists(".pi/skills/specseal-baseline/SKILL.md"));
}

#[test]
fn skill_probe_reports_missing_pi_skills() {
    // Scenario「Pi 技能目录缺少判缺失」：差异清单只落在 .pi/skills/ 底下。
    let root = TempRoot::new("pi-probe-missing");
    init(&root.dir, &[Tool::Codex, Tool::Pi], false, "openspec").unwrap();
    std::fs::remove_dir_all(root.at(".pi/skills")).unwrap();

    let probe = probe_assets(&root.dir);
    assert_eq!(probe.status, AssetStatus::Missing, "{probe:?}");
    let pi = probe.tools.iter().find(|t| t.tool == "pi").expect("pi 在列");
    assert!(pi.missing && pi.workspace_version.is_none(), "{pi:?}");
    assert!(!probe.differing_files.is_empty());
    for file in &probe.differing_files {
        assert!(file.starts_with(".pi/skills/specseal-"), "{file}");
        assert!(file.ends_with("/SKILL.md"), "{file}");
    }
}

#[cfg(unix)]
#[test]
fn update_never_prunes_through_a_symlinked_cursor_or_pi_skills_dir() {
    // Requirement「built-in tools 权威收敛」：未选取 built-in 的 skills 目录是 symlink 时
    // 不得穿过去清，否则会删掉另一个工具刚写好的技能。这里只锁定「不穿过链接清理」；
    // 已勾选工具共用目录的链接在同步前就被拒（见下方的 shared-dir 测试）。
    for (tool, own_dir, selected) in [
        (Tool::Cursor, ".cursor", Tool::Claude),
        (Tool::Pi, ".pi", Tool::Codex),
    ] {
        let root = TempRoot::new(&format!("{}-symlink", tool.name()));
        init(&root.dir, &[selected], false, "openspec").unwrap();
        std::fs::create_dir_all(root.at(own_dir)).unwrap();
        let target = format!("../{}", selected.skills_dir());
        std::os::unix::fs::symlink(&target, root.at(tool.skills_dir())).unwrap();

        let outcome = update(&root.dir, false).expect("update succeeds");

        assert!(root.exists(&propose_skill(selected)), "{selected:?} 技能不得被删");
        let link = std::fs::symlink_metadata(root.at(tool.skills_dir())).unwrap();
        assert!(link.file_type().is_symlink(), "symlink 本身留着");
        assert!(
            !outcome.pruned.iter().any(|p| p == tool.name()),
            "没有清掉任何东西就不回报 {}：{:?}",
            tool.name(),
            outcome.pruned
        );
    }
}

// --- 经 symlink 共用的 skills 目录（品质关卡第 1 轮；决策「同步前拒绝经 symlink 共用的
// skills 目录」）。Requirement「built-in tools 权威收敛」的四个 symlink 情境。

#[cfg(unix)]
fn link(root: &TempRoot, target: impl AsRef<Path>, at: &str) {
    let path = root.at(at);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::os::unix::fs::symlink(target, path).unwrap();
}

/// 拒绝的消息是一行，且点名两个目录与两个工具。
#[cfg(unix)]
fn assert_shared_dir_refusal(err: anyhow::Error, dirs: [&str; 2], tools: [&str; 2]) {
    let message = err.to_string();
    assert_eq!(message.lines().count(), 1, "一行错误：{message}");
    for needle in dirs.iter().chain(tools.iter()) {
        assert!(message.contains(needle), "消息须含 {needle}：{message}");
    }
}

#[cfg(unix)]
#[test]
fn sync_refuses_a_selected_skills_dir_that_resolves_to_another_selected_tools_dir() {
    // Scenario「已勾选工具的 skills 目录经 symlink 指到另一个工具的目录时拒绝」：
    // --allow-downgrade 也不能越过。
    for (allow_downgrade, tag) in [(false, "plain"), (true, "allow-downgrade")] {
        let root = TempRoot::new(&format!("shared-dir-cursor-{tag}"));
        init(&root.dir, &[Tool::Claude], false, DEFAULT_SPEC_DIR).unwrap();
        link(&root, "../.claude/skills", ".cursor/skills");
        root.write(".specseal.yaml", "tools: [claude, cursor]\n");
        let before = snapshot(&root);

        let err = update(&root.dir, allow_downgrade).expect_err("共用目录必须被拒");

        assert_shared_dir_refusal(err, [".cursor/skills", ".claude/skills"], ["cursor", "claude"]);
        assert_eq!(snapshot(&root), before, "{tag}: 拒绝＝零写入");
    }
}

#[cfg(unix)]
#[test]
fn sync_refuses_a_pi_skills_dir_linked_to_the_codex_dir() {
    // 同一条规则套在 pi 连到 .agents/skills。
    let root = TempRoot::new("shared-dir-pi");
    init(&root.dir, &[Tool::Codex], false, DEFAULT_SPEC_DIR).unwrap();
    link(&root, "../.agents/skills", ".pi/skills");
    root.write(".specseal.yaml", "tools: [codex, pi]\n");
    let before = snapshot(&root);

    let err = update(&root.dir, false).expect_err("共用目录必须被拒");

    assert_shared_dir_refusal(err, [".pi/skills", ".agents/skills"], ["pi", "codex"]);
    assert_eq!(snapshot(&root), before, "拒绝＝零写入");
}

#[cfg(unix)]
#[test]
fn reconcile_refuses_a_link_into_a_deselected_tools_dir() {
    // Scenario「指到未选取工具目录的 symlink 同样被拒」：不会先写入 Cursor 版、再把它当成
    // 未选取的 claude 清掉；.specseal.yaml 也不得先被改写。
    let root = TempRoot::new("shared-dir-deselected");
    init(&root.dir, &[Tool::Claude], false, DEFAULT_SPEC_DIR).unwrap();
    link(&root, "../.claude/skills", ".cursor/skills");
    let before = snapshot(&root);

    let err = reconcile_builtin_tools(&root.dir, &[Tool::Cursor]).expect_err("必须被拒");

    assert_shared_dir_refusal(err, [".cursor/skills", ".claude/skills"], ["cursor", "claude"]);
    assert_eq!(snapshot(&root), before, "拒绝＝零写入");
}

#[cfg(unix)]
#[test]
fn a_link_to_a_folder_outside_the_project_still_syncs() {
    // Scenario「指到其他位置的 symlink 照常同步」：只挡两个工具共用同一个目录。
    let shared = TempRoot::new("shared-dir-outside-target");
    let root = TempRoot::new("shared-dir-outside");
    link(&root, &shared.dir, ".claude");

    init(&root.dir, &[Tool::Claude], false, DEFAULT_SPEC_DIR).expect("init 照常成功");
    update(&root.dir, false).expect("update 照常成功");

    assert!(shared.exists("skills/specseal-propose/SKILL.md"), "技能写进共用文件夹");
}

#[cfg(unix)]
#[test]
fn update_never_prunes_through_a_symlinked_parent_of_a_deselected_skills_dir() {
    // Scenario「取消勾选工具的上层目录是 symlink 时不清理」：.cursor 连到 .claude，
    // .cursor/skills 就是 .claude/skills；清理 cursor 不得删掉刚写好的 Claude 技能。
    let root = TempRoot::new("shared-dir-parent");
    init(&root.dir, &[Tool::Claude], false, DEFAULT_SPEC_DIR).unwrap();
    link(&root, ".claude", ".cursor");

    let outcome = update(&root.dir, false).expect("update succeeds");

    assert_eq!(skill_dirs(&root, ".claude/skills"), expected_dirs(Tool::Claude), "Claude 技能全在");
    let meta = std::fs::symlink_metadata(root.at(".cursor")).unwrap();
    assert!(meta.file_type().is_symlink(), ".cursor symlink 本身保留");
    assert!(!outcome.pruned.iter().any(|p| p == "cursor"), "{:?}", outcome.pruned);
}

#[cfg(unix)]
#[test]
fn sync_refuses_a_link_whose_target_does_not_exist_yet() {
    // 链接目标还不存在（先建好链接再同步，或删掉 .claude/skills 想重新产生）：同步会先建出
    // .claude/skills、链接随即生效，所以解析时要顺着悬空链接走，照样在写入前拒绝。
    let root = TempRoot::new("shared-dir-dangling");
    init(&root.dir, &[Tool::Claude], false, DEFAULT_SPEC_DIR).unwrap();
    std::fs::remove_dir_all(root.at(".claude")).unwrap();
    link(&root, "../.claude/skills", ".cursor/skills");
    root.write(".specseal.yaml", "tools: [claude, cursor]\n");
    let before = snapshot(&root);

    let err = update(&root.dir, false).expect_err("悬空链接也必须被拒");

    assert_shared_dir_refusal(err, [".cursor/skills", ".claude/skills"], ["cursor", "claude"]);
    assert_eq!(snapshot(&root), before, "拒绝＝零写入");
}

#[cfg(unix)]
#[test]
fn reconcile_refuses_a_dangling_link_into_a_deselected_tools_dir_without_writing() {
    // 只勾 cursor、链接指向还不存在的 .claude/skills：.specseal.yaml 也不得先被改写。
    let root = TempRoot::new("shared-dir-dangling-deselected");
    init(&root.dir, &[Tool::Claude], false, DEFAULT_SPEC_DIR).unwrap();
    std::fs::remove_dir_all(root.at(".claude")).unwrap();
    link(&root, "../.claude/skills", ".cursor/skills");
    let before = snapshot(&root);

    let err = reconcile_builtin_tools(&root.dir, &[Tool::Cursor]).expect_err("必须被拒");

    assert_shared_dir_refusal(err, [".cursor/skills", ".claude/skills"], ["cursor", "claude"]);
    assert_eq!(snapshot(&root), before, "拒绝＝零写入");
}

#[cfg(unix)]
#[test]
fn a_loop_of_links_does_not_hang_the_sync() {
    // 链接循环（a→b、b→a）：解析有层数上限，同步不会卡住；两个目录不是同一个工具的目录，
    // 检查放行，写入时才由文件系统回报错误。
    let root = TempRoot::new("shared-dir-loop");
    init(&root.dir, &[Tool::Claude], false, DEFAULT_SPEC_DIR).unwrap();
    link(&root, "b", ".cursor/a");
    link(&root, "a", ".cursor/b");
    link(&root, "a", ".cursor/skills");
    root.write(".specseal.yaml", "tools: [claude, cursor]\n");

    assert!(update(&root.dir, false).is_err(), "写进链接循环必须失败，而不是卡住");
}

// --- 渲染的轴：规格在不在这个 checkout（spec workspace-tools「技能依规格是否在 checkout 渲染」） ---

/// `skills_dir` 下的受管技能档逐份等于以这个轴渲染的内容（worktree 政策关闭的集合）。
fn assert_skills_rendered_as(
    root: &TempRoot,
    target: skills::RenderTarget,
    skills_dir: &str,
    location: SpecLocation,
) {
    // 两个轴渲染出来的内容不同，下面的比对才分得出写进去的是哪一个。
    assert_ne!(
        managed_skills(target, false, DEFAULT_SPEC_DIR, SpecLocation::InCheckout),
        managed_skills(target, false, DEFAULT_SPEC_DIR, SpecLocation::Elsewhere),
        "两个轴的受管集合不该相同"
    );
    for (dir, expected) in managed_skills(target, false, DEFAULT_SPEC_DIR, location) {
        assert_eq!(
            eol_normalized(&root.read(&format!("{skills_dir}/{dir}/SKILL.md"))),
            eol_normalized(&expected),
            "{skills_dir}/{dir}（{location:?}）"
        );
    }
}

const CLAUDE_TARGET: skills::RenderTarget = skills::RenderTarget::Builtin(Tool::Claude);

#[test]
fn init_renders_skills_with_the_spec_in_the_checkout() {
    let root = TempRoot::new("axis-init-local");
    init(&root.dir, &[Tool::Claude], false, DEFAULT_SPEC_DIR).unwrap();
    assert_skills_rendered_as(&root, CLAUDE_TARGET, ".claude/skills", SpecLocation::InCheckout);
}

#[test]
fn init_remote_renders_skills_with_the_spec_not_in_the_checkout() {
    let root = TempRoot::new("axis-init-remote");
    init_remote(&root.dir, &[Tool::Claude], false, REMOTE_URL, None).unwrap();
    assert_skills_rendered_as(&root, CLAUDE_TARGET, ".claude/skills", SpecLocation::Elsewhere);
}

/// `update` 与各同步函数看 `.specseal.yaml` 的 remote 区段，不看规格文件夹在不在磁盘上：
/// 本机项目是「在」；remote 项目留着旧的规格文件夹，仍然是「不在」
/// （Scenario「残留的规格文件夹不影响判断」）。
#[test]
fn update_renders_skills_by_the_remote_section_not_by_the_spec_folder() {
    let local = TempRoot::new("axis-update-local");
    init(&local.dir, &[Tool::Claude], false, DEFAULT_SPEC_DIR).unwrap();
    update(&local.dir, false).unwrap();
    assert_skills_rendered_as(&local, CLAUDE_TARGET, ".claude/skills", SpecLocation::InCheckout);

    let remote = TempRoot::new("axis-update-remote");
    remote.write("specseal/changes/leftover/proposal.md", "## Why\n");
    seed_remote_workspace(&remote, &[Tool::Claude]);
    let custom = custom_target();
    let assert_not_in_checkout = |entry: &str| {
        assert!(remote.exists("specseal/changes/leftover/proposal.md"), "{entry}：残留的文件夹还在");
        assert_skills_rendered_as(&remote, CLAUDE_TARGET, ".claude/skills", SpecLocation::Elsewhere);
        assert_skills_rendered_as(&remote, skills::RenderTarget::Custom(&custom), ".wad/skills", SpecLocation::Elsewhere);
    };
    assert_not_in_checkout("update");
    sync_skills(&remote.dir).unwrap();
    assert_not_in_checkout("sync_skills");
    reconcile_builtin_tools(&remote.dir, &[Tool::Claude]).unwrap();
    assert_not_in_checkout("reconcile_builtin_tools");
}

/// Scenario「探测用相同的基准」：remote 项目刚更新后是现版；之后只有一份技能档变旧时，
/// 被列为不同的就只有那一份——比对基准和 `update` 用同一个轴。
#[test]
fn probing_skills_after_a_remote_update_uses_the_same_base() {
    let root = TempRoot::new("axis-probe-remote");
    seed_remote_workspace(&root, &[Tool::Claude]);

    let probe = probe_assets(&root.dir);
    assert_eq!(probe.status, AssetStatus::Current);
    assert_eq!(probe.differing_files, Vec::<String>::new());

    let aged = ".claude/skills/specseal-commit/SKILL.md";
    root.write(aged, &root.read(aged).replace(ASSET_VERSION, "v0.0.1"));
    let probe = probe_assets(&root.dir);
    assert_eq!(probe.status, AssetStatus::Stale);
    assert_eq!(probe.differing_files, vec![aged.to_string()]);
}

// --- Server 给的技能（spec workspace-tools「remote 项目的技能取自 Server」） ---

/// 一份技能档：frontmatter 带 `version`，本文带 `mark` 以分辨来源。
fn served_skill(name: &str, version: &str, mark: &str) -> String {
    format!("---\nname: specseal-{name}\nmetadata:\n  version: \"{version}\"\n---\n\n{mark}\n")
}

fn served(tool: &str, version: &str, names: &[&str]) -> RenderedTool {
    RenderedTool {
        tool: tool.to_string(),
        skills: names
            .iter()
            .map(|name| RenderedSkill { name: name.to_string(), content: served_skill(name, version, tool) })
            .collect(),
    }
}

/// claude 与自订描述子（`.wad/skills`）的 remote 项目，技能由本机的 `update` 产生。
fn remote_selection(root: &TempRoot) -> ToolSelection {
    let app = crate::config::AppConfig::load(&root.at(".specseal.yaml")).expect("config parses");
    ToolSelection::resolve(&root.dir, &app)
}

#[test]
fn from_rendered_writes_the_given_skills_and_removes_the_other_specseal_folders() {
    let root = TempRoot::new("rendered-install");
    seed_remote_workspace(&root, &[Tool::Claude]);
    root.write(".claude/skills/my-own/SKILL.md", "mine\n");
    assert!(root.exists(".claude/skills/specseal-improve/SKILL.md"), "the local render has improve");

    let rendered = vec![served("claude", "v1.58.0", &["apply", "discuss"]), served("wad-harness", "v1.58.0", &["apply"])];
    let plan = SyncPlan::from_rendered(&root.dir, remote_selection(&root), rendered).unwrap();
    let outcome = plan.apply(&root.dir).unwrap();

    assert_eq!(outcome.updated, ["claude", "wad-harness"]);
    assert_eq!(root.read(".claude/skills/specseal-apply/SKILL.md"), served_skill("apply", "v1.58.0", "claude"));
    assert_eq!(root.read(".claude/skills/specseal-discuss/SKILL.md"), served_skill("discuss", "v1.58.0", "claude"));
    assert_eq!(root.read(".wad/skills/specseal-apply/SKILL.md"), served_skill("apply", "v1.58.0", "wad-harness"));
    assert!(!root.exists(".claude/skills/specseal-improve"), "a skill the Server does not give is removed");
    assert!(!root.exists(".wad/skills/specseal-discuss"), "per tool: the descriptor got apply only");
    assert_eq!(root.read(".claude/skills/my-own/SKILL.md"), "mine\n", "a folder that is not specseal's stays");

    // 写出的文件和本机产生的同形：既有的探测读得出版本。
    let probe = probe_assets(&root.dir);
    let versions: Vec<Option<&str>> = probe.tools.iter().map(|t| t.workspace_version.as_deref()).collect();
    assert_eq!(versions, [Some("v1.58.0"), Some("v1.58.0")]);
}

#[test]
fn from_rendered_replaces_newer_skills_and_names_the_version_it_replaces() {
    let root = TempRoot::new("rendered-older");
    seed_remote_workspace(&root, &[Tool::Claude]);
    let ahead = ".claude/skills/specseal-apply/SKILL.md";
    root.write(ahead, &root.read(ahead).replace(ASSET_VERSION, "v99.0.0"));
    assert!(update(&root.dir, false).is_err(), "the local path refuses to go back");

    let rendered = vec![served("claude", "v1.2.0", &["apply"]), served("wad-harness", "v1.2.0", &["apply"])];
    let plan = SyncPlan::from_rendered(&root.dir, remote_selection(&root), rendered).unwrap();
    assert_eq!(plan.leading_version(ASSET_VERSION).as_deref(), Some("v99.0.0"), "the one file that leads");
    assert!(plan.leading_version("v1.2.0").is_some(), "every file leads the Server's version");
    assert_eq!(plan.leading_version("v99.0.0"), None, "the same version leads nothing");
    plan.apply(&root.dir).unwrap();
    assert_eq!(root.read(ahead), served_skill("apply", "v1.2.0", "claude"));
}

#[test]
fn from_rendered_refuses_a_skill_name_that_is_not_a_plain_name_and_writes_nothing() {
    let root = TempRoot::new("rendered-bad-name");
    seed_remote_workspace(&root, &[Tool::Claude]);
    let before = snapshot(&root);
    for bad in ["", "..", "../../escape", "a/b", "a\\b", "Apply", "apply ", ".hidden", "-apply", "apply-"] {
        let rendered = vec![
            served("claude", "v1.58.0", &["apply", bad]),
            served("wad-harness", "v1.58.0", &["apply"]),
        ];
        let Err(error) = SyncPlan::from_rendered(&root.dir, remote_selection(&root), rendered) else {
            panic!("{bad:?} is no skill name");
        };
        assert!(error.to_string().contains("skill name"), "{bad:?}: {error}");
    }
    assert_eq!(snapshot(&root), before, "nothing was written");
}

/// Sharp edge (audit): a name longer than any skill's would become a path the file
/// system may refuse half-way through the writes; a name given twice would have one
/// text silently replace the other.
#[test]
fn from_rendered_refuses_an_overlong_name_and_a_name_given_twice() {
    let root = TempRoot::new("rendered-odd-names");
    seed_remote_workspace(&root, &[Tool::Claude]);
    let before = snapshot(&root);
    let wad = || served("wad-harness", "v1.58.0", &["apply"]);
    let long = "a".repeat(65);
    let overlong = vec![served("claude", "v1.58.0", &["apply", &long]), wad()];
    let error = SyncPlan::from_rendered(&root.dir, remote_selection(&root), overlong).err().expect("65 characters");
    assert!(error.to_string().contains("skill name"), "{error}");
    let longest = "a".repeat(64);
    assert!(SyncPlan::from_rendered(&root.dir, remote_selection(&root), vec![served("claude", "v1.58.0", &[&longest]), wad()]).is_ok());

    let twice = vec![served("claude", "v1.58.0", &["apply", "discuss", "apply"]), wad()];
    let error = SyncPlan::from_rendered(&root.dir, remote_selection(&root), twice).err().expect("apply twice");
    assert!(error.to_string().contains("apply") && error.to_string().contains("twice"), "{error}");
    assert_eq!(snapshot(&root), before, "nothing was written");
}

#[test]
fn from_rendered_takes_exactly_the_tools_of_the_selection() {
    let root = TempRoot::new("rendered-tools");
    seed_remote_workspace(&root, &[Tool::Claude]);
    let before = snapshot(&root);
    let claude = || served("claude", "v1.58.0", &["apply"]);
    let wad = || served("wad-harness", "v1.58.0", &["apply"]);
    for (rendered, names_it) in [
        (vec![claude()], "wad-harness"),
        (vec![claude(), wad(), served("codex", "v1.58.0", &["apply"])], "codex"),
        (vec![claude(), wad(), claude()], "claude"),
    ] {
        let Err(error) = SyncPlan::from_rendered(&root.dir, remote_selection(&root), rendered) else {
            panic!("the tools must be the selection's ({names_it})");
        };
        assert!(error.to_string().contains(names_it), "{names_it}: {error}");
    }
    assert_eq!(snapshot(&root), before, "nothing was written");
}

#[test]
fn from_rendered_refuses_an_invalid_descriptor_like_the_local_sync() {
    let root = TempRoot::new("rendered-bad-descriptor");
    root.write(".specseal.yaml", "tools:\n  - claude\n  - name: Bad Name\n    skills_dir: .x/skills\nremote:\n  url: https://team.example.test/api/specseal/v1/projects/acme\n");
    let before = snapshot(&root);
    let rendered = vec![served("claude", "v1.58.0", &["apply"])];
    let error = SyncPlan::from_rendered(&root.dir, remote_selection(&root), rendered).err().expect("refused");
    assert!(error.to_string().contains("Bad Name"), "{error}");
    assert_eq!(snapshot(&root), before);
}

#[test]
fn worktree_skills_follow_the_config_text() {
    assert!(!worktree_skills_on(None), "no config is the defaults");
    assert!(!worktree_skills_on(Some("schema: spec-driven\n")));
    assert!(!worktree_skills_on(Some("worktree: false\n")));
    assert!(worktree_skills_on(Some("worktree: true\n")));
    assert!(worktree_skills_on(Some("schema: [unclosed\n")), "a config that cannot be parsed keeps the skills");
}

#[test]
fn a_skill_digest_is_the_sha256_of_the_text_with_lf_line_ends() {
    let digest = skill_digest("a\nb\n");
    // `printf 'a\nb\n' | shasum -a 256`
    assert_eq!(digest, "sha256:911169ddaaf146aff539f58c26c489af3b892dff0fe283c1c264c65ae5aa59a2");
    assert_eq!(skill_digest("a\r\nb\r\n"), digest, "CRLF and LF give one digest");
    assert_ne!(skill_digest("a\nc\n"), digest);
}

// --- 以 Server 的摘要探测（spec desktop-app「指令档过期提示」的 remote 项目） ---

/// What a Server of `version` gives `tool`: the digests of `served_skill` texts.
fn served_digests(tool: &str, version: &str, names: &[&str]) -> ServedSkills {
    ServedSkills {
        tool: tool.to_string(),
        digests: names
            .iter()
            .map(|name| SkillDigest { name: name.to_string(), digest: skill_digest(&served_skill(name, version, tool)) })
            .collect(),
    }
}

/// A remote checkout (claude and the `.wad/skills` descriptor) that holds exactly what
/// a Server of v1.58.0 gives: apply and discuss for claude, apply for the descriptor.
fn checkout_with_served_skills(tag: &str) -> (TempRoot, Vec<ServedSkills>) {
    let root = TempRoot::new(tag);
    seed_remote_workspace(&root, &[Tool::Claude]);
    let rendered = vec![served("claude", "v1.58.0", &["apply", "discuss"]), served("wad-harness", "v1.58.0", &["apply"])];
    SyncPlan::from_rendered(&root.dir, remote_selection(&root), rendered).unwrap().apply(&root.dir).unwrap();
    let digests =
        vec![served_digests("claude", "v1.58.0", &["apply", "discuss"]), served_digests("wad-harness", "v1.58.0", &["apply"])];
    (root, digests)
}

#[test]
fn a_checkout_that_holds_what_the_server_gives_is_current() {
    let (root, served) = checkout_with_served_skills("served-current");
    let before = snapshot(&root);
    let probe = probe_served_skills(&root.dir, "v1.58.0", &served);
    assert_eq!(probe.status, AssetStatus::Current);
    assert_eq!(probe.differing_files, Vec::<String>::new());
    assert_eq!(probe.current_version, ASSET_VERSION, "the app's own version");
    let tools: Vec<(&str, Option<&str>, bool)> =
        probe.tools.iter().map(|t| (t.tool.as_str(), t.workspace_version.as_deref(), t.missing)).collect();
    assert_eq!(tools, [("claude", Some("v1.58.0"), false), ("wad-harness", Some("v1.58.0"), false)]);
    assert_eq!(snapshot(&root), before, "a probe writes nothing");
}

#[test]
fn line_ends_alone_do_not_make_a_served_skill_differ() {
    let (root, served) = checkout_with_served_skills("served-crlf");
    let file = ".claude/skills/specseal-apply/SKILL.md";
    root.write(file, &root.read(file).replace('\n', "\r\n"));
    assert_eq!(probe_served_skills(&root.dir, "v1.58.0", &served).status, AssetStatus::Current);
}

#[test]
fn a_changed_a_missing_and_an_extra_skill_each_make_the_checkout_stale() {
    let (root, served) = checkout_with_served_skills("served-stale");
    let changed = ".claude/skills/specseal-apply/SKILL.md";
    root.write(changed, &format!("{}edited by hand\n", root.read(changed)));
    let probe = probe_served_skills(&root.dir, "v1.58.0", &served);
    let stale: Vec<(&str, bool)> = probe.tools.iter().map(|t| (t.tool.as_str(), t.stale)).collect();
    assert_eq!(stale, [("claude", true), ("wad-harness", false)], "the tool whose file differs");
    assert_eq!((probe.status, probe.differing_files), (AssetStatus::Stale, vec![changed.to_string()]));

    let (root, served) = checkout_with_served_skills("served-missing-one");
    std::fs::remove_dir_all(root.at(".claude/skills/specseal-discuss")).unwrap();
    let probe = probe_served_skills(&root.dir, "v1.58.0", &served);
    assert_eq!(
        (probe.status, probe.differing_files),
        (AssetStatus::Stale, vec![".claude/skills/specseal-discuss/SKILL.md".to_string()])
    );

    let (root, served) = checkout_with_served_skills("served-extra");
    root.write(".wad/skills/specseal-improve/SKILL.md", &served_skill("improve", "v1.58.0", "wad-harness"));
    root.write(".wad/skills/my-own/SKILL.md", "mine\n");
    let probe = probe_served_skills(&root.dir, "v1.58.0", &served);
    assert_eq!(
        (probe.status, probe.differing_files),
        (AssetStatus::Stale, vec![".wad/skills/specseal-improve/SKILL.md".to_string()]),
        "a folder that is not specseal's is not an extra skill"
    );
}

#[test]
fn a_tool_without_any_skill_file_makes_the_checkout_missing() {
    let (root, served) = checkout_with_served_skills("served-missing");
    std::fs::remove_dir_all(root.at(".wad/skills")).unwrap();
    let probe = probe_served_skills(&root.dir, "v1.58.0", &served);
    assert_eq!(probe.status, AssetStatus::Missing);
    assert_eq!(probe.differing_files, [".wad/skills/specseal-apply/SKILL.md"], "the files an install would create");
    let wad = probe.tools.iter().find(|t| t.tool == "wad-harness").unwrap();
    assert!(wad.missing && wad.workspace_version.is_none());
    assert!(!probe.tools.iter().find(|t| t.tool == "claude").unwrap().missing);
}

#[test]
fn a_served_answer_that_does_not_fit_the_checkout_cannot_be_judged() {
    let (root, served) = checkout_with_served_skills("served-unknown");
    // 少一个工具、多一个工具、不是技能名称的名称：都无法判定，不是「现版」。
    let without_descriptor = vec![served[0].clone()];
    let with_another = [served.clone(), vec![served_digests("codex", "v1.58.0", &["apply"])]].concat();
    let bad_name = vec![
        ServedSkills {
            tool: "claude".into(),
            digests: vec![SkillDigest { name: "../escape".into(), digest: "sha256:00".into() }],
        },
        served[1].clone(),
    ];
    for (case, answer) in [("a tool is absent", without_descriptor), ("a tool was not asked for", with_another), ("a bad name", bad_name)] {
        let probe = probe_served_skills(&root.dir, "v1.58.0", &answer);
        assert_eq!(probe.status, AssetStatus::Unknown, "{case}");
        assert!(probe.tools.is_empty() && probe.differing_files.is_empty(), "{case}");
    }
}

#[test]
fn a_checkout_without_a_tools_list_is_not_probed_against_the_server() {
    let root = TempRoot::new("served-no-list");
    root.write(".specseal.yaml", &format!("remote:\n  url: {REMOTE_URL}\n"));
    std::fs::create_dir_all(root.at(".claude")).unwrap();
    let probe = probe_served_skills(&root.dir, "v1.58.0", &[served_digests("claude", "v1.58.0", &["apply"])]);
    assert_eq!(probe.status, AssetStatus::Current, "the same rule as the local probe");
    assert!(probe.tools.is_empty());
}

// --- Server 一支技能都不给的工具不动（design D9） ---

/// The files under one skills directory, with their bytes.
fn files_under(root: &TempRoot, skills_dir: &str) -> Vec<(String, Vec<u8>)> {
    let prefix = format!("{skills_dir}/");
    snapshot(root).into_iter().filter(|(path, _)| path.starts_with(&prefix)).collect()
}

#[test]
fn from_rendered_leaves_a_tool_the_server_gives_no_skill_alone() {
    let root = TempRoot::new("rendered-unserved");
    seed_remote_workspace(&root, &[Tool::Claude]);
    let wad_before = files_under(&root, ".wad/skills");
    assert!(wad_before.iter().any(|(path, _)| path.ends_with("specseal-improve/SKILL.md")), "the descriptor has skills");

    let rendered = vec![served("claude", "v1.58.0", &["apply"]), served("wad-harness", "v1.58.0", &[])];
    let plan = SyncPlan::from_rendered(&root.dir, remote_selection(&root), rendered).unwrap();
    let outcome = plan.apply(&root.dir).unwrap();

    assert_eq!(outcome.updated, ["claude"], "the tool without skills is not reported as updated");
    assert_eq!(outcome.unserved, ["wad-harness"]);
    assert_eq!(files_under(&root, ".wad/skills"), wad_before, "nothing written, nothing removed");
    assert_eq!(root.read(".claude/skills/specseal-apply/SKILL.md"), served_skill("apply", "v1.58.0", "claude"));
    assert!(!root.exists(".claude/skills/specseal-improve"), "the other tool is installed and cleaned as before");
}

#[test]
fn from_rendered_writes_nothing_when_the_server_gives_no_tool_a_skill() {
    let root = TempRoot::new("rendered-all-unserved");
    seed_remote_workspace(&root, &[Tool::Claude]);
    let before = snapshot(&root);

    let rendered = vec![served("claude", "v1.58.0", &[]), served("wad-harness", "v1.58.0", &[])];
    let plan = SyncPlan::from_rendered(&root.dir, remote_selection(&root), rendered).unwrap();
    assert_eq!(plan.leading_version("v0.0.1"), None, "nothing would be replaced");
    let outcome = plan.apply(&root.dir).unwrap();

    assert_eq!(outcome.updated, Vec::<String>::new());
    assert_eq!(outcome.unserved, ["claude", "wad-harness"]);
    assert_eq!(snapshot(&root), before, "no file changed");
}

#[test]
fn a_local_sync_reports_no_unserved_tool() {
    let root = TempRoot::new("local-unserved");
    init(&root.dir, &[Tool::Claude], false, DEFAULT_SPEC_DIR).unwrap();
    assert_eq!(update(&root.dir, false).unwrap().unserved, Vec::<String>::new());
}

#[test]
fn a_tool_the_server_gives_no_skill_is_not_compared() {
    let (root, served) = checkout_with_served_skills("served-unserved");
    // The descriptor: the Server gives it nothing, and the checkout has skills of it.
    let answer = vec![served[0].clone(), served_digests("wad-harness", "v1.58.0", &[])];
    let probe = probe_served_skills(&root.dir, "v1.58.0", &answer);
    assert_eq!(probe.status, AssetStatus::Current, "its files are not extra");
    assert_eq!(probe.differing_files, Vec::<String>::new());
    let wad = probe.tools.iter().find(|t| t.tool == "wad-harness").expect("the tool is listed");
    assert!(!wad.missing && !wad.stale);

    // No skill file of it at all: not missing either.
    std::fs::remove_dir_all(root.at(".wad/skills")).unwrap();
    let probe = probe_served_skills(&root.dir, "v1.58.0", &answer);
    assert_eq!(probe.status, AssetStatus::Current);
    assert!(!probe.tools.iter().find(|t| t.tool == "wad-harness").unwrap().missing);

    // The other tool is still compared.
    let changed = ".claude/skills/specseal-apply/SKILL.md";
    root.write(changed, "edited\n");
    let probe = probe_served_skills(&root.dir, "v1.58.0", &answer);
    assert_eq!((probe.status, probe.differing_files), (AssetStatus::Stale, vec![changed.to_string()]));
}

#[test]
fn a_checkout_is_current_when_the_server_gives_no_tool_a_skill() {
    let (root, _) = checkout_with_served_skills("served-all-unserved");
    let answer = vec![served_digests("claude", "v1.58.0", &[]), served_digests("wad-harness", "v1.58.0", &[])];
    let probe = probe_served_skills(&root.dir, "v1.58.0", &answer);
    assert_eq!(probe.status, AssetStatus::Current);
    assert_eq!(probe.differing_files, Vec::<String>::new());
}

/// 两个工具共用同一个技能文件夹时，Server 对其中一个回空的清单也不能让检查看不到它：
/// 另一个工具的清理会删掉共用文件夹里的技能（design D9 要避免的静默删除）。
#[cfg(unix)]
#[test]
fn from_rendered_refuses_a_shared_skills_directory_also_when_one_of_its_tools_gets_no_skill() {
    let root = TempRoot::new("rendered-shared-unserved");
    seed_remote_workspace(&root, &[Tool::Claude]);
    std::fs::remove_dir_all(root.at(".wad/skills")).unwrap();
    std::os::unix::fs::symlink("../.claude/skills", root.at(".wad/skills")).unwrap();
    let before = snapshot(&root);

    let rendered = vec![served("claude", "v1.58.0", &["apply"]), served("wad-harness", "v1.58.0", &[])];
    let error = SyncPlan::from_rendered(&root.dir, remote_selection(&root), rendered).err().expect("a shared directory");
    assert!(error.to_string().contains("resolves to the same directory"), "{error}");
    assert_eq!(snapshot(&root), before, "nothing was written or removed");
}
