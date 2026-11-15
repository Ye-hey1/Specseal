//! Archive a completed change: apply deltas to canonical specs, inject @trace, snapshot, move.

use crate::model::{self, Change};
use crate::store::Store;
use crate::util;
use crate::workspace::Workspace;
use anyhow::{bail, Result};

#[derive(Debug, Clone)]
pub struct CapCounts {
    pub capability: String,
    pub added: usize,
    pub modified: usize,
    pub removed: usize,
    pub renamed: usize,
}

#[derive(Debug)]
pub struct ArchiveOutcome {
    pub change_name: String,
    pub dated_name: String,
    pub caps: Vec<CapCounts>,
    pub snapshot_created: bool,
    pub skipped_specs: bool,
    /// The linked discussions archived along with the change: (slug, archived file name).
    /// A change can carry several source discussions (`from_discussion` is a comma
    /// accumulator), so each is judged independently — empty when none co-travel.
    pub archived_discussions: Vec<(String, String)>,
    /// Whether the change carried any per-task evidence. A reported fact, never a
    /// gate: archiving without evidence is legitimate (a spec-only change earns
    /// none by construction), so the caller decides whether to say anything.
    pub evidence_recorded: bool,
}

#[derive(Debug, Default)]
pub struct ArchiveOptions {
    pub skip_specs: bool,
    pub no_validate: bool,
    pub mark_tasks_complete: bool,
    /// 带着未结审查工单照样封存（spec「封存的未结工单守门」的明示带走处置）；
    /// 工单随目录搬入封存区，成为「曾审查未通过」标示的化石证据。
    pub carry_review: bool,
    /// 带着未结验证工单照样封存（spec verify-station「封存的验证工单守门与双
    /// 工单并存」）；工单随目录搬入封存区，成为「曾验证未通过」标示的化石证据。
    /// 与 `carry_review` 各自独立——带走哪种工单是两个决定，可同时带。
    pub carry_verify: bool,
}

/// 未结工单守门（design D4／D5；spec review-station「封存的未结工单守门」与
/// verify-station「封存的验证工单守门与双工单并存」）：任一站工单存在且未带
/// 对应的 `--carry-*` → 拒绝、该站三处置齐列；两站工单并存时两组处置并列
/// （只报一站会让用户处理完一张再撞一次同样的墙）。带旗标时工单随目录搬移，
/// 成为封存侧「曾审查／曾验证未通过」标示的化石证据。皆无工单时零效果——行为
/// 与导入前完全一致。守门只在此处：每个入口都经 `archive()`。
fn guard_open_tickets(
    store: &dyn Store,
    name: &str,
    carry_review: bool,
    carry_verify: bool,
) -> Result<()> {
    let stations = [
        (&crate::station::REVIEW, carry_review),
        (&crate::station::VERIFY, carry_verify),
    ];
    let blocks: Vec<String> = stations
        .iter()
        .filter(|(st, carry)| !carry && store.artifact_exists(name, st.doc))
        .map(|(st, _)| crate::station::open_ticket_disposal(st, name))
        .collect();
    if blocks.is_empty() {
        return Ok(());
    }
    Err(crate::command::Refusal(blocks.join("\n")).into())
}

/// 章失效守门（design D5；spec change-lifecycle「封存的章失效守门」）：两站
/// 各判一次，章齐备且判 stale → 拒绝并点名站别与破锚原因，指路重跑该站；两章
/// 皆 stale 时并列。无章与章字段不全（Unknown）零效果——行为与导入前一致。
/// 空 root＝无本地工作树（remote 封存信道，沿 guard_linked_worktree 的惯例）：
/// 内容锚无从判定，只判任务锚。
fn guard_stale_stamps(ws: &Workspace, store: &dyn Store, change: &Change) -> Result<()> {
    let counts = crate::tasks::counts_for(store, &change.name);
    // 内容锚读的是 repo 程序档（host 侧文件，非 spec 文档）——沿 guard_linked_worktree
    // 的作法走 util 的通用文件 helper，引擎流程模块本身不直接调用文件 API。
    let read_file = |p: &str| util::read_bytes_opt(&ws.root.join(p));
    let read_file: crate::station::ScopeReader<'_> =
        if ws.is_local() { Some(&read_file) } else { None };

    let blocks: Vec<String> = [&crate::station::REVIEW, &crate::station::VERIFY]
        .into_iter()
        .map(|st| (st, change.meta.anchors(st)))
        // 工单开立中的站不入失效判定:其旧章已被重开的工单取代,该站的封存
        // 处置(挡下或 --carry-* 带走)由未结工单守门承载——旧章在此拦路会把
        // carry 处置堵成死路。
        .filter(|(st, _)| !store.artifact_exists(&change.name, st.doc))
        .filter(|(_, anchors)| crate::station::is_stamped(*anchors))
        .filter_map(|(st, anchors)| {
            crate::station::stale_reason(anchors, &counts, read_file)
                .map(|reason| stale_stamp_block(st, &change.name, &reason))
        })
        .collect();
    if blocks.is_empty() {
        return Ok(());
    }
    Err(crate::command::Refusal(blocks.join("\n")).into())
}

/// 一站的失效拒绝段落：点名站别、破锚原因与出路。
fn stale_stamp_block(
    st: &crate::station::Station,
    name: &str,
    reason: &crate::station::StaleReason,
) -> String {
    let why = match reason {
        crate::station::StaleReason::ContentAnchor { path } => {
            format!("'{path}' changed after the stamp")
        }
        crate::station::StaleReason::TaskAnchor {
            stamped_total,
            total,
            code_complete,
            code_total,
        } => format!(
            "tasks moved after the stamp ({stamped_total} at stamp time, {total} now; \
             {code_complete}/{code_total} code tasks complete)"
        ),
    };
    format!(
        "change '{name}' carries a {} stamp that no longer holds — {why}; re-run the {} \
         station to {}, then archive",
        st.noun, st.noun, st.recheck
    )
}

/// linked worktree 的分支惯例前缀（specseal-host 的 worktree discovery 同字面；
/// 那份常数活在 host，core 取用不到，故在此独立持有）。
const WORKTREE_BRANCH_PREFIX: &str = "specseal/";

/// linked worktree 环境守门（design D2；spec change-lifecycle「封存的 linked
/// worktree 环境守门」）：worktree 内封存会把解封存备份写进 gitignored 的
/// `.specseal/snapshots/`，随 `git worktree remove` 一并蒸发，且 delta 套的是
/// 分支点的过期正典——数据遗失级，故 fail-closed。
///
/// 两条件同时成立才拒绝：workspace root 的 `.git` 是文件（linked worktree 特征，
/// 与 worktree overlay 的主副本判准同源），且当前分支具 `specseal/` 前缀。主
/// checkout 在第一个条件即短路，不 spawn git。git 不可用、指令失败或输出为空
/// （detached HEAD）→ 放行，沿 worktree discovery 的 fail-open 惯例。
fn guard_linked_worktree(ws: &Workspace) -> Result<()> {
    // 无 host workspace 的派发（Node host store）拿到的是空 root 的合成
    // Workspace——没有本地环境可判；空 root 接上 ".git" 会变成以行程 cwd
    // 判定，cwd 恰在任何 specseal worktree 内就会误拒不相干 store 的封存。
    if !ws.is_local() {
        return Ok(());
    }
    if !ws.root.join(".git").is_file() {
        return Ok(());
    }
    let Some(branch) = util::git(&ws.root, &["branch", "--show-current"]) else {
        return Ok(());
    };
    if !branch.starts_with(WORKTREE_BRANCH_PREFIX) {
        return Ok(());
    }
    Err(crate::command::Refusal(format!(
        "archive must not run inside a linked worktree — this checkout is on branch \
         '{branch}', and archiving here writes the unarchive backup into the worktree's \
         gitignored .specseal/snapshots/ (gone with the worktree) while merging deltas \
         onto the branch point's stale canon;\n  \
         land the branch first:  specseal-worktree-merge, then archive from the main checkout"
    ))
    .into())
}

pub(crate) struct DeltaReq {
    pub(crate) operation: String,
    pub(crate) name: String,
    pub(crate) block: String,
}

pub(crate) fn parse_delta(text: &str) -> Vec<DeltaReq> {
    let mut reqs = Vec::new();
    let mut operation = String::new();
    let mut cur: Option<(String, String, Vec<String>)> = None; // (op, name, lines)
    let flush = |cur: &mut Option<(String, String, Vec<String>)>, reqs: &mut Vec<DeltaReq>| {
        if let Some((op, name, lines)) = cur.take() {
            // Preserve the delta's inter-requirement spacing verbatim (only strip a single
            // trailing newline that `lines.join` cannot have produced anyway).
            reqs.push(DeltaReq {
                operation: op,
                name,
                block: lines.join("\n"),
            });
        }
    };
    for line in text.lines() {
        let t = line.trim_start();
        if let Some(op) = t.strip_prefix("## ") {
            if op.trim_end().ends_with("Requirements") {
                flush(&mut cur, &mut reqs);
                operation = op.split_whitespace().next().unwrap_or("").to_string();
                continue;
            }
        }
        if let Some(name) = t.strip_prefix("### Requirement:") {
            flush(&mut cur, &mut reqs);
            cur = Some((operation.clone(), name.trim().to_string(), vec![line.to_string()]));
        } else if let Some((_, _, lines)) = cur.as_mut() {
            lines.push(line.to_string());
        }
    }
    flush(&mut cur, &mut reqs);
    reqs
}

/// A delta operation that no longer matches the canonical spec, or that contradicts
/// another operation in the same delta. The fail-closed merge gate's unit of refusal —
/// and the single judgement shared by drift's Specs dimension (which re-exports it as
/// `SpecAssumption`) and bulk archive's readiness pre-check (spec archive-merge
/// 「过期判定单源共用」). `operation` carries a comma-joined list on a multi-section
/// collision — the one deliberate widening of its single-token value domain.
#[derive(Debug, Clone, serde::Serialize)]
pub struct MergeViolation {
    pub capability: String,
    pub operation: String,
    pub requirement: String,
    pub reason: String,
}

impl MergeViolation {
    /// 这笔违规是否出自新 capability 的 Purpose 守门（operation 恒为
    /// [`PURPOSE_OP`]、requirement 恒为 [`PURPOSE_SECTION`]）。drift 的建议改道、
    /// bulk 预检的点名、merge_refusal 的补救分流与 change 验证的去重都问这一个
    /// 判别，Purpose 类的呈现不会与过期类混同。两栏都要对上：delta 若自己写了
    /// `## PURPOSE Requirements` 标头，底下需求的 operation 也会是 PURPOSE，
    /// 那是 CANON_ABSENT 类的过期违规，不得被当成 Purpose 守门。
    pub fn is_purpose_gate(&self) -> bool {
        self.operation == PURPOSE_OP && self.requirement == PURPOSE_SECTION
    }

    /// 这笔违规是否出自「同一需求名跨区段出现多次」的撞名守门（reason 恒为
    /// [`SECTION_COLLISION`]）。change 验证问这一个判别来与结构层的 Duplicate／
    /// appears in both error 去重，不比对 reason 字符串——常数改字时方法跟着改，
    /// 两者同档同一 diff 可见。
    pub fn is_section_collision(&self) -> bool {
        self.reason == SECTION_COLLISION
    }

    /// 这笔违规的 operation 是否含 RENAMED 端点（撞名守门的 operation 是排序
    /// 去重后的逗号串）。结构层的重复名扫描只走 ADDED／MODIFIED／REMOVED 区段，
    /// 含 RENAMED 的撞名它看不到——change 验证的去重要放行这一类。
    pub fn involves_rename(&self) -> bool {
        self.operation.split(", ").any(|op| op == "RENAMED")
    }

    /// change 验证用的单行呈现（spec spec-validation「change 验证纳入合并守门」）：
    /// `specs/<capability>/spec.md: <operation> '<requirement>': <reason> (see:
    /// specseal drift <change>)`。路径是逻辑路径、手工正斜线；reason 逐字沿用
    /// 守门的冻结字符串；每行自带补救指向——validate 的 error 是逐行字符串，没有
    /// merge_refusal 那种聚合尾注的位置。两种呈现都放在类型旁边，字段一动同档可见。
    pub fn validation_error(&self, change: &str) -> String {
        format!(
            "specs/{}/spec.md: {} '{}': {} (see: specseal drift {change})",
            self.capability, self.operation, self.requirement, self.reason
        )
    }
}

/// Refusal reasons — frozen strings, rendered verbatim by archive, drift and bulk.
const ADDED_EXISTS: &str = "already exists in the canonical spec — archive would refuse it";
const TARGET_GONE: &str = "target requirement no longer exists in the canonical spec";
const CANON_ABSENT: &str = "canonical spec for this capability does not exist";
const SECTION_COLLISION: &str = "appears more than once across this delta's operation sections";
const RENAME_TARGET_EXISTS: &str = "rename target already exists in the canonical spec";
const NO_RENAME_TARGET: &str = "RENAMED operation names no TO: target";
const MALFORMED_REMOVAL: &str =
    "malformed REMOVED-SCENARIO declaration (missing `-->` on the same line)";
const MALFORMED_BEFORE: &str = "malformed BEFORE comment (never closed with `-->`)";

/// 新 capability 的 Purpose 守门在违规列里的座标：它不属于任何需求操作，
/// 以固定的操作名与区段名指认自己（`<cap> / PURPOSE / ## Purpose: <原因>`）。
const PURPOSE_OP: &str = "PURPOSE";
const PURPOSE_SECTION: &str = "## Purpose";

/// Marker declaring that a MODIFIED block drops a canonical scenario on purpose.
/// One per line inside the block; stripped before the merged text reaches the canon.
const REMOVED_SCENARIO: &str = "<!-- REMOVED-SCENARIO:";

/// `#### Scenario:` names declared in a requirement block, trimmed — the comparison
/// semantics of requirement names.
fn scenario_names(block: &str) -> Vec<String> {
    block
        .lines()
        .filter_map(|l| l.trim_start().strip_prefix("#### Scenario:"))
        .map(|n| n.trim().to_string())
        .collect()
}

/// Scenario names a MODIFIED block explicitly gives up via `<!-- REMOVED-SCENARIO: X -->`.
/// Only same-line-terminated declarations count; a marker without its `-->` is malformed
/// and refused by the gate — never silently accepted or stripped.
fn declared_scenario_removals(block: &str) -> Vec<String> {
    block
        .lines()
        .filter_map(|l| l.trim_start().strip_prefix(REMOVED_SCENARIO))
        .filter_map(|rest| rest.trim_end().strip_suffix("-->"))
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .collect()
}

/// Whether the block carries a `<!-- REMOVED-SCENARIO:` marker that never closes on its
/// own line — the note-stripper would swallow everything after it, so the gate refuses.
fn has_malformed_removal(block: &str) -> bool {
    block.lines().any(|l| {
        let t = l.trim_start();
        t.starts_with(REMOVED_SCENARIO) && !t.trim_end().ends_with("-->")
    })
}

/// Whether the block opens a `<!-- BEFORE:` comment that never closes — the multi-line
/// strip would swallow the rest of the block, so the gate refuses.
fn has_unclosed_before(block: &str) -> bool {
    let mut open = false;
    for line in block.lines() {
        if open {
            if line.trim_end().ends_with("-->") {
                open = false;
            }
        } else if line.trim_start().starts_with("<!-- BEFORE:")
            && !line.trim_end().ends_with("-->")
        {
            open = true;
        }
    }
    open
}

/// CRLF → LF, so name comparisons behave identically on Windows-authored deltas.
fn normalize_newlines(text: &str) -> String {
    text.replace("\r\n", "\n")
}

/// A delta's operation-section requirements and its rename pairs, read on
/// newline-normalized text the one way the merge gate reads a delta. The pair
/// scan covers both documented RENAMED syntaxes, so header-form RENAMED
/// entries are left out of the requirements. The plan reads deltas through
/// this too, so it names what the gate names.
pub(crate) fn delta_operations(text: &str) -> (Vec<DeltaReq>, Vec<(String, String)>) {
    let text = normalize_newlines(text);
    let reqs = parse_delta(&text)
        .into_iter()
        .filter(|r| r.operation != "RENAMED")
        .collect();
    (reqs, model::rename_pairs(&text))
}

/// The requirement names the canonical spec of `cap` carries now, read the way
/// the merge gate reads them; none when the capability has no spec yet.
pub(crate) fn canonical_names(store: &dyn Store, cap: &str) -> std::collections::BTreeSet<String> {
    store
        .read_canonical_spec(cap)
        .map(|text| {
            parse_canonical(&normalize_newlines(&text))
                .1
                .into_iter()
                .map(|(name, _)| name)
                .collect()
        })
        .unwrap_or_default()
}

/// Every merge violation across the change's delta capabilities, empty when the deltas
/// still apply cleanly. Reads only Store spec facts, so drift, the bulk pre-check and
/// archive itself all reach the same verdict.
pub fn merge_violations(store: &dyn Store, change: &str) -> Vec<MergeViolation> {
    let mut out = Vec::new();
    for cap in store.delta_capabilities(change) {
        let delta_text = store
            .read_artifact(change, &model::delta_spec_artifact(&cap))
            .unwrap_or_default();
        let canonical = store.read_canonical_spec(&cap);
        out.extend(capability_violations(&cap, &delta_text, canonical.as_deref()));
    }
    out
}

/// The violation list of design「违规清单与聚合错误形状」 for one capability — the six
/// designed classes plus the malformed-note and dangling-rename guards that keep them
/// airtight. RENAMED is judged through the shared pair scan ([`delta_operations`]).
pub(crate) fn capability_violations(
    cap: &str,
    delta_text: &str,
    canonical: Option<&str>,
) -> Vec<MergeViolation> {
    let delta_text = normalize_newlines(delta_text);
    let (reqs, renames) = delta_operations(&delta_text);
    let mut out: Vec<MergeViolation> = Vec::new();
    let violation = |operation: &str, requirement: &str, reason: &str| MergeViolation {
        capability: cap.to_string(),
        operation: operation.to_string(),
        requirement: requirement.to_string(),
        reason: reason.to_string(),
    };

    // (3) One requirement name mentioned more than once across the operation sections —
    // spanning sections, duplicated inside one, or via a RENAMED endpoint. Mentions are
    // counted (not deduped): a self-contradicting delta must refuse, and the merge
    // relies on every cleared name being unique.
    let mut mentions: std::collections::BTreeMap<&str, Vec<&str>> =
        std::collections::BTreeMap::new();
    for r in &reqs {
        mentions.entry(r.name.as_str()).or_default().push(r.operation.as_str());
    }
    for (from, to) in &renames {
        mentions.entry(from.as_str()).or_default().push("RENAMED");
        mentions.entry(to.as_str()).or_default().push("RENAMED");
    }
    for (name, ops) in &mentions {
        if ops.len() > 1 {
            let mut listed: Vec<&str> = ops.clone();
            listed.sort_unstable();
            listed.dedup();
            out.push(violation(&listed.join(", "), name, SECTION_COLLISION));
        }
    }

    // A rename source that never pairs with a TO: target (orphan FROM in either form,
    // or an empty TO) would apply to nothing — under a fail-closed gate that is
    // refused, not ignored.
    for name in model::rename_dangling_sources(&delta_text) {
        out.push(violation("RENAMED", &name, NO_RENAME_TARGET));
    }

    // An unclosed `<!-- BEFORE:` makes the note-stripper swallow the rest of the block —
    // the requirement body would silently vanish from the canon, so the gate refuses.
    for r in reqs.iter().filter(|r| matches!(r.operation.as_str(), "ADDED" | "MODIFIED")) {
        if has_unclosed_before(&r.block) {
            out.push(violation(&r.operation, &r.name, MALFORMED_BEFORE));
        }
    }

    // (6) A capability with no canonical spec yet accepts ADDED only — a MODIFIED,
    // REMOVED or RENAMED there is an assumption about text that was never written.
    let Some(canonical) = canonical else {
        // 新开 capability 的 Purpose 硬挡（design D3）：不合格就拒绝放行，取代
        // 「静默写占位」。判准与 change 验证共用单一定义，两道防线不会漂移。
        // reason 带「archive would refuse it」拒绝语意（比照 ADDED_EXISTS）——
        // drift 假设清单与 bulk 预检转载同一字符串时，读者直接看得出后果。
        if let Some(defect) = model::purpose_defect(&delta_text) {
            let reason = format!("{} — archive would refuse it", defect.reason());
            out.push(violation(PURPOSE_OP, PURPOSE_SECTION, &reason));
        }
        for r in reqs.iter().filter(|r| r.operation != "ADDED") {
            out.push(violation(&r.operation, &r.name, CANON_ABSENT));
        }
        for (from, _) in &renames {
            out.push(violation("RENAMED", from, CANON_ABSENT));
        }
        return out;
    };

    let canonical = normalize_newlines(canonical);
    let blocks = parse_canonical(&canonical).1;
    let names: std::collections::BTreeSet<&str> =
        blocks.iter().map(|(n, _)| n.as_str()).collect();
    for r in &reqs {
        match r.operation.as_str() {
            // (1) ADDED colliding with a requirement the canon already carries.
            "ADDED" if names.contains(r.name.as_str()) => {
                out.push(violation("ADDED", &r.name, ADDED_EXISTS));
            }
            // (2) MODIFIED/REMOVED whose source requirement is gone.
            "MODIFIED" | "REMOVED" if !names.contains(r.name.as_str()) => {
                out.push(violation(&r.operation, &r.name, TARGET_GONE));
            }
            // (5) MODIFIED wholesale-replaces its target, so every canonical scenario
            // must be carried over or explicitly given up. Judged on the note-stripped
            // text — exactly what the merge would write — so a scenario line quoted
            // inside a review comment never counts as carried.
            "MODIFIED" => {
                if has_malformed_removal(&r.block) {
                    out.push(violation("MODIFIED", &r.name, MALFORMED_REMOVAL));
                }
                let carried = scenario_names(&strip_review_notes(&r.block));
                let declared = declared_scenario_removals(&r.block);
                let dropped: Vec<String> = blocks
                    .iter()
                    .find(|(n, _)| n == &r.name)
                    .map(|(_, b)| scenario_names(b))
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|s| !carried.contains(s) && !declared.contains(s))
                    .collect();
                if !dropped.is_empty() {
                    out.push(violation(
                        "MODIFIED",
                        &r.name,
                        &format!(
                            "drops canonical scenario(s) {} — carry them over, or declare \
                             the removal with `{REMOVED_SCENARIO} <name> -->`",
                            dropped.join("、")
                        ),
                    ));
                }
            }
            _ => {}
        }
    }
    for (from, to) in &renames {
        // (2) RENAMED source gone, or (4) rename target already taken.
        if !names.contains(from.as_str()) {
            out.push(violation("RENAMED", from, TARGET_GONE));
        } else if names.contains(to.as_str()) {
            out.push(violation("RENAMED", to, RENAME_TARGET_EXISTS));
        }
    }
    out
}

/// The aggregated refusal (design「违规清单与聚合错误形状」): every violation listed
/// at once so one repair round clears them all, closing with the remediation route.
/// Purpose 守门的违规自成一类（spec archive-merge 守门清单第 (7) 项）：它不是
/// 「delta 与正典对不上」，drift → ingest 也修不了它——原因与补救各自分流，
/// 纯过期清单的输出逐比特维持原样。
fn merge_refusal(change: &str, violations: &[MergeViolation]) -> anyhow::Error {
    let (purpose, stale): (Vec<&MergeViolation>, Vec<&MergeViolation>) =
        violations.iter().partition(|v| v.is_purpose_gate());
    let list = |out: &mut String, vs: &[&MergeViolation]| {
        for v in vs {
            out.push_str(&format!(
                "  - {} / {} / {}: {}\n",
                v.capability, v.operation, v.requirement, v.reason
            ));
        }
    };

    let mut msg = format!("change '{change}' cannot be archived — ");
    if !stale.is_empty() {
        msg.push_str(&format!(
            "{} delta operation(s) no longer match the canonical spec:\n",
            stale.len()
        ));
        list(&mut msg, &stale);
    }
    if !purpose.is_empty() {
        if !stale.is_empty() {
            msg.push_str("and ");
        }
        msg.push_str(&format!(
            "{} new capability(ies) lack a qualifying `## Purpose`:\n",
            purpose.len()
        ));
        list(&mut msg, &purpose);
    }
    msg.push_str("fix the delta before archiving:");
    if !stale.is_empty() {
        msg.push_str(&format!(
            "\n  \
             specseal drift {change}     — see what moved under the change\n  \
             /specseal-ingest {change}   — update the delta to the current canonical spec"
        ));
    }
    if !purpose.is_empty() {
        msg.push_str(&format!(
            "\n  open the named delta spec with a `## Purpose` section (one or two sentences, \
             {} characters or more) — `specseal validate {change}` shows the full guidance",
            crate::model::MIN_PURPOSE_LENGTH
        ));
    }
    crate::command::Refusal(msg).into()
}

/// One capability's merge result, computed in the plan phase and written in the
/// commit phase — nothing here has touched the filesystem yet.
struct CapPlan {
    capability: String,
    counts: CapCounts,
    /// The pre-apply canonical text to snapshot; `None` for a capability being created.
    backup: Option<String>,
    /// The merged canonical text to write.
    content: String,
}

/// bulk 预检会跳过一个 change 的理由（design D4）。字符串渲染留在 bulk 端。
#[derive(Debug)]
pub enum SkipReason {
    MergeRefused(Vec<MergeViolation>),
    StructuralInvalid,
    TasksIncomplete { complete: usize, total: usize },
}

/// 未完成的任务计数：具名字段，让两个调用端都不必靠 tuple 位置。
struct TaskShortfall {
    complete: usize,
    total: usize,
}

/// 任务完成度条件（单笔封存的任务守门与 bulk 预检共用一支，两处判断同源）：
/// 只有 total > 0 且未全勾才算未完成，零任务的 change 放行。
fn incomplete_tasks(store: &dyn Store, name: &str) -> Option<TaskShortfall> {
    let tasks_md = store.read_artifact(name, "tasks.md").unwrap_or_default();
    let (total, complete, _) = crate::tasks::progress(&crate::tasks::parse(&tasks_md));
    (total > 0 && complete < total).then_some(TaskShortfall { complete, total })
}

/// bulk 预检的唯读投影：依 opts 三旗标的豁免语意，以 merge → validate → tasks 的固定
/// 顺序判定，命中第一条即回、后面的条件不再算；零写入。顺序是 bulk 的冻结输出契约，
/// 不是 archive() 的守门序。`--skip-specs` 跳过 spec 套用，守门在那里根本不跑，预检
/// 也不得以它过滤。
pub fn skip_reason(store: &dyn Store, change: &Change, opts: &ArchiveOptions) -> Option<SkipReason> {
    if !opts.skip_specs {
        let violations = merge_violations(store, &change.name);
        if !violations.is_empty() {
            return Some(SkipReason::MergeRefused(violations));
        }
    }
    // Structural only: the merge gate above owns a stale delta's refusal, and
    // --skip-specs deliberately bypasses it — validate must not reintroduce it.
    if !opts.no_validate && !crate::validate::validate_change_structural(store, change, false).valid {
        return Some(SkipReason::StructuralInvalid);
    }
    if opts.mark_tasks_complete {
        return None;
    }
    incomplete_tasks(store, &change.name)
        .map(|t| SkipReason::TasksIncomplete { complete: t.complete, total: t.total })
}

/// The canonical @trace block: where a requirement came from and when it last
/// landed. Nothing else — the canon carries no file list, so nothing here ever
/// depends on the work tree's state at archive time. `stamp` is the RFC 3339
/// local-offset timestamp of this archive (manual-pages「过期判定基准」compares it
/// against a manual page's `generated` at second precision); date-only lines written
/// by earlier archives stay as they are.
fn trace_block(change: &str, stamp: &str) -> String {
    format!("<!-- @trace\nsource: {change}\nupdated: {stamp}\n-->")
}

/// `actor` is the Host-resolved display identity — None stamps no archived_by.
pub fn archive(
    ws: &Workspace,
    store: &dyn Store,
    change: &Change,
    opts: &ArchiveOptions,
    actor: Option<&str>,
) -> Result<ArchiveOutcome> {
    // Environment gate, ahead of every file effect: a linked worktree is the
    // wrong place to archive from at all (see guard_linked_worktree).
    guard_linked_worktree(ws)?;

    // Fail-closed gate: archiving stamps and moves the metadata document —
    // refuse a corrupt one before any validation or file effect.
    crate::model::require_valid_meta(store, change)?;

    guard_open_tickets(store, &change.name, opts.carry_review, opts.carry_verify)?;

    // Task-readiness gate (spec「单笔封存的任务完成度守门」): an incomplete change
    // refuses to archive unless the --mark-tasks-complete flag rides along. The
    // exemption is the flag itself; the pre-write it implies lands below, after
    // every gate. Condition mirrors the bulk pre-filter: only total > 0 gates, a
    // zero-task change passes.
    if !opts.mark_tasks_complete {
        if let Some(TaskShortfall { complete, total }) = incomplete_tasks(store, &change.name) {
            return Err(crate::command::Refusal(format!(
                "change '{}' has {complete}/{total} tasks complete — archive refuses an \
                 incomplete change; complete the remaining tasks, or pass \
                 --mark-tasks-complete to check them all and archive",
                change.name
            ))
            .into());
        }
    }

    // 章失效守门（design D5）：任务守门之后、任何文件效果之前——任务未完成与
    // 章失效并存时，任务守门先拒且消息不变。
    guard_stale_stamps(ws, store, change)?;

    // One instant for the whole archive: the dated directory prefix and every
    // `@trace updated` stamp share it, so they never straddle midnight.
    let util::NowStamps { date, rfc3339: stamp } = util::now_stamps();
    let dated_name = format!("{date}-{}", change.name);
    if store.archived_change_exists(&dated_name) {
        bail!("Archived change '{}' already exists", dated_name);
    }

    // Single-change archive validates first: a structurally invalid change refuses to
    // archive unless --no-validate is passed. The error strings drop validate's
    // "Parse error: " prefix — that is the frozen rendering here. Structural only:
    // the merge gate below owns the refusal for a stale delta, and its aggregated
    // `merge_refusal` wording would never be reached if the pre-check refused first.
    if !opts.no_validate {
        let result = crate::validate::validate_change_structural(store, change, false);
        if !result.valid {
            let details: Vec<String> = result
                .errors
                .iter()
                .map(|e| e.replace(": Parse error: ", ": "))
                .collect();
            bail!("Validation failed:\n{}", details.join("\n"));
        }
    }

    // Evidence is reported, never judged (discussion evidence-gate-false-blocks):
    // read once here so the outcome carries the fact even though the change
    // directory moves out from under this path below.
    let evidence_recorded = !crate::tasks::TouchedRecord::load(store, &change.name).entries.is_empty();

    // --- Plan phase: read every capability, validate all of them, compute the merged
    // text. Nothing is written here, so a violation ends the archive with zero file
    // effect (spec archive-merge「两阶段合并计划与零半套写入」).
    let mut plans: Vec<CapPlan> = Vec::new();
    let mut violations: Vec<MergeViolation> = Vec::new();

    if !opts.skip_specs {
        for cap in store.delta_capabilities(&change.name) {
            let delta_rel = model::delta_spec_artifact(&cap);
            let delta_text = store.read_artifact(&change.name, &delta_rel).unwrap_or_default();
            // Even with --no-validate, apply time hard-fails on a delta that
            // parses to zero operations, leaving the change in place.
            if store.artifact_exists(&change.name, &delta_rel)
                && !model::has_delta_operation(&delta_text)
            {
                bail!(
                    "Failed to parse delta spec: Invalid format: Delta spec must contain \
at least one operation (ADDED, MODIFIED, REMOVED, or RENAMED)"
                );
            }

            // Read the pre-apply canonical once: it decides fresh-vs-merge, feeds the
            // merge, and is the snapshot backup content.
            let existing = store.read_canonical_spec(&cap);
            let found = capability_violations(&cap, &delta_text, existing.as_deref());
            if !found.is_empty() {
                // Keep reading the remaining capabilities: the refusal reports every
                // violation at once so one repair round clears them all.
                violations.extend(found);
                continue;
            }

            let (content, counts) =
                merge_capability(&cap, &change.name, &stamp, &delta_text, existing.as_deref());
            plans.push(CapPlan { capability: cap, counts, backup: existing, content });
        }
    }
    if !violations.is_empty() {
        return Err(merge_refusal(&change.name, &violations));
    }

    // --- 提交阶段的第一个效果：--mark-tasks-complete 的代勾。所有守门与纯读计划已过，
    // 从这一行起才有文件效果（spec change-lifecycle「单笔封存的任务完成度守门」、
    // 「封存的章失效守门」；archive-merge「两阶段合并计划与零半套写入」）。
    if opts.mark_tasks_complete {
        if let Some(text) = store.read_artifact(&change.name, "tasks.md") {
            // Star-bullet checkboxes are tasks too (frozen rule).
            let done = text
                .replace("- [ ] ", "- [x] ")
                .replace("- [ ]\t", "- [x]\t")
                .replace("* [ ] ", "* [x] ")
                .replace("* [ ]\t", "* [x]\t");
            store.write_artifact(&change.name, "tasks.md", &done)?;
        }
    }

    // --- Commit phase: snapshots first, then canonical specs, then the directory move.
    // A commit-phase I/O failure therefore always leaves a recoverable backup behind.
    //
    // A run with no workspace (an empty root: the Host over a store port) has no local
    // folder to back up into or clean up. There the store's one commit carries the
    // canonical specs and the move together, so a failure writes nothing and needs no
    // backup (host-runtime「没有 workspace 时封存不写入本机文件」).
    let local = ws.is_local();
    let snapshot_dir = ws.snapshots_dir().join(&dated_name);
    let mut snapshot_created = false;
    if local {
        for plan in &plans {
            if let Some(previous) = &plan.backup {
                // Back up the pre-apply canonical spec for unarchive support
                // (snapshots/<date>-<name>/specs/<cap>/spec.md holds the previous bytes).
                let backup_path =
                    snapshot_dir.join("specs").join(&plan.capability).join("spec.md");
                util::write_file(&backup_path, previous)
                    .map_err(|e| anyhow::anyhow!("Failed to backup spec: {e}"))?;
                snapshot_created = true;
            }
        }
        // Snapshot manifest: a bare array of created capability names, written only when
        // a spec was created (frozen byte-for-byte: `["cap-x"]`, no trailing newline).
        let created_specs: Vec<&String> =
            plans.iter().filter(|p| p.backup.is_none()).map(|p| &p.capability).collect();
        if !created_specs.is_empty() {
            util::write_file(
                &snapshot_dir.join("created_specs.json"),
                &serde_json::to_string(&created_specs)
                    .map_err(|e| anyhow::anyhow!("Failed to serialize created_specs: {e}"))?,
            )
            .map_err(|e| anyhow::anyhow!("Failed to write created_specs.json: {e}"))?;
            snapshot_created = true;
        }
    }
    // Where a failure says the backups are, when there are any.
    let backups = snapshot_created
        .then(|| format!("pre-archive backups are under {}", snapshot_dir.display()));
    for plan in &plans {
        // A mid-commit failure names the snapshot location (design risk table):
        // the pre-archive backups written above are the recovery path.
        store.write_canonical_spec(&plan.capability, &plan.content).map_err(|e| {
            let backups = backups.as_ref().map_or(String::new(), |b| format!(" — {b}"));
            anyhow::anyhow!("Failed to write canonical spec for '{}': {e}{backups}", plan.capability)
        })?;
    }
    let caps: Vec<CapCounts> = plans.into_iter().map(|p| p.counts).collect();

    // archived_at lands before the move (process-cost-metrics design D3), from the same
    // instant as the dated name. A failed move leaves it on the in-progress change; the
    // retry's `set` replaces it in place, so the document keeps one line. When canonical
    // specs were already written, a failure names the snapshot location too.
    crate::model::edit_meta(store, &change.name, |m| m.set("archived_at", &stamp)).map_err(|e| {
        let backups = backups.as_ref().map_or(String::new(), |b| format!("; {b}"));
        anyhow::anyhow!(
            "Failed to write archived_at for '{}': {e} — the change was not moved{backups}",
            change.name
        )
    })?;

    // Move change into the archive under its dated name. The in-progress marker
    // stays untouched on archive (frozen behavior).
    store.archive_change(&change.name, &dated_name)?;

    if local {
        // Clear the app-side "started" marker for this change, if present.
        let _ = util::remove_file(
            &ws.work_dir()
                .join("changes")
                .join(format!("{}.started", change.name)),
        );
        // The legacy touched record dies with the change: its fact was read into the
        // outcome above, and a leftover would be read back as evidence for a future
        // change reusing this name.
        let _ = util::remove_file(&ws.legacy_touched_file(&change.name));
    }

    // Stamp archived_by into the archived change metadata.
    if let (Some(id), Some(mut meta)) = (actor, store.read_archived_meta(&dated_name)) {
        if !meta.ends_with('\n') {
            meta.push('\n');
        }
        meta.push_str(&format!("archived_by: {id}\n"));
        store.write_archived_meta(&dated_name, &meta)?;
    }

    // A change promoted from (or linked to) a discussion carries its record along into the
    // archive — but only the last change to reference it, only once the discussion has a
    // written conclusion, and only without a `hold` flag: the one judgment lives in
    // `discuss::close_if_finished` (shared with the conclude closing step, so an in-flight
    // change whose meta fails to parse counts as still referencing on both paths). Each
    // source discussion is judged independently (`from_discussion` is a comma
    // accumulator). A failed archive step is skipped, not surfaced: the change itself is
    // already archived, and the record stays live for the next archive or `discuss
    // archive` to close. (This change was already moved above, so it no longer shows up
    // in list_changes.)
    let archived_discussions: Vec<(String, String)> = change
        .meta
        .from_discussions()
        .into_iter()
        .filter_map(|slug| {
            crate::discuss::close_if_finished(store, &slug)
                .ok()
                .flatten()
                .map(|file| (slug, file))
        })
        .collect();

    Ok(ArchiveOutcome {
        change_name: change.name.clone(),
        dated_name,
        caps,
        snapshot_created,
        skipped_specs: opts.skip_specs,
        archived_discussions,
        evidence_recorded,
    })
}

/// Parse a canonical spec into (header, requirement blocks). `header` is everything up to the
/// first `### Requirement:` (including the `## Requirements` line); each block is the full text of
/// a requirement (through its `@trace`), with `---` separators and surrounding blank lines stripped.
///
/// Public because the desktop manual reader (manual-pages「过期判定基准」的 Requirement 锚定)
/// needs the same one-and-only split rule; keeping it here means a heading-syntax change lands once.
pub fn parse_canonical(text: &str) -> (String, Vec<(String, String)>) {
    let marker = "### Requirement:";
    let split_at = text.find(marker).unwrap_or(text.len());
    let header = text[..split_at].to_string();
    let body = &text[split_at..];

    let mut blocks: Vec<(String, String)> = Vec::new();
    let mut name = String::new();
    let mut lines: Vec<String> = Vec::new();
    let flush = |name: &mut String, lines: &mut Vec<String>, blocks: &mut Vec<(String, String)>| {
        if lines.is_empty() {
            return;
        }
        // Strip trailing `---` separator and blank lines.
        while matches!(lines.last().map(|s| s.trim()), Some("") | Some("---")) {
            lines.pop();
        }
        blocks.push((std::mem::take(name), lines.join("\n")));
        lines.clear();
    };
    for line in body.lines() {
        if let Some(rest) = line.strip_prefix(marker) {
            flush(&mut name, &mut lines, &mut blocks);
            name = rest.trim().to_string();
        }
        lines.push(line.to_string());
    }
    flush(&mut name, &mut lines, &mut blocks);
    (header, blocks)
}

/// Strip the review-aid comments a delta block may carry — `<!-- BEFORE: … -->`
/// previous-value notes and `<!-- REMOVED-SCENARIO: … -->` removal declarations. Both
/// are for reviewers of the change and must not survive into the canonical spec.
fn strip_review_notes(block: &str) -> String {
    let is_note = |line: &str| {
        let t = line.trim_start();
        t.starts_with("<!-- BEFORE:") || t.starts_with(REMOVED_SCENARIO)
    };
    if !block.lines().any(is_note) {
        // No note: leave the block byte-identical (its spacing is preserved verbatim).
        return block.to_string();
    }
    let lines: Vec<&str> = block.lines().collect();
    let mut out: Vec<&str> = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        if is_note(lines[i]) {
            if lines[i].trim_start().starts_with(REMOVED_SCENARIO) {
                // A removal declaration is one line by contract (the gate refuses a
                // marker without its same-line `-->`), so strip exactly one line —
                // a multi-line scan here could swallow the rest of the block.
                i += 1;
            } else {
                // Skip to the end of the BEFORE comment (single- or multi-line) …
                while i < lines.len() && !lines[i].trim_end().ends_with("-->") {
                    i += 1;
                }
                i += 1;
            }
            // … and swallow one following blank only when the note sat between blanks
            // (avoiding a double gap). Right under a requirement header the blank after
            // the note is the header's own separator; keep it.
            let prev_blank = out.last().map(|l| l.trim().is_empty()).unwrap_or(false);
            if prev_blank && i < lines.len() && lines[i].trim().is_empty() {
                i += 1;
            }
            continue;
        }
        out.push(lines[i]);
        i += 1;
    }
    out.join("\n")
}

/// The merged canonical text plus this capability's operation counts. Pure: the caller
/// writes it in the commit phase, so the plan phase can be discarded without a trace.
/// Only operations the gate already cleared reach here.
fn merge_capability(
    cap: &str,
    change: &str,
    stamp: &str,
    delta_text: &str,
    existing: Option<&str>,
) -> (String, CapCounts) {
    let reqs = &parse_delta(delta_text);
    let renames = &model::rename_pairs(delta_text);
    // Every materialized ADDED/MODIFIED requirement gets the block — injection
    // no longer hinges on a file list that no longer exists.
    let trace = trace_block(change, stamp);
    let make_block = |r: &DeltaReq, fresh: bool| {
        let body = strip_review_notes(&r.block);
        if fresh {
            // A fresh canonical keeps the delta's own trailing spacing before @trace
            // (an inter-block blank line therefore yields two blanks — probed).
            format!("{body}\n\n{trace}")
        } else {
            // Merging into an existing canonical normalizes the gap by operation
            // (probed): MODIFIED gets 2 blanks, ADDED 1, regardless of delta spacing.
            let gap = if r.operation == "MODIFIED" { "\n\n\n" } else { "\n\n" };
            format!("{}{gap}{trace}", body.trim_end())
        }
    };
    let mut counts = CapCounts {
        capability: cap.to_string(),
        added: 0,
        modified: 0,
        removed: 0,
        renamed: 0,
    };

    let Some(existing) = existing else {
        // Fresh canonical: only ADDED reaches here — the gate refuses every other
        // operation against a capability the canon does not carry yet.
        let mut blocks: Vec<String> = Vec::new();
        for r in reqs {
            if r.operation == "ADDED" {
                blocks.push(make_block(r, true));
                counts.added += 1;
            }
        }
        let mut out = String::new();
        out.push_str(&format!("# {cap} Specification\n\n"));
        out.push_str("## Purpose\n\n");
        // 新正典的 Purpose 取自 delta 的同名区段（design「新 capability 的 Purpose
        // 自 delta 带入」）；`parse_delta` 不看这个区段，所以它从不影响操作解析。
        out.push_str(&match model::purpose_content(delta_text) {
            Some(purpose) => format!("{purpose}\n\n"),
            None => format!(
                "{} change '{change}'. Update Purpose after archive.\n\n",
                model::PURPOSE_TBD_PREFIX
            ),
        });
        out.push_str("## Requirements\n\n");
        let joined: Vec<String> = blocks.iter().map(|b| b.trim_end().to_string()).collect();
        out.push_str(&joined.join("\n\n---\n"));
        // The file ends with a newline UNLESS the last block ends with an @trace
        // comment (`-->`), which is written without one.
        if !out.ends_with('\n') && !out.ends_with("-->") {
            out.push('\n');
        }
        return (out, counts);
    };

    // Merge into an existing canonical spec.
    let (header, mut blocks) = parse_canonical(existing);
    // A removed requirement's text is spliced out but its preceding `---` stays; when the
    // LAST requirement is removed this leaves a dangling separator, reproduced below.
    let orig_last = blocks.last().map(|(n, _)| n.clone());
    for r in reqs {
        match r.operation.as_str() {
            "ADDED" => {
                // The gate guarantees the name is free — append and count it.
                blocks.push((r.name.clone(), make_block(r, false)));
                counts.added += 1;
            }
            "MODIFIED" => {
                // The gate guarantees the target exists.
                if let Some(slot) = blocks.iter_mut().find(|(n, _)| *n == r.name) {
                    slot.1 = make_block(r, false);
                    counts.modified += 1;
                }
            }
            "REMOVED" => {
                let before = blocks.len();
                blocks.retain(|(n, _)| *n != r.name);
                if blocks.len() != before {
                    counts.removed += 1;
                }
            }
            // RENAMED DeltaReqs (header form) are handled via `renames` below.
            _ => {}
        }
    }

    // Specseal divergence #4: RENAMED is actually executed — the canonical requirement
    // header is renamed in either documented syntax and counted under `renamed:`.
    for (from, to) in renames {
        if let Some(slot) = blocks.iter_mut().find(|(n, _)| n == from) {
            slot.1 = slot.1.replacen(
                &format!("### Requirement: {from}"),
                &format!("### Requirement: {to}"),
                1,
            );
            slot.0 = to.clone();
            counts.renamed += 1;
        }
    }

    let mut out = header;
    let joined: Vec<String> = blocks.iter().map(|(_, b)| b.trim_end().to_string()).collect();
    out.push_str(&joined.join("\n\n---\n"));
    // Dangling separator when the original last requirement was removed (frozen output shape).
    let last_removed = orig_last
        .map(|n| !blocks.iter().any(|(bn, _)| *bn == n))
        .unwrap_or(false);
    if last_removed && !blocks.is_empty() {
        out.push_str("\n\n---\n");
    }
    // Trailing newline: a merge that materialized no @trace (a pure REMOVED or
    // RENAMED delta never calls make_block) ends with the text-file newline;
    // once a trace was injected the file stays exactly as joined — no newline
    // even when the last requirement is not the traced one. Never one after
    // `-->`, even when the tail trace came from an earlier archive.
    if counts.added == 0 && counts.modified == 0 && !out.ends_with('\n') && !out.ends_with("-->") {
        out.push('\n');
    }
    (out, counts)
}

#[cfg(test)]
mod tests;
