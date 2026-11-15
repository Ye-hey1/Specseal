//! Project setup verbs: init and update.
//!
//! ModeFree: both write the local workspace scaffolding. `init --store remote`
//! still writes locally — it records the connection rather than consuming it.

use anyhow::{bail, Result};
use clap::Args;
use specseal_core as core;
use std::io::{BufRead, IsTerminal, Write};
use std::path::PathBuf;

use crate::color;
use crate::remote_base::{connect, validate_or_defer};
use core::init::{ToolSelection, ASSET_VERSION};
use specseal_protocol::skills::SkillsRequest;
use specseal_remote::skills as remote_skills;

#[derive(Args)]
pub(crate) struct InitArgs {
    /// Project path (defaults to current directory)
    path: Option<String>,
    /// AI tools to generate files for (e.g., claude, codex, copilot, pi, cursor)
    #[arg(long)]
    tools: Option<String>,
    /// Overwrite existing files
    #[arg(long)]
    force: bool,
    /// Custom openspec directory path (default: openspec)
    #[arg(long)]
    dir: Option<String>,
    /// Store backend: fs (default) or remote
    #[arg(long, default_value = "fs")]
    store: String,
    /// Remote store connection URL (required with --store remote)
    #[arg(long)]
    url: Option<String>,
    /// This repo's registered name in the remote project
    #[arg(long)]
    repo: Option<String>,
}
#[derive(Args)]
pub(crate) struct UpdateArgs {
    /// Project path (defaults to current directory)
    path: Option<PathBuf>,
    /// Overwrite existing files
    #[arg(long)]
    force: bool,
    /// Rewrite managed skill files even when the workspace is newer than this engine
    #[arg(long)]
    allow_downgrade: bool,
}
pub(crate) fn cmd_init(a: InitArgs) -> Result<()> {
    // The success line echoes the PATH argument verbatim (`init .` prints ".\openspec");
    // the absolute path is only used internally.
    let display_base = match a.path.as_deref() {
        Some(p) => p.to_string(),
        None => std::env::current_dir()?.display().to_string(),
    };
    let root = match a.path.as_deref() {
        Some(p) => {
            let pb = PathBuf::from(p);
            if pb.is_absolute() { pb } else { std::env::current_dir()?.join(pb) }
        }
        None => std::env::current_dir()?,
    };
    match a.store.as_str() {
        "fs" | "remote" => {}
        other => bail!("Unknown store '{other}'. Use 'fs' or 'remote'."),
    }
    // Tools are resolved BEFORE the fs/remote split, so both paths start from the same
    // validated non-empty selection and no store writes anything until it is settled.
    let stdin = std::io::stdin();
    let interactive = stdin.is_terminal();
    let tools = resolve_init_tools(
        a.tools.as_deref(),
        interactive,
        &mut stdin.lock(),
        &mut std::io::stderr(),
    )?;
    if a.store == "remote" {
        return cmd_init_remote(&a, &root, &display_base, &tools);
    }
    let spec_dir = a.dir.clone().unwrap_or_else(|| core::workspace::DEFAULT_SPEC_DIR.to_string());
    let outcome = core::init::init(&root, &tools, a.force, &spec_dir)?;
    if let Some(report) = &outcome.imported {
        println!("{} Imported the OpenSpec project: {}", color::green("✓"), moved_summary(report));
    }
    // A legacy project's --force re-init stays in openspec/: name the folder init used.
    let folder = outcome.spec_dir_abs.strip_prefix(&root).unwrap_or(&outcome.spec_dir_abs);
    println!(
        "{} Initialized at {display_base}{}{}",
        color::green("✓"),
        std::path::MAIN_SEPARATOR,
        folder.display()
    );
    let names: Vec<&str> = tools.iter().map(|t| t.name()).collect();
    println!("Generated files for: {}", names.join(", "));
    if outcome.imported.is_some() {
        println!("! Commit the import: specseal/ (added), openspec/ (deleted), .specseal.yaml, .gitignore and the generated skill files");
        println!("! The OpenSpec CLI no longer sees this project — the move is one-way");
        println!("! OpenSpec's own skills and command files were not moved or deleted — remove them yourself if you no longer use OpenSpec");
    }
    Ok(())
}
/// The single line every missing/empty selection ends on — it names the flag and every
/// valid tool, so a failed non-interactive run is self-correcting.
const TOOLS_HINT: &str = "no AI tool selected — pass --tools with one or more of claude, \
codex, copilot, pi, cursor (comma-separated, e.g. --tools claude,cursor)";
/// Resolve init's built-in tool selection. An explicit `--tools` is validated and used
/// as-is (no prompt). Without the flag an interactive terminal is asked question by
/// question — prompts go to `out` (stderr in production) so stdout stays the machine
/// surface; a non-interactive terminal fails here, before any core write, and its
/// redirected stdin is never read as an answer.
fn resolve_init_tools(
    spec: Option<&str>,
    interactive: bool,
    input: &mut impl BufRead,
    out: &mut impl Write,
) -> Result<Vec<core::skills::Tool>> {
    match spec {
        Some(spec) => {
            let tools = core::init::parse_tools(spec)?;
            if tools.is_empty() {
                bail!("{TOOLS_HINT}");
            }
            Ok(tools)
        }
        None if interactive => prompt_for_tools(input, out),
        None => bail!("{TOOLS_HINT}"),
    }
}
/// Ask for Claude, Codex, Copilot, Pi and Cursor in turn, repeating the round until at
/// least one is picked — an empty selection is not an answer. Plain text only: nothing here is
/// styled, so `--no-color` changes nothing about the prompts.
fn prompt_for_tools(
    input: &mut impl BufRead,
    out: &mut impl Write,
) -> Result<Vec<core::skills::Tool>> {
    use core::skills::Tool;
    loop {
        let mut picked = Vec::new();
        for (tool, label) in [
            (Tool::Claude, "Claude"),
            (Tool::Codex, "Codex"),
            (Tool::Copilot, "Copilot"),
            (Tool::Pi, "Pi"),
            (Tool::Cursor, "Cursor"),
        ] {
            if ask_yes_no(input, out, label)? {
                picked.push(tool);
            }
        }
        if !picked.is_empty() {
            return Ok(picked);
        }
        writeln!(
            out,
            "Pick at least one tool: claude, codex, copilot, pi, cursor, or any combination."
        )?;
    }
}
/// One yes/no question. Unrecognized input re-asks the same question; EOF is a loud
/// single-line error rather than an endless loop.
fn ask_yes_no(input: &mut impl BufRead, out: &mut impl Write, label: &str) -> Result<bool> {
    loop {
        write!(out, "Generate Specseal files for {label}? (y/n): ")?;
        out.flush()?;
        let mut line = String::new();
        if input.read_line(&mut line)? == 0 {
            bail!("{TOOLS_HINT}");
        }
        match line.trim().to_ascii_lowercase().as_str() {
            "y" | "yes" => return Ok(true),
            "n" | "no" => return Ok(false),
            _ => writeln!(out, "Please answer y or n.")?,
        }
    }
}
pub(crate) fn cmd_update(a: UpdateArgs) -> Result<()> {
    let root = a
        .path
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let root = if root.is_absolute() {
        root
    } else {
        std::env::current_dir()?.join(root)
    };
    if !core::workspace::is_project_root(&root) {
        bail!("Not initialized. Run 'specseal init' to initialize.");
    }
    let _ = a.force;
    // 降级守门在引擎的 update 本体（唯一实作落点）；--allow-downgrade 是唯一越过。
    // remote 项目的技能跟着 Server：Server 有给就不经这道守门。
    let local = || core::init::update(&root, a.allow_downgrade);
    let (outcome, source) = match skills_from_server(&root)? {
        FromServer::NotRemote => (local()?, None),
        FromServer::NotGiven(reason) => {
            eprintln!("specseal: skills generated from this CLI's templates — {reason}");
            (local()?, Some(format!("local ({ASSET_VERSION})")))
        }
        FromServer::Installed(remote_skills::Installed { outcome, version, replaced }) => {
            if let Some(had) = replaced {
                println!("! Skills replaced with the server's version {version} (this checkout had {had})");
            }
            (outcome, Some(format!("server ({version})")))
        }
    };
    print_migration(&outcome.migration, &outcome.migrated);
    for note in &outcome.notes {
        println!("! {note}");
    }
    // 弃用提示走 stderr：不是错误、不影响 exit code，也不该混进 stdout 的机器面。
    for note in &outcome.deprecations {
        eprintln!("! {note}");
    }
    let nothing_done = outcome.updated.is_empty() && outcome.pruned.is_empty() && outcome.stripped.is_empty();
    if nothing_done && outcome.unserved.is_empty() {
        println!("! No AI tool configurations found. Use 'specseal init --tools' to set up.");
    } else {
        if !outcome.updated.is_empty() {
            println!("{} Updated skill files for: {}", color::green("✓"), outcome.updated.join(", "));
        }
        if !outcome.pruned.is_empty() {
            println!(
                "! Pruned generated files for deselected tool: {}",
                outcome.pruned.join(", ")
            );
        }
    }
    // Server 一支技能都不给的工具：没有写入也没有清理，要讲明是哪些。
    if !outcome.unserved.is_empty() {
        println!(
            "! The server gives no skills for: {} — their skill files were left as they are",
            outcome.unserved.join(", ")
        );
    }
    if let Some(source) = source {
        println!("  Skills source: {source}");
    }
    // 遗留剥除的摘要（design D2）：旧版引擎注入的区块被移除时明说改了哪些文件，
    // 用户才知道 diff 里多出的变动从何而来。
    if !outcome.stripped.is_empty() {
        println!(
            "! Stripped legacy Specseal blocks from: {}",
            outcome.stripped.join(", ")
        );
    }
    Ok(())
}
/// What asking the Server for a project's skills came to.
enum FromServer {
    /// A local project, or a remote one with no tool to ask for: no Server is asked.
    NotRemote,
    /// The Server gives no skills this run, for this reason (one line): it declares
    /// none, or the handshake did not succeed. The local templates stand in.
    NotGiven(String),
    /// The Server's skills are in the checkout.
    Installed(remote_skills::Installed),
}

/// Take a remote project's skills from its Server (spec workspace-tools「remote 项目的
/// 技能取自 Server」). Once the handshake declares skills there is no way back to the
/// local templates: a request that fails then is an error, and nothing is written —
/// the Server said it has the skills, and other text in their place could tell the
/// agent to use verbs this Server does not have.
fn skills_from_server(root: &std::path::Path) -> Result<FromServer> {
    let app = core::config::AppConfig::load(&root.join(".specseal.yaml"))?;
    if app.remote.is_none() {
        return Ok(FromServer::NotRemote);
    }
    let selection = ToolSelection::resolve(root, &app);
    // 坏描述子＝零写入、零请求：和本机的同步同一条规则。
    if let Some(message) = &selection.descriptor_error {
        bail!("{message}");
    }
    let targets = remote_skills::targets_of(&selection);
    if targets.is_empty() {
        return Ok(FromServer::NotRemote);
    }
    let Some(ws) = core::workspace::Workspace::discover(root)? else {
        return Ok(FromServer::NotRemote);
    };
    let conn = match specseal_host::context::resolve_store_mode(&ws) {
        Ok(core::workspace::ModeResolution { mode: core::workspace::StoreMode::Remote(conn), .. }) => conn,
        Ok(_) => return Ok(FromServer::NotRemote),
        Err(e) => return Ok(FromServer::NotGiven(e.to_string())),
    };
    let connected = match connect(&conn) {
        Ok(connected) => connected,
        Err(line) => return Ok(FromServer::NotGiven(line)),
    };
    if connected.binding.capabilities.skills.is_none() {
        return Ok(FromServer::NotGiven("this server does not provide skills".to_string()));
    }

    let refused = |e: &dyn std::fmt::Display| anyhow::anyhow!("could not get the skills from the server: {e}");
    let request = SkillsRequest { targets, contents: true };
    let response = connected.client.skills(&request).map_err(|e| refused(&e))?;
    let installed = remote_skills::install(root, selection, response).map_err(|e| refused(&e))?;
    Ok(FromServer::Installed(installed))
}

/// The spec directory migration's lines (spec-dir-migration D5): what moved and
/// what to do next, or why it waits.
fn print_migration(plan: &core::migrate::MigrationPlan, report: &core::migrate::MigrationReport) {
    use core::migrate::MigrationPlan;
    match plan {
        MigrationPlan::Nothing => {}
        MigrationPlan::MoveFolder => {
            println!("{} Migrated the spec folder: {}", color::green("✓"), moved_summary(report));
            println!("! Commit the move: specseal/ (added) and openspec/ (deleted)");
            println!("! Teammates must upgrade specseal before pulling that commit — older versions see an empty project");
            println!("! Update your own scripts, CI settings and .gitignore entries that still name openspec/");
        }
        MigrationPlan::RenameLeftovers => {
            println!(
                "{} Renamed {} change data file(s) in specseal/ from .openspec.yaml to .meta.yaml — commit them",
                color::green("✓"),
                report.renamed
            );
        }
        MigrationPlan::Deferred(reason) => {
            println!("! Spec folder migration skipped: {reason}");
        }
    }
}

/// The folder move's result, shared by `update`'s migration and `init`'s import.
fn moved_summary(report: &core::migrate::MigrationReport) -> String {
    format!(
        "moved openspec/ to specseal/ and renamed {} change data file(s) from .openspec.yaml to .meta.yaml",
        report.renamed
    )
}

#[cfg(test)]
mod init_tools_tests {
    //! `init` 的工具解析入口（spec「init 内置 Agent 工具选择」、design「CLI 交互解析
    //! 停留在 specseal-cli」）。交互 prompt 需要真实终端才会在集成测试里触发，因此
    //! 单选／双选／全否重试在此以注入的行读写 helper 覆盖。
    use super::*;
    use specseal_core::skills::Tool;
    use std::io::{BufRead, Cursor};

    /// 任何读取都 panic 的 stdin 替身——钉死「不把 redirected／piped stdin 当作答案」。
    struct NeverRead;

    impl std::io::Read for NeverRead {
        fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
            panic!("stdin must not be read")
        }
    }

    impl BufRead for NeverRead {
        fn fill_buf(&mut self) -> std::io::Result<&[u8]> {
            panic!("stdin must not be read")
        }
        fn consume(&mut self, _: usize) {
            panic!("stdin must not be read")
        }
    }

    fn with_answers(
        spec: Option<&str>,
        interactive: bool,
        answers: &str,
    ) -> (Result<Vec<Tool>>, String) {
        let mut input = Cursor::new(answers.as_bytes().to_vec());
        let mut out: Vec<u8> = Vec::new();
        let got = resolve_init_tools(spec, interactive, &mut input, &mut out);
        (got, String::from_utf8(out).expect("prompts are utf-8"))
    }

    fn without_stdin(spec: Option<&str>, interactive: bool) -> (Result<Vec<Tool>>, String) {
        let mut out: Vec<u8> = Vec::new();
        let got = resolve_init_tools(spec, interactive, &mut NeverRead, &mut out);
        (got, String::from_utf8(out).expect("prompts are utf-8"))
    }

    /// 缺选集的单行消息：`pi` 是 `copilot` 的子字符串，逐 token 比对测不到漏列，故比全文。
    const FIVE_TOOLS_HINT: &str = "no AI tool selected — pass --tools with one or more of claude, codex, copilot, pi, cursor (comma-separated, e.g. --tools claude,cursor)";

    fn single_line_error(got: Result<Vec<Tool>>) -> String {
        let message = got.expect_err("must fail").to_string();
        assert_eq!(message.lines().count(), 1, "must be a single line: {message}");
        message
    }

    #[test]
    fn explicit_tools_are_used_without_prompting() {
        let (got, prompts) = without_stdin(Some("claude,codex"), true);
        assert_eq!(got.expect("valid selection"), vec![Tool::Claude, Tool::Codex]);
        assert!(prompts.is_empty(), "显式 --tools 不得询问: {prompts}");
    }

    #[test]
    fn explicit_duplicates_collapse_to_one_entry() {
        let (got, _) = without_stdin(Some("codex, codex"), false);
        assert_eq!(got.expect("valid selection"), vec![Tool::Codex]);
    }

    #[test]
    fn explicit_empty_selection_is_rejected_naming_the_flag_and_values() {
        let (got, _) = without_stdin(Some("  ,  "), true);
        assert_eq!(single_line_error(got), FIVE_TOOLS_HINT);
    }

    #[test]
    fn explicit_unknown_tool_names_the_offender() {
        let (got, _) = without_stdin(Some("claude,vscode"), true);
        assert!(single_line_error(got).contains("vscode"));
    }

    #[test]
    fn explicit_tools_accept_copilot_in_any_case_and_combination() {
        // Example「--tools 值的解析」的接受列。
        let cases: [(&str, &[Tool]); 5] = [
            ("copilot", &[Tool::Copilot]),
            ("Copilot", &[Tool::Copilot]),
            ("claude,copilot", &[Tool::Claude, Tool::Copilot]),
            ("copilot,copilot", &[Tool::Copilot]),
            (
                "claude,codex,copilot",
                &[Tool::Claude, Tool::Codex, Tool::Copilot],
            ),
        ];
        for (spec, want) in cases {
            let (got, prompts) = without_stdin(Some(spec), true);
            assert_eq!(got.expect(spec), want, "--tools {spec}");
            assert!(prompts.is_empty(), "显式 --tools 不得询问: {prompts}");
        }
    }

    #[test]
    fn explicit_tools_accept_pi_and_cursor_in_any_case_and_combination() {
        // Example「--tools 值的解析」的 pi、cursor 接受列，加上五个工具全选。
        let cases: [(&str, &[Tool]); 7] = [
            ("pi", &[Tool::Pi]),
            ("Pi", &[Tool::Pi]),
            ("Cursor", &[Tool::Cursor]),
            ("CURSOR", &[Tool::Cursor]),
            ("cursor,cursor", &[Tool::Cursor]),
            ("codex,pi", &[Tool::Codex, Tool::Pi]),
            (
                "claude,codex,copilot,pi,cursor",
                &[Tool::Claude, Tool::Codex, Tool::Copilot, Tool::Pi, Tool::Cursor],
            ),
        ];
        for (spec, want) in cases {
            let (got, prompts) = without_stdin(Some(spec), true);
            assert_eq!(got.expect(spec), want, "--tools {spec}");
            assert!(prompts.is_empty(), "显式 --tools 不得询问: {prompts}");
        }
    }

    #[test]
    fn explicit_unknown_tool_lists_the_supported_set() {
        // Example「--tools 值的解析」的拒绝列：gh skill 的 agent id、Cursor CLI 的程序名
        // 都不是别名。输入本身就含工具名：要比对完整的支持清单，单看 token 测不到漏列。
        for unknown in ["github-copilot", "cursor-agent", "pi-coding-agent"] {
            let (got, _) = without_stdin(Some(unknown), true);
            assert_eq!(
                single_line_error(got),
                format!("unknown tool: {unknown} (supported: claude, codex, copilot, pi, cursor)")
            );
        }
    }

    #[test]
    fn non_interactive_without_tools_fails_without_reading_stdin() {
        let (got, prompts) = without_stdin(None, false);
        assert_eq!(single_line_error(got), FIVE_TOOLS_HINT);
        assert!(prompts.is_empty(), "非交互终端不得询问: {prompts}");
    }

    #[test]
    fn interactive_yes_yes_selects_both() {
        // Scenario「交互终端选择 Claude 与 Codex」：五题依 Claude、Codex、Copilot、Pi、
        // Cursor 顺序问。
        let (got, prompts) = with_answers(None, true, "y\ny\nn\nn\nn\n");
        assert_eq!(got.expect("selection"), vec![Tool::Claude, Tool::Codex]);
        let questions: Vec<&str> = prompts.split("Generate Specseal files for ").skip(1).collect();
        assert_eq!(
            questions,
            ["Claude", "Codex", "Copilot", "Pi", "Cursor"].map(|label| format!("{label}? (y/n): ")),
            "{prompts}"
        );
    }

    #[test]
    fn interactive_single_selections_follow_the_question_order() {
        let cases: [(&str, Tool); 5] = [
            ("y\nn\nn\nn\nn\n", Tool::Claude),
            ("n\ny\nn\nn\nn\n", Tool::Codex),
            ("n\nn\ny\nn\nn\n", Tool::Copilot),
            ("n\nn\nn\ny\nn\n", Tool::Pi),
            ("n\nn\nn\nn\ny\n", Tool::Cursor),
        ];
        for (answers, want) in cases {
            let (got, _) = with_answers(None, true, answers);
            assert_eq!(got.expect("selection"), vec![want], "{answers:?}");
        }
    }

    #[test]
    fn interactive_all_no_reasks_until_a_tool_is_picked() {
        // Scenario「交互终端不得提交空选集」：五题皆否就印一行提示、从 Claude 重问。
        let (got, prompts) = with_answers(None, true, "n\nn\nn\nn\nn\nn\ny\nn\nn\nn\n");
        assert_eq!(got.expect("selection"), vec![Tool::Codex]);
        assert_eq!(
            prompts.matches("for Claude?").count(),
            2,
            "五题皆否必须从 Claude 重新询问: {prompts}"
        );
        assert!(
            prompts.contains(
                "(y/n): Pick at least one tool: claude, codex, copilot, pi, cursor, or any combination.\n"
            ),
            "{prompts}"
        );
    }

    #[test]
    fn interactive_invalid_answer_reasks_the_same_question() {
        let (got, prompts) = with_answers(None, true, "maybe\ny\nn\nn\nn\nn\n");
        assert_eq!(got.expect("selection"), vec![Tool::Claude]);
        assert!(
            prompts.matches("Claude").count() >= 2,
            "无效输入必须重问同一题: {prompts}"
        );
    }

    #[test]
    fn interactive_eof_is_a_single_line_error() {
        let (got, _) = with_answers(None, true, "");
        assert!(single_line_error(got).contains("--tools"));
    }

    #[test]
    fn prompts_carry_no_ansi_escape() {
        let (_, prompts) = with_answers(None, true, "y\nn\nn\nn\nn\n");
        assert!(!prompts.contains('\x1b'), "prompt 不得含 ANSI: {prompts:?}");
    }
}
/// `tools` arrives already resolved and validated by `cmd_init` — filesystem and remote
/// init share that one entry, so a remote checkout is bootstrapped from the same selection
/// rules (and the same non-empty guarantee) as a local one.
fn cmd_init_remote(
    a: &InitArgs,
    root: &std::path::Path,
    display_base: &str,
    tools: &[core::skills::Tool],
) -> Result<()> {
    let Some(url) = a.url.as_deref() else {
        bail!("--store remote requires --url <project-scoped url>");
    };
    if a.dir.is_some() {
        bail!("--dir has no meaning with --store remote (documents live on the server)");
    }
    core::init::init_remote(root, tools, a.force, url, a.repo.as_deref())?;
    println!("{} Initialized at {display_base} (remote store)", color::green("✓"));
    let names: Vec<&str> = tools.iter().map(|t| t.name()).collect();
    println!("Generated files for: {}", names.join(", "));
    // Validate the declared repo now when credentials exist; defer otherwise
    // (offline init must not block — the first verb still validates).
    validate_or_defer(root, url, a.repo.as_deref())?;
    // 这里产生的技能来自本机的范本（还没登录的人也要有技能可用）。
    println!("! After you log in (`specseal auth login`), run `specseal update` to get the skills this server provides");
    Ok(())
}
