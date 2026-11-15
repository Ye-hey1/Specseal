//! The two quality stations: review and verify.
//!
//! Both are Dual, declared at the family level (`station_dual`) after the clap
//! subcommands are normalized into one `StationVerb`, so the two stations share
//! a single ticket flow instead of duplicating it.

use anyhow::{bail, Result};
use specseal_core as core;

use crate::color;
use crate::common::{emit, open_project, print_json, read_stdin_content, render_options};
use crate::dual;
use crate::remote_base::RemoteCtx;
use core::store::Store;
use specseal_verbs::families::station::{ReviewArgs, ReviewCommands, VerifyArgs, VerifyCommands};
use specseal_verbs::render::station::{self as render, StationAction};

/// 两个品质站共用的动词形状（design D1 的 CLI 面）：clap 的两个子命令 enum
/// 各自保留自己的说明文本与旗标可用性（verify 无 `prepare`），在此范式为
/// 同一组动词，往下只有一份实作。
enum StationVerb {
    Scope {
        change: String,
        json: bool,
        base: Option<String>,
        candidate_hash: Option<String>,
        include_hunk: Vec<String>,
    },
    AddRound {
        change: String,
        stdin: bool,
    },
    Show {
        change: String,
        json: bool,
    },
    Stamp {
        change: String,
        accept: bool,
        agent: Option<String>,
    },
    Discard {
        change: String,
    },
}
/// 一个品质站在 CLI 这层的全部站别差异：引擎常数组（工单文件名、meta 前缀、
/// 消息用词）与 host-local snapshot namespace。
struct StationCli {
    pub station: &'static core::station::Station,
    pub ns: specseal_host::change_diff::StationNs,
}
const REVIEW_CLI: StationCli = StationCli {
    station: &core::station::REVIEW,
    ns: specseal_host::change_diff::StationNs::Review,
};
const VERIFY_CLI: StationCli = StationCli {
    station: &core::station::VERIFY,
    ns: specseal_host::change_diff::StationNs::Verify,
};
pub(crate) fn cmd_review(a: ReviewArgs) -> Result<()> {
    let verb = match a.command {
        // prepare：Apply baseline 的两站共用入口（verify 无此子指令），自成双臂。
        ReviewCommands::Prepare { change, base, from } => {
            let req = PrepareReq { change, base, from };
            return dual(req, review_prepare_fs, |ctx, r| remote_review_prepare(ctx, r));
        }
        ReviewCommands::Scope { change, json, base, candidate_hash, include_hunk } => {
            StationVerb::Scope { change, json, base, candidate_hash, include_hunk }
        }
        ReviewCommands::AddRound { change, stdin } => StationVerb::AddRound { change, stdin },
        ReviewCommands::Show { change, json } => StationVerb::Show { change, json },
        ReviewCommands::Stamp { change, accept, agent } => {
            StationVerb::Stamp { change, accept, agent }
        }
        ReviewCommands::Discard { change } => StationVerb::Discard { change },
    };
    station_dual(&REVIEW_CLI, verb)
}
pub(crate) fn cmd_verify(a: VerifyArgs) -> Result<()> {
    let verb = match a.command {
        VerifyCommands::Scope { change, json, base, candidate_hash, include_hunk } => {
            StationVerb::Scope { change, json, base, candidate_hash, include_hunk }
        }
        VerifyCommands::AddRound { change, stdin } => StationVerb::AddRound { change, stdin },
        VerifyCommands::Show { change, json } => StationVerb::Show { change, json },
        VerifyCommands::Stamp { change, accept, agent } => {
            StationVerb::Stamp { change, accept, agent }
        }
        VerifyCommands::Discard { change } => StationVerb::Discard { change },
    };
    station_dual(&VERIFY_CLI, verb)
}
/// 两站共用的 Dual 声明：范式后的 StationVerb 派给本机／remote 站臂——
/// 站别差异只剩 StationCli 常数组，范式逻辑不进臂内。
fn station_dual(cli: &StationCli, verb: StationVerb) -> Result<()> {
    dual(verb, |v| station_fs(cli, v), |ctx, v| remote_station(ctx, cli, v))
}
/// `review prepare` 的参数：不带旗标是 Apply 起点；`--base`（可带 `--from`）
/// 以可信 commit 重设基准并承接快照。
struct PrepareReq {
    change: String,
    base: Option<String>,
    from: Option<std::path::PathBuf>,
}
/// `review prepare` 的本机臂（验证站无此动词：Apply baseline 两站共用）。
fn review_prepare_fs(req: PrepareReq) -> Result<()> {
    let (ws, store) = open_project()?;
    if !store.change_exists(&req.change) {
        bail!("change not found: {}", req.change);
    }
    // started 判读走 fail-closed 解析：坏 meta 不得被读作「未开始」。
    let raw_meta = store.read_change_meta(&req.change);
    let meta = core::model::ChangeMeta::from_text(raw_meta.as_deref())
        .map_err(|e| anyhow::anyhow!(e))?;
    let ticket_open = |st: &core::station::Station| Ok(store.artifact_exists(&req.change, st.doc));
    run_review_prepare(&ws, &req, meta.started_at.is_some(), ticket_open)
}
fn station_fs(cli: &StationCli, verb: StationVerb) -> Result<()> {
    let (ws, store) = open_project()?;
    let st = cli.station;
    match verb {
        StationVerb::Scope { change, json, base, candidate_hash, include_hunk } => {
            if !store.change_exists(&change) {
                bail!("change not found: {change}");
            }
            let ticket = store
                .artifact_exists(&change, st.doc)
                .then(|| core::station::show(st, &store, &change))
                .transpose()?
                .map(|t| specseal_host::change_diff::TicketBinding {
                    patch_hash_chain: patch_hash_chain(
                        t.rounds.iter().map(|r| r.patch_hash.as_deref()),
                    ),
                    finding_paths: t
                        .last_round()
                        .findings
                        .iter()
                        .map(|f| f.path.clone())
                        .collect(),
                });
            let names = store.list_changes().into_iter().map(|c| c.name).collect();
            let claims = fs_touched_claims(&store, &change, names);
            let req = specseal_host::change_diff::ScopeRequest {
                change,
                touched_paths: claims.touched_paths,
                other_claims: claims.other_claims,
                ticket,
                base_override: base,
                candidate_hash,
                include_hunks: include_hunk,
                station: cli.ns,
            };
            run_station_scope(&ws, st, &req, json)?;
        }
        StationVerb::AddRound { change, stdin } => {
            let content = read_stdin_content(stdin);
            // 查无 change 或工单都读作「没有既有轮次」——查无的报错留给 add_round。
            let existing = match core::station::show(st, &store, &change) {
                Ok(ticket) => ticket.rounds,
                Err(e) if e.is::<core::station::NotFound>() => Vec::new(),
                Err(e) => return Err(e),
            };
            ensure_finding_paths(&ws, st, &existing, &content)?;
            let round = core::station::add_round(st, &store, &change, &content)?;
            emit_action(st, StationAction::AddRound(round), &change);
        }
        StationVerb::Show { change, json } => {
            // `--json` 只要解析后的工单，不碰原文——与导入共用渲染前的行为一致
            // （多读一次是多一个失败面）。
            if json {
                let ticket = core::station::show(st, &store, &change)?;
                emit(render::show(st, &change, &ticket, None, render_options(true)));
                return Ok(());
            }
            // 人眼路径印工单原文（show 已验证存在与格式）。
            let (ticket, doc) = core::station::show_with_content(st, &store, &change)?;
            let doc = doc.expect("show verified the ticket exists");
            emit(render::show(st, &change, &ticket, Some(&doc), render_options(false)));
        }
        StationVerb::Stamp { change, accept, agent } => {
            let actor = specseal_host::context::git_identity(&ws.root);
            // The commit the checkout is on goes into the stamp; outside a git
            // checkout there is none and the stamp lands without it.
            let head = core::tasks::head_commit(&ws.root);
            let read_file = |p: &str| core::util::read_bytes_opt(&ws.root.join(p));
            let file_exists = |p: &str| ws.root.join(p).is_file();
            core::station::stamp(
                st,
                &store,
                &change,
                accept,
                actor.as_deref(),
                agent.as_deref(),
                head.as_deref(),
                &read_file,
                &file_exists,
            )?;
            emit_action(st, StationAction::Stamp, &change);
            clear_snapshots_warning(&ws, st, cli.ns, &change);
        }
        StationVerb::Discard { change } => {
            core::station::discard(st, &store, &change)?;
            emit_action(st, StationAction::Discard, &change);
            clear_snapshots_warning(&ws, st, cli.ns, &change);
        }
    }
    Ok(())
}
/// 三个「动作完成」动词的成功行。CLI 的这三个动词没有 --json 形式。
fn emit_action(st: &core::station::Station, action: StationAction, change: &str) {
    emit(render::action(st, action, change, render_options(false)));
}
/// add-round 写入前的 finding 路径检查（本机／remote 两臂共用）：规则是引擎的
/// 纯函数，免检查前缀取自 host 范围解析同一份排除清单（规格目录与 `.specseal`）。违规即
/// invalid_argv 非零、零写入，stderr 逐条点名。
fn ensure_finding_paths(
    ws: &core::workspace::Workspace,
    st: &core::station::Station,
    existing: &[core::station::Round],
    content: &str,
) -> Result<()> {
    let exempt = specseal_host::change_diff::non_review_dirs(ws);
    let violations = core::station::finding_path_violations(st, existing, content, &exempt)?;
    if violations.is_empty() {
        return Ok(());
    }
    let lines: Vec<String> = violations.iter().map(|v| format!("  - {v}")).collect();
    bail!(core::command::InvalidContent(format!(
        "finding paths rejected — nothing was written to the {} ticket:\n{}",
        st.noun,
        lines.join("\n")
    )));
}
/// `review prepare` 的唯一实作（local／remote 共用）：sidecar 全在本地
/// checkout，只有「是否已开工」这件事实由各自的 store 提供。
///
/// initial／kept 静默（spec：stdout 为空）；late／unavailable 以 stderr 警告但
/// 仍 exit 0，让 apply 可以继续。`--base` 走重设：工单是否未结由各自的 store
/// 回答（`ticket_open`），host 只管 Git 与 sidecar。
fn run_review_prepare(
    ws: &core::workspace::Workspace,
    req: &PrepareReq,
    started: bool,
    ticket_open: impl Fn(&core::station::Station) -> Result<bool>,
) -> Result<()> {
    let change = req.change.as_str();
    if let Some(base) = &req.base {
        let mut open = Vec::new();
        for cli in [&REVIEW_CLI, &VERIFY_CLI] {
            if ticket_open(cli.station)? {
                open.push(cli.station.noun);
            }
        }
        specseal_host::change_diff::prepare_at(ws, change, base, &open, req.from.as_deref())?;
        return Ok(());
    }
    match specseal_host::change_diff::prepare(ws, change, started)? {
        specseal_host::change_diff::PrepareOutcome::Captured(_)
        | specseal_host::change_diff::PrepareOutcome::KeptExisting(_) => {}
        specseal_host::change_diff::PrepareOutcome::Late(_) => eprintln!(
            "Warning: baseline for '{change}' was captured late (the change already started) \
             — review scope will need an explicit trusted --base fixed point"
        ),
        specseal_host::change_diff::PrepareOutcome::Unavailable(_) => eprintln!(
            "Warning: no git checkout found — baseline recorded as unavailable; review scope \
             will need an explicit trusted --base fixed point"
        ),
    }
    Ok(())
}
/// 工单各轮的 patchHash 链（新→旧）——validation 回走重建 adjacent 段的依据。
/// 末轮没有 patchHash（legacy 轮）时回空链：验证轮据此 fail closed，不拿更早
/// 一轮的快照冒充末轮。
fn patch_hash_chain<'a>(
    rounds: impl DoubleEndedIterator<Item = Option<&'a str>>,
) -> Vec<String> {
    let mut newest_first = rounds.rev();
    match newest_first.next() {
        Some(Some(last)) => {
            std::iter::once(last).chain(newest_first.flatten()).map(str::to_string).collect()
        }
        _ => Vec::new(),
    }
}
/// 一轮 scope 请求的认领输入：本 change 的 touched 与其他 active change 的
/// 重叠认领，由两臂各自的 evidence 来源算好带进来。
#[derive(Default)]
struct ScopeClaims {
    touched_paths: Vec<String>,
    other_claims: Vec<specseal_host::change_diff::ActiveClaim>,
}
/// fs 模式的认领来源：本 change 与其他 active change 的 touched 都读 host-local
/// 的 evidence 记录；记录缺席＝零认领。
fn fs_touched_claims(
    store: &dyn Store,
    change: &str,
    other_change_names: Vec<String>,
) -> ScopeClaims {
    let touched_paths = core::tasks::TouchedRecord::load(store, change).all_files();
    let other_claims = other_change_names
        .into_iter()
        .filter(|name| name != change)
        .filter_map(|name| {
            let paths = core::tasks::TouchedRecord::load(store, &name).all_files();
            (!paths.is_empty())
                .then_some(specseal_host::change_diff::ActiveClaim { change: name, paths })
        })
        .collect();
    ScopeClaims { touched_paths, other_claims }
}
/// remote 模式的认领来源（design D1、D4）：本 change 与其他 active change 的
/// touched 都经 typed client 读 server 的 change evidence——remote 下本地没有
/// evidence 档。任一读取失败即中止（design D6）：静默降级成空认领会把连接
/// 问题伪装成 needsInput。空 entries 是正常状态（从未记录）＝零认领。
fn remote_touched_claims(
    ctx: &RemoteCtx,
    change: &str,
    other_change_names: &[String],
) -> Result<ScopeClaims> {
    let touched_paths = remote_evidence_files(ctx, change)?;
    // server 是外部边界：本 change 的认领会进 git pathspec，magic 前缀（:）
    // 会静默缩小审查面、不能靠 git 喊停，越界（..）与绝对路径一并在这里
    // 指名拒绝。other claims 只做重叠比对、不进 git，不设限。
    if let Some(bad) = touched_paths.iter().find(|p| hostile_pathspec(p)) {
        bail!(
            "evidence for change '{change}' claims a path that cannot enter the review scope: {bad}"
        );
    }
    let mut other_claims = Vec::new();
    for name in other_change_names.iter().filter(|name| *name != change) {
        let paths = remote_evidence_files(ctx, name)?;
        if !paths.is_empty() {
            other_claims
                .push(specseal_host::change_diff::ActiveClaim { change: name.clone(), paths });
        }
    }
    Ok(ScopeClaims { touched_paths, other_claims })
}
/// 一个 change 的 server evidence → touched 联集。错误指名是哪个 change 的
/// evidence 读不到（RemoteError 只有通用消息，多 change 读取下不指名就无从
/// 排查）。联集语意直接复用引擎的 all_files（design D2；head commit 仅存证，
/// all_files 不消费它——design D3）：wire entry 与引擎 entry 是镜射形状
///（server 端 pinned），逐栏搬运、不解读。
fn remote_evidence_files(ctx: &RemoteCtx, change: &str) -> Result<Vec<String>> {
    let resp = ctx
        .client
        .change_evidence(change)
        .map_err(|e| anyhow::anyhow!("could not read change evidence for '{change}': {e}"))?;
    let entries = resp
        .entries
        .into_iter()
        .map(|e| core::tasks::EvidenceEntry {
            task_id: e.task_id,
            task_desc: e.task_desc,
            actor: e.actor,
            repo: e.repo,
            head_commit: e.head_commit,
            touched_files: e.touched_files,
            recorded_at: e.recorded_at,
        })
        .collect();
    Ok(core::tasks::TouchedRecord { entries, ..Default::default() }.all_files())
}
/// 进 git pathspec 前的边界检查：magic 前缀、绝对路径与 `..` 越界。
fn hostile_pathspec(p: &str) -> bool {
    p.starts_with(':') || p.starts_with('/') || p.split(['/', '\\']).any(|seg| seg == "..")
}
/// scope 的解析与呈现（local／remote／两站共用——resolved payload 逐比特同形的
/// 唯一保证）。needsInput 印 JSON（--json 时）后以非零收场。
fn run_station_scope(
    ws: &core::workspace::Workspace,
    st: &core::station::Station,
    req: &specseal_host::change_diff::ScopeRequest,
    json: bool,
) -> Result<()> {
    match specseal_host::change_diff::resolve_scope(ws, req)? {
        specseal_host::change_diff::ScopeOutcome::Resolved(r) => {
            if json {
                return print_json(&serde_json::json!({
                    "change": r.change,
                    "phase": r.phase.as_str(),
                    "state": "resolved",
                    "baseCommit": r.base_commit,
                    "candidateHash": r.candidate_hash,
                    "patchHash": r.patch_hash,
                    "paths": r.paths,
                    "files": r.files,
                    "patch": r.patch,
                    "outOfScopeChanged": r.out_of_scope_changed,
                }));
            }
            let hunk_count: usize = r.files.iter().map(|f| f.hunks.len()).sum();
            println!(
                "{} Frozen {} scope for change '{}'",
                color::green("✓"),
                r.phase.as_str(),
                r.change
            );
            println!("  Patch: {}", r.patch_hash);
            println!(
                "  Scope: {} file(s), {} hunk(s){}",
                r.paths.len(),
                hunk_count,
                attribution_breakdown(&r.files)
            );
            // 范围外变动＝从未进本站检查面的候选档又动了：转知用户，不入检查面。
            if !r.out_of_scope_changed.is_empty() {
                println!(
                    "  Changed outside the {} scope: {}",
                    st.noun_phrase,
                    r.out_of_scope_changed.join(", ")
                );
            }
            Ok(())
        }
        specseal_host::change_diff::ScopeOutcome::NeedsInput(n) => {
            if json {
                print_json(&serde_json::json!({
                    "change": n.change,
                    "phase": n.phase.as_str(),
                    "state": "needsInput",
                    "candidateHash": n.candidate_hash,
                    "ambiguousPaths": n.ambiguous_paths,
                    "files": n.files,
                }))?;
            }
            bail!("{}", scope_needs_input_message(st, &n));
        }
    }
}
/// 验证轮计数行的三类出身补述（design D4）：discovery 没有上轮可归因，回空字符串。
fn attribution_breakdown(files: &[specseal_host::change_diff::FileDelta]) -> String {
    use specseal_host::change_diff::Attribution;
    let count = |a: Attribution| files.iter().filter(|f| f.attribution == Some(a)).count();
    let (finding, adjacent, new) =
        (count(Attribution::Finding), count(Attribution::Adjacent), count(Attribution::New));
    if finding + adjacent + new == 0 {
        return String::new();
    }
    format!(" — {finding} finding, {adjacent} adjacent, {new} new")
}
/// stamp／discard 后清本站的 host-local snapshots（Apply baseline 与另一站的
/// snapshots 保留——design D8）。清除失败仅警告——canonical 工单／metadata
/// mutation 已完成，不回滚。
fn clear_snapshots_warning(
    ws: &core::workspace::Workspace,
    st: &core::station::Station,
    ns: specseal_host::change_diff::StationNs,
    change: &str,
) {
    if let Err(e) = specseal_host::change_diff::clear_snapshots(ws, change, ns) {
        eprintln!("Warning: could not clear {} snapshots for '{change}': {e}", st.noun_phrase);
    }
}
/// needsInput 的 stderr 说明：原因、ambiguous paths 与三种处置（可信 --base、
/// hash-pinned --include-hunk、隔离 worktree）。
fn scope_needs_input_message(
    st: &core::station::Station,
    n: &specseal_host::change_diff::ScopeNeedsInput,
) -> String {
    use specseal_host::change_diff::AmbiguityReason;
    let mut lines = vec![format!("{} scope for '{}' needs input:", st.noun, n.change)];
    for reason in &n.reasons {
        lines.push(match reason {
            AmbiguityReason::BaselineMissing => {
                "  - no Apply baseline was captured for this change".to_string()
            }
            AmbiguityReason::BaselineLate => {
                "  - the baseline was captured late (change already started)".to_string()
            }
            AmbiguityReason::BaselineUnavailable => {
                "  - the baseline has no usable git fixed point".to_string()
            }
            AmbiguityReason::BaseUnresolvable(e) => format!("  - {e}"),
            AmbiguityReason::DirtyAtStart(paths) => {
                format!("  - touched paths were already dirty at start: {}", paths.join(", "))
            }
            AmbiguityReason::ActiveOverlap { change, paths } => format!(
                "  - active change '{change}' also claims: {}",
                paths.join(", ")
            ),
            AmbiguityReason::EmptyTouched => {
                "  - no touched files recorded — the whole worktree is never auto-reviewed"
                    .to_string()
            }
        });
    }
    if !n.ambiguous_paths.is_empty() {
        lines.push(format!("  ambiguous paths: {}", n.ambiguous_paths.join(", ")));
    }
    lines.push("resolve it explicitly by one of:".to_string());
    // Only discovery ever needs input: a validation round resolves its scope by
    // content movement against the frozen snapshot chain, so all three
    // disposals here address a discovery fixed point.
    lines.push("  1. pass a trusted fixed point with --base <rev>".to_string());
    lines.push(
        "  2. pin hunks with --candidate-hash <sha256> and --include-hunk <id> (repeatable)"
            .to_string(),
    );
    lines.push("  3. redo the work in an isolated worktree".to_string());
    lines.join("\n")
}
#[cfg(test)]
mod patch_hash_chain_tests {
    //! Ticket→TicketBinding 的 patchHash 链组装（spec「frozen snapshot 绑定
    //! discovery 与 validation patch」的回走链输入）：新→旧、legacy 空洞跳过、
    //! 末轮 legacy＝空链（验证轮据此 fail closed，不拿旧轮冒充末轮）。
    use super::patch_hash_chain;

    #[test]
    fn newest_first_and_legacy_gaps_skipped() {
        let rounds = [Some("sha256:r1"), None, Some("sha256:r3")];
        assert_eq!(
            patch_hash_chain(rounds.iter().map(|h| *h)),
            vec!["sha256:r3".to_string(), "sha256:r1".to_string()],
            "链序新→旧，中段 legacy 轮跳过"
        );
    }

    #[test]
    fn legacy_last_round_yields_an_empty_chain_even_with_older_hashes() {
        let rounds = [Some("sha256:r1"), Some("sha256:r2"), None];
        assert_eq!(
            patch_hash_chain(rounds.iter().map(|h| *h)),
            Vec::<String>::new(),
            "末轮无 hash 时不得拿旧轮快照冒充末轮"
        );
        assert_eq!(patch_hash_chain([None].iter().map(|h| *h)), Vec::<String>::new());
        assert_eq!(
            patch_hash_chain(std::iter::empty::<Option<&str>>()),
            Vec::<String>::new(),
            "空工单＝空链"
        );
    }
}
/// `review prepare` 的 remote 面：sidecar 仍在本地 checkout，先做 remote read
/// （存在＋startedAt），失败即零 sidecar effects。listing 的 status 只由任务
/// 完成度推导，不能当「已开工」读。
fn remote_review_prepare(ctx: &RemoteCtx, req: PrepareReq) -> Result<()> {
    let summary = ctx
        .client
        .list_changes()?
        .changes
        .into_iter()
        .find(|c| c.name == req.change)
        .ok_or_else(|| anyhow::anyhow!("change not found: {}", req.change))?;
    let ticket_open = |st: &core::station::Station| {
        Ok(ctx.client.station_ticket_if_any(st.noun, &req.change)?.is_some())
    };
    run_review_prepare(&ctx.ws, &req, summary.started_at.is_some(), ticket_open)
}
/// 两个品质站的 remote 动词（唯一实作落点）：工单经 typed client 的站别端点
/// 读写，scope 仍由本地 checkout 的 Host resolver 解析——server 不收 patch、
/// 不收 snapshot，也没有 Git endpoint。
fn remote_station(ctx: &RemoteCtx, cli: &StationCli, verb: StationVerb) -> Result<()> {
    let st = cli.station;
    let noun = st.noun;
    match verb {
        StationVerb::Scope { change, json, base, candidate_hash, include_hunk } => {
            // 同一 Host resolver：remote 提供 active changes、ticket 与 evidence
            // 事实，Git、baseline、snapshot 全在本地 checkout。
            let changes = ctx.client.list_changes()?.changes;
            if !changes.iter().any(|c| c.name == change) {
                anyhow::bail!("change not found: {change}");
            }
            let ticket = ctx.client.station_ticket_if_any(noun, &change)?.map(|t| {
                specseal_host::change_diff::TicketBinding {
                    patch_hash_chain: patch_hash_chain(
                        t.rounds.iter().map(|r| r.patch_hash.as_deref()),
                    ),
                    finding_paths: t
                        .last_round
                        .findings
                        .iter()
                        .map(|f| f.path.clone())
                        .collect(),
                }
            });
            let names: Vec<String> = changes.into_iter().map(|c| c.name).collect();
            // validation 轮（ticket 已存在）由冻结快照链解析、不消费认领——
            // 不为它读 evidence，evidence 的失败面就不会进必然成功的路径。
            let claims = match &ticket {
                Some(_) => ScopeClaims::default(),
                None => remote_touched_claims(ctx, &change, &names)?,
            };
            let req = specseal_host::change_diff::ScopeRequest {
                change,
                touched_paths: claims.touched_paths,
                other_claims: claims.other_claims,
                ticket,
                base_override: base,
                candidate_hash,
                include_hunks: include_hunk,
                station: cli.ns,
            };
            run_station_scope(&ctx.ws, st, &req, json)
        }
        StationVerb::AddRound { change, stdin } => {
            let content = read_stdin_content(stdin);
            let existing = match ctx.client.station_ticket_if_any(noun, &change)? {
                Some(ticket) => to_station_ticket(ticket)?.rounds,
                None => Vec::new(),
            };
            ensure_finding_paths(&ctx.ws, st, &existing, &content)?;
            let round = ctx.client.station_add_round(noun, &change, &content)?.round;
            // u64→usize：支持平台皆 64-bit，无损（不为不可能的情境设防）。
            emit_action(st, StationAction::AddRound(round as usize), &change);
            Ok(())
        }
        StationVerb::Show { change, json } => {
            let resp = ctx.client.station_ticket(noun, &change)?;
            // 人眼＋有原文＝纯转印，不碰结构化字段——这正是原文上 wire 的目的：
            // server 词汇比 CLI 新（未知 token、新形状）也不影响印出工单本文。
            // 解析（与其 fail-loud）只留给真正读 token 的两条路：--json 与退化摘要。
            if !json {
                if let Some(doc) = &resp.content {
                    emit(render::ticket_text(doc, render_options(false)));
                    return Ok(());
                }
            }
            let ticket = to_station_ticket(resp)?;
            emit(render::show(st, &change, &ticket, None, render_options(json)));
            Ok(())
        }
        StationVerb::Stamp { change, accept, agent } => {
            // 指纹归属（design D4a）：工作树持有者是这里——先取工单算 Scope
            // 联集（镜射引擎的范式：`\`→`/`、去重、排序），逐档读 checkout
            // 内容算哈希，随请求上 wire；server 验集合相等、不重算。
            let ticket = ctx.client.station_ticket(noun, &change)?;
            let paths = core::station::scope_union(
                ticket.rounds.iter().flat_map(|r| r.scope.iter().map(String::as_str)),
            );
            // 修正可能删除／改名早轮检查过的档：仍存在者算哈希，已消失者以
            // missing 明示声明——server 无工作树，分割由这里的存在性判定。
            let (present, missing): (Vec<String>, Vec<String>) =
                paths.into_iter().partition(|p| ctx.ws.root.join(p).is_file());
            let read_file = |p: &str| core::util::read_bytes_opt(&ctx.ws.root.join(p));
            let scope: Vec<_> = core::station::fingerprint_scope(&present, &read_file)?
                .into_iter()
                .map(|(path, hash)| specseal_protocol::command::ReviewScopeEntryDto { path, hash })
                .collect();
            let head = core::tasks::head_commit(&ctx.ws.root);
            ctx.client.station_stamp(noun, &change, accept, agent.as_deref(), head.as_deref(), &scope, &missing)?;
            emit_action(st, StationAction::Stamp, &change);
            Ok(())
        }
        StationVerb::Discard { change } => {
            ctx.client.station_discard(noun, &change)?;
            emit_action(st, StationAction::Discard, &change);
            Ok(())
        }
    }
}
/// The wire ticket reshaped into the engine's ticket, so `--json` goes through
/// the one payload assembly whose field set is the public contract (and the
/// document body, which is not part of that contract, cannot leak into it).
///
/// An unrecognized phase token is an error, not a silent `None`: it means the
/// server speaks a round vocabulary this CLI does not, and rendering it as a
/// legacy round would state something false about the ticket.
fn to_station_ticket(
    resp: specseal_protocol::command::ReviewTicketResponse,
) -> Result<core::station::Ticket> {
    // 引擎工单的不变量是至少一轮；wire 形状上允许空数组，所以这里是明确
    // 错误，不是留给 last_round() 的 expect 去炸。
    if resp.rounds.is_empty() {
        anyhow::bail!(
            "the server returned a ticket with no rounds for change '{}' — cannot render it",
            resp.change
        );
    }
    let rounds = resp
        .rounds
        .into_iter()
        .map(to_station_round)
        .collect::<Result<Vec<_>>>()?;
    Ok(core::station::Ticket { rounds })
}
/// server 端词汇比这支 CLI 新——静默吞掉会渲染出错误事实，一律报错。
fn unknown_ticket_token(kind: &str, token: &str) -> anyhow::Error {
    anyhow::anyhow!(
        "unknown {kind} '{token}' from the server — this CLI is older than the server's ticket format"
    )
}
fn to_station_round(
    r: specseal_protocol::command::ReviewRoundDto,
) -> Result<core::station::Round> {
    let phase = match r.phase.as_deref() {
        None => None,
        Some(token) => Some(
            core::station::RoundPhase::parse(token)
                .ok_or_else(|| unknown_ticket_token("round phase", token))?,
        ),
    };
    let findings = r
        .findings
        .into_iter()
        .map(|f| {
            let severity = core::station::Severity::parse(&f.severity)
                .ok_or_else(|| unknown_ticket_token("finding severity", &f.severity))?;
            Ok(core::station::Finding { severity, path: f.path, text: f.text })
        })
        .collect::<Result<Vec<_>>>()?;
    let rules = match r.rules {
        None => None,
        Some(rules) => Some(core::config::ReviewConfig {
            baseline: core::config::ReviewBaseline::parse(&rules.baseline)
                .ok_or_else(|| unknown_ticket_token("rules baseline", &rules.baseline))?,
            critical: rules.critical,
            warning: rules.warning,
            suggestion: rules.suggestion,
        }),
    };
    Ok(core::station::Round {
        index: r.index as usize,
        phase,
        patch_hash: r.patch_hash,
        rules,
        scope: r.scope,
        findings,
    })
}
#[cfg(test)]
mod station_round_tests {
    //! remote 轮次 DTO → 引擎 `Round`：server 端词汇比这支 CLI 新时一律报错。
    use super::to_station_round;
    use specseal_protocol::command::{ReviewRoundDto, ReviewRulesDto};

    fn round_with_baseline(baseline: &str) -> ReviewRoundDto {
        ReviewRoundDto {
            index: 1,
            phase: Some("discovery".into()),
            patch_hash: Some(format!("sha256:{}", "a".repeat(64))),
            rules: Some(ReviewRulesDto {
                baseline: baseline.into(),
                critical: vec![],
                warning: vec!["要有测试".into()],
                suggestion: vec![],
            }),
            scope: vec!["src/lib.rs".into()],
            findings: vec![],
        }
    }

    #[test]
    fn rules_map_back_to_the_engine_config() {
        let round = to_station_round(round_with_baseline("replace")).expect("known baseline");
        let rules = round.rules.expect("rules carried");
        assert_eq!(rules.baseline, specseal_core::config::ReviewBaseline::Replace);
        assert_eq!(rules.warning, vec!["要有测试".to_string()]);
    }

    #[test]
    fn an_unknown_baseline_from_the_server_is_an_error() {
        let err = to_station_round(round_with_baseline("strict")).expect_err("unknown baseline");
        let msg = err.to_string();
        assert!(msg.contains("strict") && msg.contains("older than the server"), "{msg}");
    }
}
