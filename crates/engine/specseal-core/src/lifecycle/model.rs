//! Change discovery, metadata, and artifact status.

use crate::keylines::KeyLines;
use crate::schema::{Artifact, Schema};
use crate::station::{Stamp, StampAnchors, Station, StationId};
use crate::store::Store;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// The per-change data file inside every change directory, active or archived.
pub const META_FILE: &str = ".meta.yaml";
/// The data file's name before the rename — read only when [`META_FILE`] is
/// absent, never written.
pub const LEGACY_META_FILE: &str = ".openspec.yaml";
/// The order every reader tries the data file's names in. Remote data is never
/// re-keyed, so archives written before the rename are reached the same way.
pub const META_READ_ORDER: [&str; 2] = [META_FILE, LEGACY_META_FILE];

/// `.meta.yaml` — per-change metadata. 建构要经过时间字段收敛：文本走
/// [`ChangeMeta::from_text`]、已结构化的字段走 [`ChangeMeta::from_fields`]。
/// `#[non_exhaustive]` 让 core 以外的字面值建构编译不过；`Default` 只当读档失败时
/// 的空白后备，不在它上面逐栏填值。
#[derive(Debug, Clone, Default, Deserialize)]
#[non_exhaustive]
pub struct ChangeMeta {
    pub schema: Option<String>,
    /// 创建日期。写入的是 RFC 3339 时戳，解析时收敛成日期部分——对外输出点直接
    /// 拿来用（process-cost-metrics design D2）；完整时戳只有流程成本
    /// （lifecycle/cost.rs）逐键读原文取得。
    pub created: Option<String>,
    pub created_by: Option<String>,
    #[serde(default)]
    pub created_with: Option<String>,
    /// Slug of the discussion this change was promoted from (specseal extension).
    #[serde(default)]
    pub from_discussion: Option<String>,
    /// Discussions this change reflected (sealed) that were later re-concluded, so the
    /// change is stale relative to the new conclusion and needs re-ingest (specseal
    /// extension). Comma-separated slug accumulator: written by `discuss conclude` when
    /// it re-concludes an already-reflected discussion, cleared per-slug by `discuss
    /// seal`. Absent reads as empty — nothing pending.
    #[serde(default)]
    pub restale_from: Option<String>,
    /// The "started" lifecycle station (stamped by `in-progress add`). Absent
    /// on pre-migration metadata — such a change simply reads as not started.
    #[serde(default)]
    pub started_at: Option<String>,
    #[serde(default)]
    pub started_by: Option<String>,
    #[serde(default)]
    pub started_with: Option<String>,
    /// 认领标记（`claim` 于团队模式 store 盖章；remote-claim-ownership D1）。
    /// 与 started_* 同居 change meta：缺席即未认领，旧版读者忽略。
    #[serde(default)]
    pub claimed_by: Option<String>,
    #[serde(default)]
    pub claimed_at: Option<String>,
    /// 看板栏内排序键（specseal 桌面延伸；desktop-card-reorder）。缺席＝未排序，
    /// 卡片置栏顶、回退现行排序。ChangeMeta 仅 Deserialize，CLI 输出不受影响。
    #[serde(default)]
    pub board_rank: Option<String>,
    /// 声明前置 change 名的逗号清单（change-plan design D2）。缺席读作无依赖；
    /// 只由 `change depends` 经 `KeyLines` 清单手术写入，CLI 的 list／status
    /// 输出不含此字段。
    #[serde(default)]
    pub depends_on: Option<String>,
    /// The "reviewed" quality station（`review stamp` 盖章；design D3）。全部
    /// `#[serde(default)]`——缺席读作未审查，pre-migration metadata 照常解析。
    #[serde(default)]
    pub reviewed_at: Option<String>,
    #[serde(default)]
    pub reviewed_by: Option<String>,
    #[serde(default)]
    pub reviewed_with: Option<String>,
    /// 任务锚：盖章时任务总数。
    #[serde(default)]
    pub reviewed_tasks_total: Option<usize>,
    /// 内容指纹锚：范围档 path＋hash 清单（缺席读作空）。
    #[serde(default)]
    pub reviewed_scope: Vec<ReviewedScopeEntry>,
    /// 盖章时调用端回报的 commit（station-status-and-landing D3）。引擎只存不查，
    /// 章的冻结判定不看它；它和章的其他字段同进退。
    #[serde(default)]
    pub reviewed_commit: Option<String>,
    /// 历次盖章累加的审查回合数（process-cost-metrics D1）。不是非负整数时整份
    /// meta 解析失败——盖章走 fail-closed 拒绝。
    #[serde(default)]
    pub reviewed_rounds: Option<u64>,
    /// The "verified" quality station（`verify stamp` 盖章；design D2）。与
    /// `reviewed_*` 同形、同锚、同失效规则，两站互不屏蔽；全部
    /// `#[serde(default)]`——缺席读作未验证，pre-migration metadata 照常解析。
    #[serde(default)]
    pub verified_at: Option<String>,
    #[serde(default)]
    pub verified_by: Option<String>,
    #[serde(default)]
    pub verified_with: Option<String>,
    /// 任务锚：盖章时任务总数。
    #[serde(default)]
    pub verified_tasks_total: Option<usize>,
    /// 内容指纹锚：范围档 path＋hash 清单（缺席读作空）。
    #[serde(default)]
    pub verified_scope: Vec<ReviewedScopeEntry>,
    /// 验证盖章时调用端回报的 commit；与 `reviewed_commit` 同规则。
    #[serde(default)]
    pub verified_commit: Option<String>,
    /// 历次盖章累加的验证回合数；与 `reviewed_rounds` 同规则。
    #[serde(default)]
    pub verified_rounds: Option<u64>,
    /// 这个变更所在的分支（station-status-and-landing D4）：开工时由调用端回报，
    /// `change landed --branch` 会覆写。引擎不读 git，也不检查它是否存在。
    #[serde(default)]
    pub branch: Option<String>,
    /// 落地记录（station-status-and-landing D5）：`change landed` 回报的 commit、回报的
    /// 时间（RFC 3339 原文，不收敛成日期）与回报的人。引擎只存，不依它们做任何判断。
    #[serde(default)]
    pub landed_commit: Option<String>,
    #[serde(default)]
    pub landed_at: Option<String>,
    #[serde(default)]
    pub landed_by: Option<String>,
    /// 自由字段（host-free-fields D2）：`fields` 区块的内容，宽松读取。不经 serde——
    /// 区块里不是纯量的项目要略过而不是让整份文档解析失败，数字要照字面读。引擎只存，
    /// 不依它做任何判断。
    #[serde(skip)]
    pub fields: crate::fields::Fields,
    // `archived_at`（封存时戳）刻意不是字段：只有流程成本读它、逐键读原文，旧版在
    // 残留值之后再追加一行时也不会让整份 meta 因重复键解析失败。
}

/// `reviewed_scope` 清单项：path 为 repo-root 相对、`/` 分隔（Windows 路径
/// 范式后写入）；hash 为内容 CRLF→LF 范式后的 SHA-256（design D3）。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct ReviewedScopeEntry {
    pub path: String,
    pub hash: String,
}

impl ChangeMeta {
    /// Parse a raw metadata document. A missing (or empty/null) document yields
    /// the defaults; a document that exists but cannot parse → `Err` with the
    /// parser's reason (fail-closed, never defaults). Store implementations
    /// carry that reason as [`Change::meta_error`] so listing never breaks.
    pub fn from_text(text: Option<&str>) -> Result<ChangeMeta, String> {
        let Some(s) = text else {
            return Ok(ChangeMeta::default());
        };
        let mut meta: ChangeMeta = crate::config::parse_lenient_or_reason(s)?;
        meta.fields = crate::fields::read(&KeyLines::whole(s));
        meta.collapse_time_fields();
        Ok(meta)
    }

    /// 由已结构化的字段（SDK store bridge、remote drift）组一份 meta：`fill` 填字段，
    /// 收尾时跑与 [`Self::from_text`] 同一道时间字段收敛。`ChangeMeta` 带
    /// `#[non_exhaustive]`，core 以外不能用字面值建构；从 `default()` 逐栏填值会
    /// 跳过收敛，填字段一律走这里。
    pub fn from_fields(fill: impl FnOnce(&mut ChangeMeta)) -> ChangeMeta {
        let mut meta = ChangeMeta::default();
        fill(&mut meta);
        meta.collapse_time_fields();
        meta
    }

    /// Time fields written as RFC 3339 stamps collapse to their date part, so every
    /// output point keeps emitting `YYYY-MM-DD` (process-cost-metrics design D2);
    /// plain dates and unrecognised values stay verbatim. Idempotent.
    fn collapse_time_fields(&mut self) {
        let time_fields = [
            &mut self.created,
            &mut self.started_at,
            &mut self.claimed_at,
            &mut self.reviewed_at,
            &mut self.verified_at,
        ];
        for value in time_fields.into_iter().flatten() {
            if chrono::DateTime::parse_from_rfc3339(value).is_ok() {
                value.truncate(10);
            }
        }
    }
    pub fn schema_name(&self) -> String {
        self.schema
            .clone()
            .unwrap_or_else(|| "spec-driven".to_string())
    }

    /// 一个品质站的章在这份 meta 里的全部字段（lifecycle-station-anchors D1）：「这个站的
    /// 章住在哪些字段」只有这一份映射。对 `StationId` 穷举 match——第三站来时漏补臂是
    /// 编译错误，不会静默读到空章。
    pub fn stamp(&self, st: &Station) -> Stamp<'_> {
        match st.id {
            StationId::Review => Stamp {
                at: self.reviewed_at.as_deref(),
                by: self.reviewed_by.as_deref(),
                with: self.reviewed_with.as_deref(),
                tasks_total: self.reviewed_tasks_total,
                rounds: self.reviewed_rounds,
                commit: self.reviewed_commit.as_deref(),
                scope: &self.reviewed_scope,
            },
            StationId::Verify => Stamp {
                at: self.verified_at.as_deref(),
                by: self.verified_by.as_deref(),
                with: self.verified_with.as_deref(),
                tasks_total: self.verified_tasks_total,
                rounds: self.verified_rounds,
                commit: self.verified_commit.as_deref(),
                scope: &self.verified_scope,
            },
        }
    }

    /// 章的三个锚（冻结判定与「是否已盖章」的原料），取自 [`Self::stamp`]。
    pub fn anchors(&self, st: &Station) -> StampAnchors<'_> {
        self.stamp(st).anchors()
    }

    /// 一个品质站历次盖章累加的回合数（process-cost-metrics D1），取自 [`Self::stamp`]。
    pub fn stamp_rounds(&self, st: &Station) -> Option<u64> {
        self.stamp(st).rounds
    }

    /// The discussions this change was promoted from or linked to. `from_discussion`
    /// is a comma-separated accumulator (mirroring the discussion side's `promoted_to`)
    /// so a change can carry several source discussions — the first entry is its
    /// originating discussion. A single value is the degenerate one-element list;
    /// absent reads as empty.
    pub fn from_discussions(&self) -> Vec<String> {
        comma_list(self.from_discussion.as_deref())
    }

    /// The discussions this change reflected then went stale against (re-concluded after
    /// seal), read from the `restale_from` comma accumulator. Mirrors [`from_discussions`]:
    /// a single value is the one-element list, absent reads as empty.
    pub fn restale_from(&self) -> Vec<String> {
        comma_list(self.restale_from.as_deref())
    }

    /// The changes this one declares as prerequisites, read from the `depends_on`
    /// comma list the way [`restale_from`] reads its accumulator: split, trim, drop
    /// empties; absent reads as empty. The list is the meta's verbatim declaration —
    /// whether an entry is still active is the plan module's call.
    pub fn depends_on(&self) -> Vec<String> {
        comma_list(self.depends_on.as_deref())
    }
}

/// A comma-list accumulator field as its entries: split on `,`, trim, drop
/// empties; an absent field reads as empty.
fn comma_list(value: Option<&str>) -> Vec<String> {
    value
        .map(|v| {
            v.split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// Workspace-relative display path of `change`'s data file `file` under `spec_dir`.
pub fn change_meta_file(spec_dir: &str, change: &str, file: &str) -> String {
    format!("{spec_dir}/changes/{change}/{file}")
}

/// A change's `.meta.yaml` exists but cannot be parsed. Fail-closed
/// (design 决策二): every flow that reads or writes the change's metadata
/// semantics refuses with this error instead of proceeding on defaults.
/// Display mirrors [`crate::config::ConfigError`] (`invalid <path>: <reason>`);
/// the command layer maps it to `invalid_config`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MetaError {
    pub change: String,
    /// Workspace-relative display path of the broken metadata document.
    pub file: String,
    /// Parse-failure reason as reported by the YAML parser.
    pub reason: String,
}

impl MetaError {
    /// The error for `change`'s data file in `store`.
    pub fn new(store: &dyn Store, change: &str, reason: String) -> MetaError {
        MetaError {
            change: change.to_string(),
            file: store.change_meta_display(change),
            reason,
        }
    }
}

impl std::fmt::Display for MetaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "invalid {}: {}", self.file, self.reason)
    }
}

impl std::error::Error for MetaError {}

/// The fail-closed gate shared by every flow that holds a resolved [`Change`]:
/// corrupt metadata refuses with [`MetaError`], valid or absent metadata passes.
pub fn require_valid_meta(store: &dyn Store, change: &Change) -> Result<(), MetaError> {
    match &change.meta_error {
        Some(reason) => Err(MetaError::new(store, &change.name, reason.clone())),
        None => Ok(()),
    }
}

/// Text-level twin of [`require_valid_meta`] for flows that operate on the raw
/// metadata document (text surgery paths): existing-but-unparsable text refuses
/// with [`MetaError`]; missing text keeps its default semantics and passes. The
/// parsed metadata comes back for callers that also read it.
pub fn check_meta_text(
    store: &dyn Store,
    change: &str,
    text: Option<&str>,
) -> Result<ChangeMeta, MetaError> {
    ChangeMeta::from_text(text).map_err(|reason| MetaError::new(store, change, reason))
}

/// A discovered change.
#[derive(Debug, Clone)]
pub struct Change {
    pub name: String,
    /// Display location of the change's documents (rendered in payloads and
    /// human output; content access goes through the [`Store`]).
    pub dir: PathBuf,
    pub meta: ChangeMeta,
    /// Parse-failure reason when `.meta.yaml` exists but is corrupt — the
    /// change is listed with default `meta` for display, and every verb that
    /// needs metadata semantics must refuse (fail-closed). `None` = valid or
    /// absent metadata.
    pub meta_error: Option<String>,
}

/// List active changes, sorted by name.
pub fn list_changes(store: &dyn Store) -> Vec<Change> {
    store.list_changes()
}

/// A change's lifecycle stage as the board and the plan see it (change-plan
/// design D7) — one rule for every consumer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Stage {
    /// Every task checked (and there is at least one): closest to archive.
    Ready,
    /// Started (a `started_at` stamp) or any task checked — the fallback covers
    /// tasks.md edits that bypassed the verbs.
    InProgress,
    /// Neither.
    Proposed,
}

impl Stage {
    /// Every stage once — the exhaustive match below stops the build when a
    /// variant is added, so neither this list nor [`Stage::parse`] can miss it.
    const ALL: [Stage; 3] = [Stage::Ready, Stage::InProgress, Stage::Proposed];

    /// The plan payload's `stage` string.
    pub fn as_str(&self) -> &'static str {
        match self {
            Stage::Ready => "ready",
            Stage::InProgress => "in-progress",
            Stage::Proposed => "proposed",
        }
    }

    /// The inverse of [`Stage::as_str`] — the string table stays in `as_str`
    /// alone; `None` for any other string, so a caller reading the plan payload
    /// from elsewhere decides how to report it.
    pub fn parse(s: &str) -> Option<Stage> {
        Stage::ALL.into_iter().find(|stage| stage.as_str() == s)
    }
}

// A new `Stage` variant fails to compile here: add it to `Stage::ALL` as well.
const _: () = match Stage::Ready {
    Stage::Ready | Stage::InProgress | Stage::Proposed => (),
};

/// The plan payload carries the stage as its string form — one source for
/// `as_str` and the wire (`"ready"` / `"in-progress"` / `"proposed"`).
impl serde::Serialize for Stage {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.as_str())
    }
}

/// Derive a change's [`Stage`] from its task counts and started stamp — the
/// same rule the desktop board's column derivation uses.
pub fn stage(store: &dyn Store, change: &Change) -> Stage {
    let (complete, total) = crate::listing::task_counts(store, change);
    if total > 0 && complete >= total {
        Stage::Ready
    } else if change.meta.started_at.is_some() || complete > 0 {
        Stage::InProgress
    } else {
        Stage::Proposed
    }
}

/// 编辑一个 change 的 meta 文档：读原文 → fail-closed 解析 → 套 `edit` 闭包做
/// `KeyLines` 手术 → 文本有变才回写（其余字节逐字保留，永不重新串行化）。
///
/// - `Ok(None)`：change 没有 meta 文档——「不存在」的消息与静默语意留给调用端。
/// - `Err(MetaError)`：文档存在但解析失败，零写入（可 `downcast_ref` 分辨）。
/// - 闭包 `Err` 原样传出，零写入；闭包没改任何行时也零写入（幂等路径）。
///
/// 名称单一路径段的守卫也留在调用端：各动词对非法名称的消息不同。
pub fn edit_meta<T>(
    store: &dyn Store,
    name: &str,
    edit: impl FnOnce(&mut KeyLines) -> anyhow::Result<T>,
) -> anyhow::Result<Option<T>> {
    let Some(meta) = store.read_change_meta(name) else {
        return Ok(None);
    };
    check_meta_text(store, name, Some(&meta))?;
    let mut lines = KeyLines::whole(&meta);
    let out = edit(&mut lines)?;
    let edited = lines.text();
    if edited != meta {
        store.write_change_meta(name, &edited)?;
    }
    Ok(Some(out))
}

/// 写入（或原位更新）一个 change 的看板排序键 `board_rank`；其余字段逐字节
/// 保留。非法 rank、非单一路径段名称、change 不存在皆回明确错误。
pub fn set_board_rank(store: &dyn Store, name: &str, rank: &str) -> anyhow::Result<()> {
    if !crate::util::is_valid_board_rank(rank) {
        anyhow::bail!("invalid board rank '{rank}' — lowercase ASCII letters only");
    }
    // 同 in-progress add 的防护：名称必须是单一路径段，否则可能经 raw 读写对
    // 触及 changes/ 外的 metadata 文档。
    if name.contains(['/', '\\', ':']) || name.contains("..") {
        anyhow::bail!("invalid change name: {name}");
    }
    if edit_meta(store, name, |m| m.set("board_rank", rank))?.is_none() {
        anyhow::bail!("change not found: {name}");
    }
    Ok(())
}

/// 调用端回报的 commit（盖章、落地回报）：去掉前后空白后是 7 到 64 个十六进位字符，
/// 否则是调用端参数错误。只看形状——引擎没有 repo，不查它是否存在。
pub fn checked_commit(raw: &str) -> anyhow::Result<String> {
    let commit = raw.trim();
    if !(7..=64).contains(&commit.len()) || !commit.bytes().all(|b| b.is_ascii_hexdigit()) {
        anyhow::bail!(crate::command::InvalidContent(format!(
            "invalid commit {raw:?} — expected 7 to 64 hexadecimal characters"
        )));
    }
    Ok(commit.to_string())
}

/// 调用端回报的分支名称（开工、落地回报）：1 到 255 个字符、不含控制字符与空白，
/// 而且 metadata 存得进去；否则是调用端参数错误。只看名称本身，不查分支是否存在。
pub fn checked_branch(raw: &str) -> anyhow::Result<&str> {
    let chars = raw.chars().count();
    if !(1..=255).contains(&chars) || raw.chars().any(|c| c.is_control() || c.is_whitespace()) {
        anyhow::bail!(crate::command::InvalidContent(format!(
            "invalid branch {raw:?} — expected 1 to 255 characters with no whitespace or control characters"
        )));
    }
    // 形状合格的名称 YAML 不一定带得了（U+FFFE 读回来是别的字，整份文档从此解析不了）：
    // 照写入的样子写一次，读不回同一个字符串就拒绝。
    let stored = format!("{}: {}\n", crate::inprogress::BRANCH_KEY, crate::util::yaml_roundtrip_scalar(raw));
    if !ChangeMeta::from_text(Some(&stored)).is_ok_and(|meta| meta.branch.as_deref() == Some(raw)) {
        anyhow::bail!(crate::command::InvalidContent(format!(
            "invalid branch {raw:?} — the change's metadata cannot record it"
        )));
    }
    Ok(raw)
}

/// Find an active change by name. A name that cannot be a change's name is
/// never looked up ([`is_change_name`]).
pub fn find_change(store: &dyn Store, name: &str) -> Option<Change> {
    if !is_change_name(name) {
        return None;
    }
    store.find_change(name)
}

/// Whether `name` can be a change's name at all: one path segment that is not
/// a dot name and not `archive`, the name the archive itself has among the
/// changes. A store may find a change by probing a directory; such a store
/// would answer `..` with the folder above the changes, `archive` with the
/// archive, and `archive/<name>` with an archived change read as an active one.
fn is_change_name(name: &str) -> bool {
    !matches!(name, "" | "." | ".." | "archive") && !name.contains(['/', '\\'])
}

/// Where a change name leads.
pub enum Located {
    Active(Change),
    /// The archived name.
    Archived(String),
}

/// Find `name`: the active change of that name, else the archived change the
/// name stands for ([`archived_change_name`]). The archive is only looked at
/// when no active change has the name.
pub fn locate_change(store: &dyn Store, name: &str) -> Option<Located> {
    if !is_change_name(name) {
        return None;
    }
    match find_change(store, name) {
        Some(change) => Some(Located::Active(change)),
        None => archived_change_name(store, name).map(Located::Archived),
    }
}

/// The archived name `name` stands for:
///
/// - an archived name with its date, given as it is → that archived change;
/// - else a change's own name → its newest archive (`<date>-<name>`; the
///   dates sort as text, so the greatest is the newest);
/// - else an older archive that holds the change under its bare name.
pub fn archived_change_name(store: &dyn Store, name: &str) -> Option<String> {
    use crate::util::strip_date_prefix;
    let archived = store.list_archived_changes();
    let exact = || archived.iter().any(|dated| dated == name).then(|| name.to_string());
    if strip_date_prefix(name) != name {
        if let Some(found) = exact() {
            return Some(found);
        }
    }
    archived
        .iter()
        .filter(|dated| dated.as_str() != name && strip_date_prefix(dated) == name)
        .max()
        .cloned()
        .or_else(exact)
}

/// Whether an artifact's output exists and has content.
pub fn artifact_done(store: &dyn Store, change: &str, artifact: &Artifact) -> bool {
    // Done-ness is EXISTS-based — an empty file counts (frozen rule). A glob-style output
    // (e.g. "specs/**/*.md") is done when any matching delta spec exists.
    if artifact.output_path.contains("**") {
        return !store.delta_capabilities(change).is_empty();
    }
    store.artifact_exists(change, &artifact.output_path)
}

/// The artifact identifier of a capability's delta spec inside a change.
pub fn delta_spec_artifact(cap: &str) -> String {
    format!("specs/{cap}/spec.md")
}

/// Number of `### Requirement:` declarations under an ADDED/MODIFIED/REMOVED section. A RENAMED
/// section (FROM:/TO:) and empty operation headers contribute zero — a delta spec must
/// contain at least one applied operation.
pub fn op_requirement_count(text: &str) -> usize {
    let mut op = "";
    let mut count = 0;
    for line in text.lines() {
        let t = line.trim_start();
        if let Some(rest) = t.strip_prefix("## ") {
            if rest.trim_end().ends_with("Requirements") {
                op = rest.split_whitespace().next().unwrap_or("");
            }
        } else if t.starts_with("### Requirement:")
            && matches!(op, "ADDED" | "MODIFIED" | "REMOVED")
        {
            count += 1;
        }
    }
    count
}

/// A line-start `### Requirement:` that is not under an ADDED/MODIFIED/REMOVED section (a malformed
/// delta — requirement declared with no operation heading).
pub fn has_orphan_requirement(text: &str) -> bool {
    let mut op = "";
    for line in text.lines() {
        let t = line.trim_start();
        if let Some(rest) = t.strip_prefix("## ") {
            if rest.trim_end().ends_with("Requirements") {
                op = rest.split_whitespace().next().unwrap_or("");
            }
        } else if t.starts_with("### Requirement:") && !matches!(op, "ADDED" | "MODIFIED" | "REMOVED") {
            return true;
        }
    }
    false
}

/// Whether a delta spec body has an applicable operation (ADDED/MODIFIED/REMOVED with a requirement).
pub fn has_delta_operation(text: &str) -> bool {
    // Specseal divergence #4: a RENAMED section with at least one valid FROM/TO pair
    // counts as an operation, so a pure-rename delta validates and archives.
    op_requirement_count(text) > 0 || !rename_pairs(text).is_empty()
}

/// Purpose 内容的最低字符门槛（design D1）。长度以字符计（`chars().count()`，
/// 非 bytes）——中文 Purpose 不因 UTF-8 多字节被高估。
pub const MIN_PURPOSE_LENGTH: usize = 50;

/// archive 创建新正式规格时、delta 未提供 Purpose 所写入的占位文案前缀
/// （design D5）。占位产生器、正式规格验证与桌面清单的占位侦测共用这一份。
pub const PURPOSE_TBD_PREFIX: &str = "TBD - created by archiving";

/// Purpose 不合格的两种样态（design D1）。合格＝`purpose_defect` 回 `None`。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PurposeDefect {
    /// 缺 `## Purpose` 区段，或区段存在但内容为空。
    Missing,
    /// 内容非空但不足 [`MIN_PURPOSE_LENGTH`]，带实际字符数。
    TooShort(usize),
}

impl PurposeDefect {
    /// 供守门消息逐字转载的原因句（archive 违规列与 validate 错误共用一份措辞）。
    pub fn reason(&self) -> String {
        match self {
            PurposeDefect::Missing => {
                "no `## Purpose` section, or its content is empty".to_string()
            }
            PurposeDefect::TooShort(n) => format!(
                "Purpose content is {n} characters — below the \
{MIN_PURPOSE_LENGTH}-character minimum"
            ),
        }
    }
}

/// A spec document's own `## Purpose` section content, trimmed — `None` when the
/// section is absent or holds nothing but whitespace. The section ends at the next
/// `## ` heading, so an operation section never leaks into it.
pub fn purpose_content(text: &str) -> Option<String> {
    let normalized = text.replace("\r\n", "\n");
    let mut body: Vec<&str> = Vec::new();
    let mut inside = false;
    for line in normalized.lines() {
        if let Some(rest) = line.trim_start().strip_prefix("## ") {
            if inside {
                break;
            }
            inside = rest.trim() == "Purpose";
            continue;
        }
        if inside {
            body.push(line);
        }
    }
    let content = body.join("\n").trim().to_string();
    (!content.is_empty()).then_some(content)
}

/// 合格判准的单一定义（design D1）：存在 `## Purpose` 区段、内容非空、且
/// trim 后达 [`MIN_PURPOSE_LENGTH`] 字符。change 验证的早期检查、封存守门与
/// 正式规格验证都问这一个函数，不合格的定义只有一份。
pub fn purpose_defect(text: &str) -> Option<PurposeDefect> {
    match purpose_content(text) {
        None => Some(PurposeDefect::Missing),
        Some(content) => {
            let len = content.chars().count();
            (len < MIN_PURPOSE_LENGTH).then_some(PurposeDefect::TooShort(len))
        }
    }
}

/// Rename pairs from `## RENAMED Requirements` sections (specseal divergence #4 —
/// renames are actually applied). Both documented syntaxes:
/// - bullet form: `- FROM: `### Requirement: Old`` / `- TO: `### Requirement: New``
///   (bold markers and bare names accepted)
/// - header form: `### Requirement: Old` followed by a `TO: New` line
pub fn rename_pairs(text: &str) -> Vec<(String, String)> {
    rename_scan(text).0
}

/// Rename sources that never pair with a TO: target — an orphan FROM (bullet or header
/// form), a FROM overwritten by the next one, or a TO with an empty value. The archive
/// merge gate refuses these instead of silently dropping the operation.
pub fn rename_dangling_sources(text: &str) -> Vec<String> {
    rename_scan(text).1
}

/// One pass over the RENAMED sections: completed (from, to) pairs plus the sources
/// that fell through unpaired.
fn rename_scan(text: &str) -> (Vec<(String, String)>, Vec<String>) {
    fn req_name(raw: &str) -> String {
        let s = raw.trim().trim_matches('`').trim();
        s.strip_prefix("### Requirement:").map(str::trim).unwrap_or(s).to_string()
    }
    let mut pairs = Vec::new();
    let mut dangling = Vec::new();
    let mut in_renamed = false;
    let mut from: Option<String> = None;
    for line in text.lines() {
        let t = line.trim_start();
        if let Some(rest) = t.strip_prefix("## ") {
            if rest.trim_end().ends_with("Requirements") {
                in_renamed = rest.split_whitespace().next() == Some("RENAMED");
                dangling.extend(from.take());
                continue;
            }
        }
        if !in_renamed {
            continue;
        }
        if let Some(name) = t.strip_prefix("### Requirement:") {
            dangling.extend(from.replace(name.trim().to_string()));
            continue;
        }
        let norm = t.trim().trim_start_matches("- ").replace("**", "");
        if let Some(v) = norm.strip_prefix("FROM:") {
            let v = req_name(v);
            if !v.is_empty() {
                dangling.extend(from.replace(v));
            }
        } else if let Some(v) = norm.strip_prefix("TO:") {
            let v = req_name(v);
            match (from.take(), v.is_empty()) {
                (Some(f), false) => pairs.push((f, v)),
                (Some(f), true) => dangling.push(f),
                (None, _) => {}
            }
        }
    }
    dangling.extend(from);
    (pairs, dangling)
}

/// DAG status of a single artifact.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArtifactStatus {
    Done,
    Ready,
    Blocked,
}

impl ArtifactStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            ArtifactStatus::Done => "done",
            ArtifactStatus::Ready => "ready",
            ArtifactStatus::Blocked => "blocked",
        }
    }
}

/// Compute the status of every artifact in the schema for a change.
pub fn artifact_statuses(schema: &Schema, store: &dyn Store, change: &str) -> Vec<(String, ArtifactStatus)> {
    // First pass: done-ness.
    let mut done: std::collections::HashMap<&str, bool> = std::collections::HashMap::new();
    for a in &schema.artifacts {
        done.insert(a.id.as_str(), artifact_done(store, change, a));
    }
    // Second pass: ready/blocked based on requires.
    let mut out = Vec::new();
    for a in &schema.artifacts {
        let status = if *done.get(a.id.as_str()).unwrap_or(&false) {
            ArtifactStatus::Done
        } else if a.requires.iter().all(|r| *done.get(r.as_str()).unwrap_or(&false)) {
            ArtifactStatus::Ready
        } else {
            ArtifactStatus::Blocked
        };
        out.push((a.id.clone(), status));
    }
    out
}

/// Which artifact ids block a given artifact (unmet requires).
pub fn blocked_by(schema: &Schema, store: &dyn Store, change: &str, id: &str) -> Vec<String> {
    let Some(a) = schema.artifact(id) else {
        return Vec::new();
    };
    a.requires
        .iter()
        .filter(|r| {
            schema
                .artifact(r)
                .map(|ra| !artifact_done(store, change, ra))
                .unwrap_or(false)
        })
        .map(|s| s.to_string())
        .collect()
}

/// Whether EVERY artifact in the schema is done (an absent optional artifact
/// such as `design` keeps the change incomplete).
pub fn is_complete(schema: &Schema, store: &dyn Store, change: &str) -> bool {
    schema
        .artifacts
        .iter()
        .all(|a| artifact_done(store, change, a))
}

/// Artifacts in the schema that are not yet done (used for analyze "Missing" reporting).
pub fn missing_artifacts(schema: &Schema, store: &dyn Store, change: &str) -> Vec<String> {
    schema
        .artifacts
        .iter()
        .filter(|a| !artifact_done(store, change, a))
        .map(|a| a.id.to_string())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::ChangeMeta;
    use crate::store::Store;
    use crate::teststore::TestStore;

    // --- the lookup of a change by name ---

    fn archive_of(names: &[&str]) -> TestStore {
        let store = TestStore::default();
        for name in names {
            store.archived_metas.borrow_mut().insert(name.to_string(), "schema: spec-driven\n".to_string());
        }
        store
    }

    #[test]
    fn find_change_never_looks_up_a_name_that_is_no_change_name() {
        // This double answers for every name it holds, as a store that probes
        // a directory would for `..` or `archive/<name>`.
        let store = TestStore::default();
        for name in ["..", ".", "", "archive", "archive/2026-11-12-demo", "demo/../other", "a\\b", "../discussions"] {
            store.metas.borrow_mut().insert(name.to_string(), "schema: spec-driven\n".to_string());
            assert!(super::find_change(&store, name).is_none(), "{name:?}");
            assert!(super::locate_change(&store, name).is_none(), "{name:?}");
        }
        store.metas.borrow_mut().insert("demo".to_string(), "schema: spec-driven\n".to_string());
        assert_eq!(super::find_change(&store, "demo").map(|c| c.name).as_deref(), Some("demo"));
        // A name that only looks like the reserved one is a name like any other.
        store.metas.borrow_mut().insert("archive-tools".to_string(), "schema: spec-driven\n".to_string());
        assert!(super::find_change(&store, "archive-tools").is_some());
    }

    #[test]
    fn a_changes_own_name_stands_for_its_newest_archive() {
        let store = archive_of(&["2026-10-01-demo", "2026-11-12-demo", "2026-11-30-other", "2026-01-01-foo-demo"]);
        assert_eq!(super::archived_change_name(&store, "demo").as_deref(), Some("2026-11-12-demo"));
        assert_eq!(super::archived_change_name(&store, "2026-10-01-demo").as_deref(), Some("2026-10-01-demo"));
        assert_eq!(super::archived_change_name(&store, "ghost"), None);
        // Only the date goes: `foo-demo` is another change.
        assert_eq!(super::archived_change_name(&store, "foo-demo").as_deref(), Some("2026-01-01-foo-demo"));
    }

    #[test]
    fn a_dated_archive_is_newer_than_an_older_one_under_the_bare_name() {
        // As text, `demo` sorts after every dated name; it is still the older one.
        let store = archive_of(&["demo", "2026-11-12-demo"]);
        assert_eq!(super::archived_change_name(&store, "demo").as_deref(), Some("2026-11-12-demo"));
        // With no dated archive, the bare name is what there is.
        let store = archive_of(&["demo"]);
        assert_eq!(super::archived_change_name(&store, "demo").as_deref(), Some("demo"));
    }

    #[test]
    fn an_archived_name_given_as_it_is_wins_over_a_change_named_like_it() {
        // `2026-01-01-foo` is the archive of `foo`; a change that was itself
        // named `2026-01-01-foo` was archived later under a second date.
        let store = archive_of(&["2026-01-01-foo", "2026-05-05-2026-01-01-foo"]);
        assert_eq!(super::archived_change_name(&store, "2026-01-01-foo").as_deref(), Some("2026-01-01-foo"));
        assert_eq!(super::archived_change_name(&store, "foo").as_deref(), Some("2026-01-01-foo"));
        // Without the exact archive, the dated name is a change's own name.
        let store = archive_of(&["2026-05-05-2026-01-01-foo"]);
        assert_eq!(
            super::archived_change_name(&store, "2026-01-01-foo").as_deref(),
            Some("2026-05-05-2026-01-01-foo")
        );
    }

    #[test]
    fn an_active_change_is_found_before_the_archive() {
        let store = archive_of(&["2026-11-12-demo"]);
        assert!(matches!(super::locate_change(&store, "demo"), Some(super::Located::Archived(dated)) if dated == "2026-11-12-demo"));
        store.metas.borrow_mut().insert("demo".to_string(), "schema: spec-driven\n".to_string());
        assert!(matches!(super::locate_change(&store, "demo"), Some(super::Located::Active(change)) if change.name == "demo"));
    }

    // --- from_text fail-closed（design 决策一：存在但解析失败回 Err）---

    #[test]
    fn meta_from_text_bad_yaml_is_an_error_with_the_parse_reason() {
        // spec「change metadata 损坏的跨入口处置」：存在但 YAML 解析失败
        // 不得静默退回缺省——回带解析原因的错误。
        for bad in [": : :\n", "schema: [unclosed\n", "schema:\n  - a\n - b\n"] {
            let err = ChangeMeta::from_text(Some(bad))
                .expect_err("corrupt YAML must fail closed");
            assert!(!err.is_empty(), "parse reason must not be empty for {bad:?}");
        }
    }

    #[test]
    fn meta_from_text_missing_empty_and_absent_fields_give_defaults() {
        // 向后兼容不变：缺档（None）、空／纯注解文档与字段缺席仍回缺省。
        let m = ChangeMeta::from_text(None).expect("missing document → defaults");
        assert!(m.schema.is_none());
        for text in ["", "   \n", "# comment only\n"] {
            let m = ChangeMeta::from_text(Some(text))
                .unwrap_or_else(|e| panic!("{text:?} must give defaults, got: {e}"));
            assert!(m.schema.is_none());
            assert_eq!(m.schema_name(), "spec-driven");
        }
        let m = ChangeMeta::from_text(Some("created: 2026-07-01\n")).expect("absent fields → defaults");
        assert!(m.schema.is_none());
        assert!(m.started_at.is_none());
    }

    #[test]
    fn meta_parses_board_rank_and_absent_reads_as_none() {
        // 看板排序字段（specseal 桌面延伸）：含 board_rank 的 meta 正常解析，
        // 旧 meta（无此字段）读为 None——排序回退现行规则。
        let meta = ChangeMeta::from_text(Some("schema: spec-driven\nboard_rank: n\n")).expect("meta parses");
        assert_eq!(meta.board_rank.as_deref(), Some("n"));
        let old = ChangeMeta::from_text(Some("schema: spec-driven\ncreated: 2026-07-01\n")).expect("meta parses");
        assert!(old.board_rank.is_none());
    }

    const STAMPED_META: &str = "schema: spec-driven\ncreated: 2026-07-01\ncreated_by: Base Line <base@example.com>\ncreated_with: claude\nstarted_at: 2026-07-03\nstarted_by: Worker <w@example.com>\nstarted_with: claude\n";

    #[test]
    fn set_board_rank_appends_and_preserves_existing_fields_verbatim() {
        // spec「meta 写入路径对 board_rank 互不破坏」：写回除 board_rank 外
        // 逐字节保留（沿 started_* 的 read → append → write 机制）。
        let store = TestStore::with_meta("demo", STAMPED_META);
        super::set_board_rank(&store, "demo", "n").unwrap();
        let meta = store.meta("demo");
        assert!(
            meta.starts_with(STAMPED_META),
            "existing fields must be preserved byte-for-byte, got: {meta}"
        );
        assert_eq!(&meta[STAMPED_META.len()..], "board_rank: n\n");
        assert_eq!(
            ChangeMeta::from_text(Some(&meta)).expect("meta parses").board_rank.as_deref(),
            Some("n")
        );
    }

    #[test]
    fn set_board_rank_replaces_existing_line_in_place() {
        // 更新既有 rank：原行原位代换（字段顺序保留），其余逐字节不变。
        let store = TestStore::with_meta(
            "demo",
            "schema: spec-driven\nboard_rank: b\ncreated: 2026-07-01\n",
        );
        super::set_board_rank(&store, "demo", "abn").unwrap();
        assert_eq!(
            store.meta("demo"),
            "schema: spec-driven\nboard_rank: abn\ncreated: 2026-07-01\n"
        );
    }

    #[test]
    fn set_board_rank_handles_meta_missing_trailing_newline() {
        let store = TestStore::with_meta("demo", "schema: spec-driven\ncreated: 2026-07-01");
        super::set_board_rank(&store, "demo", "n").unwrap();
        assert_eq!(
            store.meta("demo"),
            "schema: spec-driven\ncreated: 2026-07-01\nboard_rank: n\n"
        );
    }

    #[test]
    fn set_board_rank_rejects_invalid_values_without_writing() {
        // 系统边界验证（sharp edge）：rank 仅小写英文本母——空值、大写、数字、
        // 空白与换行注入一律拒绝且零写入（换行会注入任意 YAML 字段）。
        let store = TestStore::with_meta("demo", "schema: spec-driven\n");
        for bad in ["", "N", "a1", "a b", "a\nstarted_at: forged", "ranké"] {
            assert!(
                super::set_board_rank(&store, "demo", bad).is_err(),
                "invalid rank {bad:?} must be rejected"
            );
        }
        assert_eq!(*store.meta_writes.borrow(), 0, "invalid ranks must not write");
    }

    #[test]
    fn set_board_rank_refuses_on_corrupt_meta_without_writing() {
        // spec「排序写入对坏 metadata 拒绝」：文本手术前先解析，坏档回带
        // 文件位置与原因的错误且零写入。
        const BAD: &str = ": : :\n\t bad yaml [unclosed\n";
        let store = TestStore::with_meta("demo", BAD);
        let err = super::set_board_rank(&store, "demo", "n").unwrap_err();
        assert!(
            err.to_string().contains("specseal/changes/demo/.meta.yaml"),
            "error must name the metadata file: {err}"
        );
        assert_eq!(store.meta("demo"), BAD, "meta byte-identical");
        assert_eq!(*store.meta_writes.borrow(), 0, "refusal must not write");
    }

    #[test]
    fn set_board_rank_errors_on_missing_change_and_unsafe_names() {
        // 不存在的 change 回明确错误（桌面以单行错误呈现，不静默）；
        // 非单一路径段名称拒绝（沿 in-progress add 的同款防护）。
        let store = TestStore::with_meta("demo", "schema: spec-driven\n");
        assert!(super::set_board_rank(&store, "ghost", "n").is_err());
        assert!(super::set_board_rank(&store, "../evil", "n").is_err());
        assert!(super::set_board_rank(&store, "a/b", "n").is_err());
        assert_eq!(*store.meta_writes.borrow(), 0);
    }

    // --- edit_meta（design D2：读→fail-closed 解析→套闭包→回写）---

    #[test]
    fn edit_meta_returns_none_without_writing_when_the_meta_is_missing() {
        let store = TestStore::with_meta("demo", "schema: spec-driven\n");
        let out = super::edit_meta(&store, "ghost", |m| {
            m.set("board_rank", "n")?;
            Ok(())
        })
        .unwrap();
        assert!(out.is_none());
        assert_eq!(*store.meta_writes.borrow(), 0);
    }

    #[test]
    fn edit_meta_refuses_corrupt_meta_with_meta_error_without_writing() {
        const BAD: &str = ": : :\n\t bad yaml [unclosed\n";
        let store = TestStore::with_meta("demo", BAD);
        let err = super::edit_meta(&store, "demo", |m| {
            m.set("board_rank", "n")?;
            Ok(())
        })
        .unwrap_err();
        let meta_err = err
            .downcast_ref::<super::MetaError>()
            .expect("corrupt meta must surface as MetaError");
        assert_eq!(meta_err.change, "demo");
        assert_eq!(store.meta("demo"), BAD, "meta byte-identical");
        assert_eq!(*store.meta_writes.borrow(), 0, "refusal must not write");
    }

    #[test]
    fn edit_meta_skips_the_write_when_the_closure_changes_nothing() {
        let store = TestStore::with_meta("demo", STAMPED_META);
        let out = super::edit_meta(&store, "demo", |m| Ok(m.get("schema").map(str::to_string)))
            .unwrap();
        assert_eq!(out, Some(Some("spec-driven".to_string())));
        assert_eq!(store.meta("demo"), STAMPED_META);
        assert_eq!(*store.meta_writes.borrow(), 0, "unchanged text must not write");
    }

    #[test]
    fn edit_meta_writes_exactly_once_and_preserves_the_rest_verbatim() {
        let store = TestStore::with_meta("demo", STAMPED_META);
        let out = super::edit_meta(&store, "demo", |m| {
            m.set("board_rank", "n")?;
            Ok(7)
        })
        .unwrap();
        assert_eq!(out, Some(7));
        assert_eq!(*store.meta_writes.borrow(), 1, "exactly one write");
        assert_eq!(store.meta("demo"), format!("{STAMPED_META}board_rank: n\n"));
    }

    #[test]
    fn meta_without_started_fields_parses_as_not_started() {
        // Backward compatibility: pre-migration documents (no started_*) keep
        // parsing without warnings and read as "not started".
        let old = "schema: spec-driven\ncreated: 2026-07-01\ncreated_by: Base Line <base@example.com>\n";
        let meta = ChangeMeta::from_text(Some(old)).expect("meta parses");
        assert_eq!(meta.schema.as_deref(), Some("spec-driven"));
        assert!(meta.started_at.is_none());
        assert!(meta.started_by.is_none());
        assert!(meta.started_with.is_none());
    }

    // --- 时间字段：写入时戳、对外输出日期（process-cost-metrics design D2）---

    #[test]
    fn meta_collapses_rfc3339_time_fields_to_their_date_part() {
        // spec「change metadata 时间字段写入时戳、对外输出日期」：解析层把时戳收敛成
        // 前 10 个字符；完整时戳只有流程成本（lifecycle/cost.rs）逐键读原文取得。
        let text = "schema: spec-driven\ncreated: 2026-10-21T14:05:00+08:00\nstarted_at: 2026-10-22T09:00:00+08:00\nclaimed_at: 2026-10-23T10:00:00+00:00\nreviewed_at: 2026-10-24T23:59:59-05:00\nverified_at: 2026-10-25T00:00:01+08:00\narchived_at: 2026-10-26T16:30:00+08:00\n";
        let meta = ChangeMeta::from_text(Some(text)).expect("meta parses");
        assert_eq!(meta.created.as_deref(), Some("2026-10-21"));
        assert_eq!(meta.started_at.as_deref(), Some("2026-10-22"));
        assert_eq!(meta.claimed_at.as_deref(), Some("2026-10-23"));
        assert_eq!(meta.reviewed_at.as_deref(), Some("2026-10-24"));
        assert_eq!(meta.verified_at.as_deref(), Some("2026-10-25"));
    }

    #[test]
    fn collapsing_an_already_collapsed_meta_changes_nothing() {
        // 收敛是幂等的：日期部分再收敛一次仍是同一个日期。
        let text = "created: 2026-10-21T14:05:00+08:00\nstarted_at: someday\nreviewed_at: 2026-10-24\n";
        let mut meta = ChangeMeta::from_text(Some(text)).expect("meta parses");
        let once = format!("{meta:?}");
        meta.collapse_time_fields();
        assert_eq!(format!("{meta:?}"), once);
    }

    #[test]
    fn duplicate_archived_at_lines_do_not_break_the_meta() {
        // `archived_at` 不是 ChangeMeta 的字段：旧版在残留的 archived_at 之后再追加
        // 一行时，整份 meta 照常解析，不会因重复键读成默认值。
        let text = "schema: spec-driven\ncreated: 2026-10-21T14:05:00+08:00\narchived_at: 2026-10-21T16:00:00+08:00\narchived_at: 2026-10-22\n";
        let meta = ChangeMeta::from_text(Some(text)).expect("duplicate archived_at must not fail the parse");
        assert_eq!(meta.created.as_deref(), Some("2026-10-21"));
    }

    #[test]
    fn meta_keeps_plain_dates_and_unrecognised_time_values_verbatim() {
        // 纯日期与既不是日期也不是时戳的值原样保留（现行行为）。
        let meta = ChangeMeta::from_text(Some("created: 2026-07-29\nstarted_at: someday\n"))
            .expect("meta parses");
        assert_eq!(meta.created.as_deref(), Some("2026-07-29"));
        assert_eq!(meta.started_at.as_deref(), Some("someday"));
        let meta = ChangeMeta::from_text(Some("created: someday\n")).expect("meta parses");
        assert_eq!(meta.created.as_deref(), Some("someday"));
        // 偏移量超出范围、少了秒的写法都不是 RFC 3339——原样保留，不截成日期。
        for odd in ["2026-10-21T14:05:00+25:00", "2026-10-21T14:05+08:00"] {
            let meta = ChangeMeta::from_text(Some(&format!("created: {odd}\n"))).expect("meta parses");
            assert_eq!(meta.created.as_deref(), Some(odd));
        }
    }

    #[test]
    fn from_fields_collapses_time_fields_like_from_text() {
        // SDK store bridge 与 remote drift 由已结构化的字段组 ChangeMeta、不经
        // from_text——from_fields 收尾时跑同一道收敛，输出点拿到的一样是日期部分。
        let meta = ChangeMeta::from_fields(|m| {
            m.created = Some("2026-10-21T14:05:00+08:00".into());
            m.started_at = Some("2026-10-22T09:00:00+08:00".into());
            m.claimed_at = Some("someday".into());
        });
        assert_eq!(meta.created.as_deref(), Some("2026-10-21"));
        assert_eq!(meta.started_at.as_deref(), Some("2026-10-22"));
        assert_eq!(meta.claimed_at.as_deref(), Some("someday"));
    }

    #[test]
    fn meta_parses_station_rounds_as_non_negative_integers() {
        let meta = ChangeMeta::from_text(Some("reviewed_rounds: 3\nverified_rounds: 0\n"))
            .expect("meta parses");
        assert_eq!(meta.reviewed_rounds, Some(3));
        assert_eq!(meta.verified_rounds, Some(0));
        let meta = ChangeMeta::from_text(Some("schema: spec-driven\n")).expect("meta parses");
        assert!(meta.reviewed_rounds.is_none() && meta.verified_rounds.is_none());
    }

    #[test]
    fn meta_with_non_integer_station_rounds_fails_closed() {
        // spec「原有轮数不是整数时拒绝」：轮数字段不是非负整数 → metadata 无法解析。
        for bad in [
            "reviewed_rounds: many\n",
            "verified_rounds: -1\n",
            "reviewed_rounds: 2.5\n",
            "reviewed_rounds: \"3\"\n",
            "verified_rounds: 18446744073709551616\n",
        ] {
            ChangeMeta::from_text(Some(bad)).expect_err(&format!("{bad:?} must fail closed"));
        }
    }

    #[test]
    fn meta_with_started_fields_parses_all_three_stations() {
        let text = "schema: spec-driven\ncreated: 2026-07-01\nstarted_at: 2026-07-03\nstarted_by: Worker <w@example.com>\nstarted_with: claude\n";
        let meta = ChangeMeta::from_text(Some(text)).expect("meta parses");
        assert_eq!(meta.started_at.as_deref(), Some("2026-07-03"));
        assert_eq!(meta.started_by.as_deref(), Some("Worker <w@example.com>"));
        assert_eq!(meta.started_with.as_deref(), Some("claude"));
    }

    // --- anchors：站别章字段的映射单源（lifecycle-station-anchors design D1）---

    const REVIEWED_ONLY: &str = "schema: spec-driven\nreviewed_at: 2026-08-01\nreviewed_tasks_total: 5\nreviewed_scope:\n  - path: crates/a/src/lib.rs\n    hash: dead\n";
    const BOTH_STAMPED: &str = "schema: spec-driven\nreviewed_at: 2026-08-01\nreviewed_tasks_total: 5\nreviewed_scope:\n  - path: crates/a/src/lib.rs\n    hash: dead\nverified_at: 2026-08-02\nverified_tasks_total: 6\nverified_scope:\n  - path: crates/b/src/util.rs\n    hash: beef\n";

    #[test]
    fn anchors_reads_the_review_stamp_only_for_the_review_station() {
        // 只带 reviewed_* 的 meta：审查站取到三栏，验证站三栏皆空（缺席读作未盖章）。
        let meta = ChangeMeta::from_text(Some(REVIEWED_ONLY)).expect("meta parses");
        let review = meta.anchors(&crate::station::REVIEW);
        assert_eq!(review.stamped_at, Some("2026-08-01"));
        assert_eq!(review.tasks_total, Some(5));
        assert_eq!(review.scope.len(), 1);
        assert_eq!(review.scope[0].path, "crates/a/src/lib.rs");
        assert_eq!(review.scope[0].hash, "dead");
        assert!(crate::station::is_stamped(review), "review stamp is complete");
        let verify = meta.anchors(&crate::station::VERIFY);
        assert_eq!(verify.stamped_at, None);
        assert_eq!(verify.tasks_total, None);
        assert!(verify.scope.is_empty());
        assert!(!crate::station::is_stamped(verify), "no verify stamp to read");
    }

    #[test]
    fn anchors_keeps_the_two_stamps_apart_when_both_are_present() {
        // 两站都带章：各取各的字段，互不屏蔽。
        let meta = ChangeMeta::from_text(Some(BOTH_STAMPED)).expect("meta parses");
        let review = meta.anchors(&crate::station::REVIEW);
        assert_eq!(review.stamped_at, Some("2026-08-01"));
        assert_eq!(review.tasks_total, Some(5));
        assert_eq!(review.scope[0].path, "crates/a/src/lib.rs");
        assert_eq!(review.scope[0].hash, "dead");
        let verify = meta.anchors(&crate::station::VERIFY);
        assert_eq!(verify.stamped_at, Some("2026-08-02"));
        assert_eq!(verify.tasks_total, Some(6));
        assert_eq!(verify.scope[0].path, "crates/b/src/util.rs");
        assert_eq!(verify.scope[0].hash, "beef");
        assert!(crate::station::is_stamped(review));
        assert!(crate::station::is_stamped(verify));
    }

    // --- from_discussion 累积器读取（design D1；M↔N 关系）---

    #[test]
    fn from_discussions_absent_yields_empty() {
        let meta = ChangeMeta::from_text(Some("schema: spec-driven\ncreated: 2026-07-01\n")).expect("meta parses");
        assert!(meta.from_discussions().is_empty());
    }

    #[test]
    fn from_discussions_single_value() {
        let meta = ChangeMeta::from_text(Some("schema: spec-driven\nfrom_discussion: alpha-search\n")).expect("meta parses");
        assert_eq!(meta.from_discussions(), vec!["alpha-search".to_string()]);
    }

    #[test]
    fn from_discussions_comma_accumulated_values() {
        // 逗号清单依 meta 顺序切分、项目前后空白修剪（沿 promoted_to 同款）。
        let meta = ChangeMeta::from_text(Some(
            "schema: spec-driven\nfrom_discussion: alpha-search, beta-cache\n",
        )).expect("meta parses");
        assert_eq!(
            meta.from_discussions(),
            vec!["alpha-search".to_string(), "beta-cache".to_string()]
        );
    }

    // --- restale_from 读取（design D3/D6；spec change-lifecycle）---

    #[test]
    fn restale_from_absent_yields_empty() {
        let meta = ChangeMeta::from_text(Some("schema: spec-driven\ncreated: 2026-07-01\n")).expect("meta parses");
        assert!(meta.restale_from().is_empty());
    }

    #[test]
    fn restale_from_single_value() {
        let meta = ChangeMeta::from_text(Some("schema: spec-driven\nrestale_from: alpha-search\n")).expect("meta parses");
        assert_eq!(meta.restale_from(), vec!["alpha-search".to_string()]);
    }

    #[test]
    fn restale_from_comma_accumulated_values() {
        // spec change-lifecycle Example：逗号多值 trim 后分割。
        let meta = ChangeMeta::from_text(Some(
            "schema: spec-driven\nrestale_from: alpha-search, beta-cache\n",
        )).expect("meta parses");
        assert_eq!(
            meta.restale_from(),
            vec!["alpha-search".to_string(), "beta-cache".to_string()]
        );
    }

    // --- depends_on 读取（change-plan design D2；spec change-lifecycle
    //     「meta 新字段向后兼容」）---

    #[test]
    fn depends_on_absent_yields_empty() {
        // 缺席读作无依赖：旧 meta 档照常解析，读取器回空清单。
        let meta = ChangeMeta::from_text(Some("schema: spec-driven\ncreated: 2026-07-01\n")).expect("meta parses");
        assert!(meta.depends_on().is_empty());
    }

    #[test]
    fn depends_on_comma_accumulated_values() {
        // 与 restale_from 同形：逗号切分、trim、去空。
        let meta = ChangeMeta::from_text(Some(
            "schema: spec-driven\ndepends_on: a, b\n",
        )).expect("meta parses");
        assert_eq!(meta.depends_on(), vec!["a".to_string(), "b".to_string()]);
    }

    // --- stage 三态（change-plan design D7；与桌面 core 的 change_stage 同规则）---

    #[test]
    fn stage_is_ready_when_every_task_is_checked() {
        let store = TestStore::with_meta("demo", "schema: spec-driven\n");
        store.put_artifact("demo", "tasks.md", "- [x] 1.1 a\n- [x] 1.2 b\n");
        let change = store.find_change("demo").unwrap();
        assert_eq!(super::stage(&store, &change), super::Stage::Ready);
        assert_eq!(super::Stage::Ready.as_str(), "ready");
    }

    #[test]
    fn stage_is_in_progress_on_a_started_stamp_or_any_checked_task() {
        // 开工章：任务全未勾仍算进行中。
        let stamped = TestStore::with_meta("demo", "schema: spec-driven\nstarted_at: 2026-07-03\n");
        stamped.put_artifact("demo", "tasks.md", "- [ ] 1.1 a\n- [ ] 1.2 b\n");
        let change = stamped.find_change("demo").unwrap();
        assert_eq!(super::stage(&stamped, &change), super::Stage::InProgress);
        // 无章但有已勾任务（绕过动词手改 tasks.md）：同样进行中。
        let checked = TestStore::with_meta("demo", "schema: spec-driven\n");
        checked.put_artifact("demo", "tasks.md", "- [x] 1.1 a\n- [ ] 1.2 b\n");
        let change = checked.find_change("demo").unwrap();
        assert_eq!(super::stage(&checked, &change), super::Stage::InProgress);
        assert_eq!(super::Stage::InProgress.as_str(), "in-progress");
    }

    #[test]
    fn stage_is_proposed_without_a_stamp_or_checked_tasks() {
        // 零任务（无 tasks.md）与全未勾都算提案中——零任务不算已就绪。
        let empty = TestStore::with_meta("demo", "schema: spec-driven\n");
        let change = empty.find_change("demo").unwrap();
        assert_eq!(super::stage(&empty, &change), super::Stage::Proposed);
        let unchecked = TestStore::with_meta("demo", "schema: spec-driven\n");
        unchecked.put_artifact("demo", "tasks.md", "- [ ] 1.1 a\n");
        let change = unchecked.find_change("demo").unwrap();
        assert_eq!(super::stage(&unchecked, &change), super::Stage::Proposed);
        assert_eq!(super::Stage::Proposed.as_str(), "proposed");
    }

    #[test]
    fn stage_parse_is_the_inverse_of_as_str() {
        // 反查与 as_str 同一张表（add-change-plan-remote：remote 的 plan 回应转回引擎类型）；
        // 大小写不同或未知值一律 None，由调用端决定怎么报错。
        for stage in [super::Stage::Ready, super::Stage::InProgress, super::Stage::Proposed] {
            assert_eq!(super::Stage::parse(stage.as_str()), Some(stage));
        }
        assert_eq!(super::Stage::parse("Ready"), None);
        assert_eq!(super::Stage::parse("archived"), None);
    }

    // --- Purpose 合格判准（design D1；spec spec-validation
    //     「Purpose 合格判准单一定义」）---

    use super::{purpose_content, purpose_defect, PurposeDefect, MIN_PURPOSE_LENGTH};

    /// 一份带指定 Purpose 内容的 delta 文本（后接一个操作区段，证明判准只看
    /// Purpose 区段、不被其后标题干扰）。
    fn delta_with_purpose(purpose: &str) -> String {
        format!("## Purpose\n\n{purpose}\n\n## ADDED Requirements\n\n### Requirement: R\n\nIt SHALL work.\n")
    }

    #[test]
    fn qualified_purpose_has_no_defect() {
        let text = delta_with_purpose(
            "本 capability 管理权杖的轮替与撤销，涵盖签发、验证与失效三段生命周期的可观察行为，以及逾期权杖的清理时机。",
        );
        assert!(purpose_defect(&text).is_none(), "合格 Purpose 不得回报缺陷");
        assert!(
            purpose_content(&text).is_some_and(|p| p.starts_with("本 capability")),
            "区段内容以 trim 后原文回传，且不吞入其后的操作标题"
        );
    }

    #[test]
    fn missing_purpose_section_is_a_defect() {
        let text = "## ADDED Requirements\n\n### Requirement: R\n\nIt SHALL work.\n";
        assert!(matches!(purpose_defect(text), Some(PurposeDefect::Missing)));
        assert!(purpose_content(text).is_none());
    }

    #[test]
    fn empty_purpose_section_is_a_defect() {
        // 区段在、内容空（只有空白行）＝与缺席同级：判准不接受空段。
        let text = "## Purpose\n\n   \n\n## ADDED Requirements\n\n### Requirement: R\n\nIt SHALL work.\n";
        assert!(matches!(purpose_defect(text), Some(PurposeDefect::Missing)));
        assert!(purpose_content(text).is_none());
    }

    #[test]
    fn purpose_one_char_below_the_threshold_is_too_short() {
        let text = delta_with_purpose(&"a".repeat(MIN_PURPOSE_LENGTH - 1));
        assert!(matches!(
            purpose_defect(&text),
            Some(PurposeDefect::TooShort(n)) if n == MIN_PURPOSE_LENGTH - 1
        ));
    }

    #[test]
    fn fifty_chinese_characters_qualify() {
        // spec Scenario「中文内容以字符计长」：50 个中文本元恰达门槛，
        // 不因 UTF-8 多字节被计为超过或不足。
        let purpose = "字".repeat(MIN_PURPOSE_LENGTH);
        assert!(purpose.len() > MIN_PURPOSE_LENGTH, "前提：中文的 bytes 数远大于字符数");
        assert!(
            purpose_defect(&delta_with_purpose(&purpose)).is_none(),
            "50 个中文本元达标"
        );
        let one_short = "字".repeat(MIN_PURPOSE_LENGTH - 1);
        assert!(matches!(
            purpose_defect(&delta_with_purpose(&one_short)),
            Some(PurposeDefect::TooShort(n)) if n == MIN_PURPOSE_LENGTH - 1
        ));
    }
}
