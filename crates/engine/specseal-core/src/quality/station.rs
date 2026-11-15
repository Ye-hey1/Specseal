//! 品质站的共通生命周期（design D1）：工单骨架产生／验证／解析、structured
//! phase／patch、盖章原子写入、指纹计算、失效纯函数与 archive 守门检查。
//!
//! 站别差异收敛为一组常数（[`Station`]）：工单文件名、meta 字段前缀、标题词、
//! 消息用的站别名词，以及「add-round 是否要求任务全完成」的刻意不对称。
//! 两个站就是两组常数（[`REVIEW`]／[`VERIFY`]）——守门与失效规则永远同一份
//! 实作，调用端直接带站别常数调用本模块的函数，没有站别门面。
//!
//! 工单本身是 sidecar：不注册进 workflow schema，仅由动词经 `&dyn Store` 读写
//! （与 discuss 动词同型）——本地随 git、remote 走 store 文档管道。

use crate::config::{ReviewBaseline, ReviewConfig};
use crate::keylines::KeyLines;
use crate::model::{ChangeMeta, ReviewedScopeEntry};
use crate::store::Store;
use anyhow::{anyhow, bail, Result};

/// 站别识别（lifecycle-station-anchors D1）：[`crate::model::ChangeMeta::anchors`]
/// 对它穷举 match 选章字段——第三站来时漏补臂是编译错误，不是静默读到空章。
/// 除此之外不对外有其他用途（CLI 的 snapshot namespace `StationNs` 是另一层）。
#[derive(Clone, Copy)]
pub enum StationId {
    Review,
    Verify,
}

/// 一个品质站的站别常数组。添加站别＝添加一组常数（[`REVIEW`]／[`VERIFY`]
/// 之外再加一组）、[`StationId`] 加一值，不建 trait。
pub struct Station {
    /// 站别识别——章字段映射的 match 键。
    pub id: StationId,
    /// 工单文档（change 目录下的相对路径），如 `review.md`。
    pub doc: &'static str,
    /// meta 字段前缀，如 `reviewed`——同时是消息中的过去分词（files reviewed）。
    pub meta_prefix: &'static str,
    /// 工单首行标题词，如 `Review`。
    pub title: &'static str,
    /// 消息与 CLI 家族名，如 `review`。
    pub noun: &'static str,
    /// 站别检查活动的名词词组，如 `review`／`verification`——[`noun`] 是 CLI 词，
    /// 这个是散文词（「finish the verification」而非「finish the verify」）。
    pub noun_phrase: &'static str,
    /// 「修正后重跑本站」的祈使词，如 `re-review`。
    pub recheck: &'static str,
    /// 刻意不对称（design D3）：`add-round` 是否要求任务全数完成。验证工单语意
    /// 限定为成品验证（verify 检查可中途跑，盘点轮不得落工单）；审查站无此守门。
    pub round_requires_tasks_complete: bool,
}

/// 审查站工单文档（change 目录下的相对路径）。
pub const REVIEW_DOC: &str = "review.md";

/// 验证站工单文档（change 目录下的相对路径）。
pub const VERIFY_DOC: &str = "verify.md";

/// 审查站的站别常数组。`round_requires_tasks_complete` 为 false 是刻意的：
/// 审查技能的运行起点即自检任务完成度，不存在中途跑情境，守门留在技能层。
pub const REVIEW: Station = Station {
    id: StationId::Review,
    doc: REVIEW_DOC,
    meta_prefix: "reviewed",
    title: "Review",
    noun: "review",
    noun_phrase: "review",
    recheck: "re-review",
    round_requires_tasks_complete: false,
};

/// 验证站的站别常数组。`round_requires_tasks_complete` 为 true 是
/// verify-station-parity design D3 的刻意不对称：盘点轮误落工单会让「未结工单」
/// 失去语意、还会误触 archive 守门。
pub const VERIFY: Station = Station {
    id: StationId::Verify,
    doc: VERIFY_DOC,
    meta_prefix: "verified",
    title: "Verify",
    noun: "verify",
    noun_phrase: "verification",
    recheck: "re-verify",
    round_requires_tasks_complete: true,
};

impl Station {
    /// 一枚章的六个字段：`<prefix>_at`、`_by`、`_with`、`_tasks_total`、`_scope`、
    /// `_commit`——清章就是清这一组。回合数（[`Station::rounds_key`]）不在内：它是
    /// 流程成本，清章时保留。
    pub fn stamp_keys(&self) -> [String; 6] {
        ["at", "by", "with", "tasks_total", "scope", "commit"]
            .map(|suffix| format!("{}_{suffix}", self.meta_prefix))
    }

    /// 回合数字段 `<prefix>_rounds`。
    pub fn rounds_key(&self) -> String {
        format!("{}_rounds", self.meta_prefix)
    }
}

/// 工单 findings 行的分级。token 即工单文法与 CLI `--json` 的对外契约
/// （spec「审查工单的创建与追加」：severity ∈ CRITICAL／WARNING／SUGGESTION）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    Critical,
    Warning,
    Suggestion,
}

impl Severity {
    pub fn as_str(&self) -> &'static str {
        match self {
            Severity::Critical => "CRITICAL",
            Severity::Warning => "WARNING",
            Severity::Suggestion => "SUGGESTION",
        }
    }

    pub fn parse(s: &str) -> Option<Severity> {
        match s {
            "CRITICAL" => Some(Severity::Critical),
            "WARNING" => Some(Severity::Warning),
            "SUGGESTION" => Some(Severity::Suggestion),
            _ => None,
        }
    }
}

/// 一笔分级 finding（工单行 `- [severity] path — 描述`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Finding {
    pub severity: Severity,
    pub path: String,
    pub text: String,
}

/// 结构化轮次的 phase token（spec「审查工单的创建与追加」：discovery|validation）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RoundPhase {
    Discovery,
    Validation,
}

impl RoundPhase {
    pub fn as_str(&self) -> &'static str {
        match self {
            RoundPhase::Discovery => "discovery",
            RoundPhase::Validation => "validation",
        }
    }

    pub fn parse(s: &str) -> Option<RoundPhase> {
        match s {
            "discovery" => Some(RoundPhase::Discovery),
            "validation" => Some(RoundPhase::Validation),
            _ => None,
        }
    }
}

/// 一轮检查：`## Round N` 区段的解析结果。`phase`／`patch_hash` 为结构化轮次
/// 的 frozen patch identity；legacy 轮次两栏皆 None。`rules` 是 discovery 轮记录
/// 的套用规则（`**Rules**:`／`**Rule**:` 行），没有记录时为 None。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Round {
    pub index: usize,
    pub phase: Option<RoundPhase>,
    pub patch_hash: Option<String>,
    pub rules: Option<ReviewConfig>,
    pub scope: Vec<String>,
    pub findings: Vec<Finding>,
}

impl Round {
    /// 一轮的 JSON 形状——CLI `<station> show --json` 的 `rounds` 项与桌面工单分页
    /// 共用这一份（字段集合与 null 语意是对外契约）：camelCase，legacy 轮的
    /// `phase`／`patchHash` 与没有规则记录的 `rules` 为明确 null。server 的
    /// `ReviewRoundDto` 是同形的类型化镜射。
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "index": self.index,
            "phase": self.phase.map(|p| p.as_str()),
            "patchHash": self.patch_hash,
            "rules": self.rules,
            "scope": self.scope,
            "findings": self
                .findings
                .iter()
                .map(|f| serde_json::json!({
                    "severity": f.severity.as_str(),
                    "path": f.path,
                    "text": f.text,
                }))
                .collect::<Vec<_>>(),
        })
    }
}

/// 解析后的工单。经 `add_round` 创建的工单至少含一轮。
#[derive(Debug, Clone)]
pub struct Ticket {
    pub rounds: Vec<Round>,
}

impl Ticket {
    /// 末轮——续轮 subagent 取待办的入口（CLI `--json` 的 `lastRound`）。
    pub fn last_round(&self) -> &Round {
        self.rounds.last().expect("a ticket always carries at least one round")
    }
}

/// 动词层可辨识的「查无」（change 或工单缺席）——server 端经 command
/// `classify` 映 404；CLI 人眼路径只见消息文本，行为不变。
#[derive(Debug)]
pub struct NotFound(pub String);

impl std::fmt::Display for NotFound {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for NotFound {}

/// 冻结度：章的双锚判定结果（design D3——[`StationStatus::freshness`] 算出，桌面的本机
/// 与 remote 清单都用它，CLI 不输出）。Unknown＝没有完整的章（缺席读作未盖章）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Freshness {
    Fresh,
    Stale,
    Unknown,
}

/// 读档闭包本体：repo-root 相对路径 → 文件原始字节；回 None＝缺档或 I/O
/// 失败（UTF-8 分流收在指纹入口，读取器不预判文本性）。指纹与失效判定的
/// 全部签名共用这一个别名——下次再换读取形不必改遍每个签名。
pub type ScopeReadFn<'a> = dyn Fn(&str) -> Option<Vec<u8>> + 'a;

/// 内容锚的读取器：None 代表没有工作树可读（remote 封存信道），内容锚因此
/// 不判定。
pub type ScopeReader<'a> = Option<&'a ScopeReadFn<'a>>;

/// 章失效的原因——封存守门的拒绝消息素材（design D5）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StaleReason {
    /// 任务锚破：总数已非盖章时的数，或仍有写码任务未完成。
    TaskAnchor { stamped_total: usize, total: usize, code_complete: usize, code_total: usize },
    /// 内容锚破：这个 scope 档的现值指纹不符（含文件已不存在）。
    ContentAnchor { path: String },
}

/// 章的双锚原料（自站别 meta 字段取出后交给共用判定）。
#[derive(Clone, Copy)]
pub struct StampAnchors<'a> {
    pub stamped_at: Option<&'a str>,
    pub tasks_total: Option<usize>,
    pub scope: &'a [ReviewedScopeEntry],
}

/// 一枚章在 meta 里的全部字段（[`ChangeMeta::stamp`] 依站别取出）。「这个站的章住在哪些
/// 字段」只有那一份映射；判定只看其中三个锚（[`Stamp::anchors`]），其余是回报用的事实。
#[derive(Clone, Copy)]
pub struct Stamp<'a> {
    pub at: Option<&'a str>,
    pub by: Option<&'a str>,
    pub with: Option<&'a str>,
    pub tasks_total: Option<usize>,
    pub rounds: Option<u64>,
    /// 盖章时调用端回报的 commit。引擎只存不查，判定不看它。
    pub commit: Option<&'a str>,
    pub scope: &'a [ReviewedScopeEntry],
}

impl<'a> Stamp<'a> {
    /// 章的双锚原料：冻结判定与「是否已盖章」只看这三个字段。
    pub fn anchors(&self) -> StampAnchors<'a> {
        StampAnchors { stamped_at: self.at, tasks_total: self.tasks_total, scope: self.scope }
    }
}

/// 已封存变更一个品质站的结局（封存即定格，不重算冻结度）。顺序与 [`status`] 相同：
/// 工单先于章——盖章后重开的工单取代了旧章，带着它封存就是未通过。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArchivedOutcome {
    /// 没有章，也没有带着工单封存。
    None,
    /// 封存时有章，没有工单。
    Stamped,
    /// 带着未结的工单封存。
    NotPassed,
}

impl ArchivedOutcome {
    /// `ticket_archived`：封存的文档集里有这一站的工单；`stamped`：封存的 meta 有章。
    pub fn of(ticket_archived: bool, stamped: bool) -> Self {
        match (ticket_archived, stamped) {
            (true, _) => ArchivedOutcome::NotPassed,
            (false, true) => ArchivedOutcome::Stamped,
            (false, false) => ArchivedOutcome::None,
        }
    }
}

/// 一个品质站在一个变更上走到哪里（station-status-and-landing D1）。「盖章后内容有没有
/// 变」不在这里：那要读工作树，由有工作树的一端拿 [`StationStatus`] 的任务数与 scope 自己判。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StationProgress {
    /// 没有工单，也没有完整的章。
    None,
    /// 有未结的工单。
    InProgress,
    /// 没有工单，meta 有完整的章。
    Stamped,
}

impl StationProgress {
    /// 对外的字符串（`show --json` 与在线回应的 `state`）。
    pub fn as_str(&self) -> &'static str {
        match self {
            StationProgress::None => "none",
            StationProgress::InProgress => "inProgress",
            StationProgress::Stamped => "stamped",
        }
    }
}

/// 一个品质站的状态与章的内容。章的字段只在 [`StationProgress::Stamped`] 时有值。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StationStatus {
    pub progress: StationProgress,
    pub stamped_at: Option<String>,
    pub stamped_by: Option<String>,
    pub stamped_with: Option<String>,
    pub rounds: Option<u64>,
    pub tasks_total: Option<usize>,
    pub commit: Option<String>,
    /// 盖章时每个文件的路径与内容指纹。清单与 `show --json` 不带它。
    pub scope: Vec<ReviewedScopeEntry>,
}

impl StationStatus {
    /// 未开始：没有任何章的字段。
    pub fn none() -> StationStatus {
        StationStatus {
            progress: StationProgress::None,
            stamped_at: None,
            stamped_by: None,
            stamped_with: None,
            rounds: None,
            tasks_total: None,
            commit: None,
            scope: Vec::new(),
        }
    }

    /// 章的冻结度（design D3、D4）：任务锚＝当前全任务总数仍等于盖章时总数，且写码任务
    /// 全完成——`[M]` 手测任务的勾选状态不影响章（章＝验证过，手测是封存的事）；内容锚＝
    /// 全部 scope 档的现值指纹相符（缺档即不符）。任一锚破 → Stale；全符 → Fresh；没有
    /// 章（未开始或进行中）→ Unknown。`read_file` 为 None 时只判任务锚：没有工作树可读
    /// 的一端（remote 清单）无从判定内容锚。本机与 remote 的桌面清单共用这一份。
    pub fn freshness(&self, counts: &crate::tasks::Counts, read_file: ScopeReader<'_>) -> Freshness {
        if self.progress != StationProgress::Stamped {
            return Freshness::Unknown;
        }
        let anchors = StampAnchors {
            stamped_at: self.stamped_at.as_deref(),
            tasks_total: self.tasks_total,
            scope: &self.scope,
        };
        match stale_reason(anchors, counts, read_file) {
            Some(_) => Freshness::Stale,
            None => Freshness::Fresh,
        }
    }

    /// `show --json` 的形状：`state`，盖章后另有 `stampedAt`、`rounds`、`tasksTotal` 与
    /// 有值才出现的 `stampedBy`、`stampedWith`、`commit`。不含 scope。
    pub fn to_json(&self) -> serde_json::Value {
        let mut json = serde_json::json!({ "state": self.progress.as_str() });
        if self.progress != StationProgress::Stamped {
            return json;
        }
        json["stampedAt"] = serde_json::json!(self.stamped_at);
        json["rounds"] = serde_json::json!(self.rounds);
        json["tasksTotal"] = serde_json::json!(self.tasks_total);
        for (key, value) in
            [("stampedBy", &self.stamped_by), ("stampedWith", &self.stamped_with), ("commit", &self.commit)]
        {
            if let Some(value) = value {
                json[key] = serde_json::json!(value);
            }
        }
        json
    }
}

/// 关卡状态的判定，`show --json` 与在线的清单、单笔回应共用这一份：工单存在 → 进行中；
/// 否则 meta 有完整的章（[`is_stamped`]）→ 已盖章；否则未开始。`ticket_open` 由调用端给：
/// 它手上多半已经有这个变更的文档清单，不必为此再读一次。
pub fn status(st: &Station, meta: &ChangeMeta, ticket_open: bool) -> StationStatus {
    if ticket_open {
        return StationStatus { progress: StationProgress::InProgress, ..StationStatus::none() };
    }
    let stamp = meta.stamp(st);
    if !is_stamped(stamp.anchors()) {
        return StationStatus::none();
    }
    StationStatus {
        progress: StationProgress::Stamped,
        stamped_at: stamp.at.map(str::to_string),
        stamped_by: stamp.by.map(str::to_string),
        stamped_with: stamp.with.map(str::to_string),
        // 加入轮数记录之前盖的章没有这个字段，读作 0。
        rounds: Some(stamp.rounds.unwrap_or(0)),
        tasks_total: stamp.tasks_total,
        commit: stamp.commit.map(str::to_string),
        scope: stamp.scope.to_vec(),
    }
}

/// 追加一轮（工单不存在则创建，自 Round 1 起算）。回传本轮编号。
/// 内容须含非空的 `**Scope**:` 文件清单；`- [` 开头行须为合法 findings 行；
/// 既有轮次 append-only 不改写（spec「审查／验证工单的创建与追加」）。
pub fn add_round(st: &Station, store: &dyn Store, change: &str, content: &str) -> Result<usize> {
    ensure_single_segment(change)?;
    if !store.change_exists(change) {
        bail!(NotFound(format!("change not found: {change}")));
    }
    // 写入前先验证（系统边界：stdin 为外部输入）——拒绝路径零写入。文法错误
    // 只在这里标成调用端内容错误（invalid_argv）；同一文法解析既存工单时的
    // 坏档仍是一般错误。
    let body = parse_round_body(st, content)
        .map_err(|e| crate::command::InvalidContent(e.to_string()))?;
    // 刻意不对称（design D3）：验证工单语意限定为成品验证，中途盘点轮不落工单
    // ——误落的盘点轮会让「未结工单」失去语意，还会误触 archive 守门。
    if st.round_requires_tasks_complete {
        let counts = crate::tasks::counts_for(store, change);
        if !counts.code_done() {
            bail!(crate::command::Refusal(format!(
                "change '{change}' has {}/{} code tasks complete — a {} ticket \
                 records the finished work; mid-flight check-ins stay in the conversation",
                counts.code_complete, counts.code_total, st.noun
            )));
        }
    }
    // 追加前解析既有工单：坏档 fail-closed，不得在其上叠写。
    let existing = store.read_artifact(change, st.doc);
    let ticket = existing.as_deref().map(|t| parse_ticket(st, t)).transpose()?;
    // Sequence guard（spec「工单的创建与追加」）：工单首个结构化 round 是
    // discovery；已有结构化 round 后只能追加 validation；validation 必须有可
    // 验收的既有轮次（legacy ticket 也算）。`**Phase**:` 与工单状态不符同样是
    // 调用端内容错误（invalid_argv）。
    match body.phase {
        Some(RoundPhase::Discovery)
            if ticket.as_ref().is_some_and(|t| t.rounds.iter().any(|r| r.phase.is_some())) =>
        {
            bail!(crate::command::InvalidContent(
                "the ticket already carries a structured round — subsequent structured \
                 rounds must be validation"
                    .into()
            ));
        }
        Some(RoundPhase::Validation) if ticket.is_none() => {
            bail!(crate::command::InvalidContent(
                "a validation round needs an existing ticket to validate — the first \
                 structured round is discovery"
                    .into()
            ));
        }
        _ => {}
    }
    let (mut text, next) = match existing {
        Some(existing) => {
            let next = ticket.expect("existing document parsed above").last_round().index + 1;
            (existing, next)
        }
        None => (format!("# {} — {change}\n", st.title), 1),
    };
    if !text.ends_with('\n') {
        text.push('\n');
    }
    text.push_str(&format!("\n## Round {next}\n\n{}\n", content.trim_end()));
    store.write_artifact(change, st.doc, &text)?;
    Ok(next)
}

/// 读取并解析工单（spec「工单的读取」）。无工单回错误。
pub fn show(st: &Station, store: &dyn Store, change: &str) -> Result<Ticket> {
    show_with_content(st, store, change).map(|(ticket, _)| ticket)
}

/// `show` 加带工单原文：同一次读取同时给出解析结果与文档文本，让人眼路径
/// （印原文）与 wire 回应（content 字段）不必各自再读一次同一份文档。
/// 原文恒为 `Some`——工单缺席在这里就是错误，`Option` 只为调用端与 wire 的
/// 选填字段同形。
pub fn show_with_content(
    st: &Station,
    store: &dyn Store,
    change: &str,
) -> Result<(Ticket, Option<String>)> {
    ensure_single_segment(change)?;
    if !store.change_exists(change) {
        bail!(NotFound(format!("change not found: {change}")));
    }
    let Some(text) = store.read_artifact(change, st.doc) else {
        bail!(NotFound(format!("no {} ticket for change '{change}'", st.noun)));
    };
    let ticket = parse_ticket(st, &text)?;
    Ok((ticket, Some(text)))
}

/// 放弃本站：删除工单、不写任何 metadata（spec「放弃审查／放弃验证」）。
/// 无工单回错误。
pub fn discard(st: &Station, store: &dyn Store, change: &str) -> Result<()> {
    ensure_single_segment(change)?;
    if !store.change_exists(change) {
        bail!(NotFound(format!("change not found: {change}")));
    }
    if !store.artifact_exists(change, st.doc) {
        bail!(NotFound(format!("no {} ticket for change '{change}'", st.noun)));
    }
    store.delete_artifact(change, st.doc)
}

/// scope 注入盖章（design D4a）：remote 承载——工作树持有者预算好的
/// (path, hash) 清单直接入章。守门与 `stamp` 完全相同；额外验证分割
/// 「provided ∪ missing ＝工单各轮 Scope 联集且不相交」（CAS 式保护），
/// 不成立即拒。`missing` 是 checkout 持有者对「联集中已不存在的档」的明示
/// 声明——server 无工作树无从验证存在性，声明与哈希同属提交端的权威。
/// `head_commit` 同 [`stamp`]。
pub fn stamp_with_scope(
    st: &Station,
    store: &dyn Store,
    change: &str,
    accept: bool,
    actor: Option<&str>,
    tool: Option<&str>,
    head_commit: Option<&str>,
    scope: Vec<ReviewedScopeEntry>,
    missing: Vec<String>,
) -> Result<()> {
    let gate = stamp_gate(st, store, change, accept, head_commit)?;
    let mut entries: Vec<(String, String)> =
        scope.into_iter().map(|e| (e.path.replace('\\', "/"), e.hash)).collect();
    entries.sort();
    entries.dedup();
    // 集合相等是「集合」：同一 path 两份哈希时差集皆空，放行会让章落重复项，
    // freshness 逐笔比对必有一笔不符——该章从盖下的那刻起就永远 stale。
    if let Some(w) = entries.windows(2).find(|w| w[0].0 == w[1].0) {
        bail!(crate::command::Refusal(format!(
            "scope lists '{}' more than once with differing hashes — \
             one fingerprint per file",
            w[0].0
        )));
    }
    let declared_gone = scope_union(missing.iter().map(String::as_str));
    let outside: Vec<&str> = declared_gone
        .iter()
        .filter(|p| !gate.paths.contains(*p))
        .map(String::as_str)
        .collect();
    if !outside.is_empty() {
        bail!(crate::command::Refusal(format!(
            "declared-missing paths are not in the ticket's scope union: [{}]",
            outside.join(", ")
        )));
    }
    let provided: Vec<&String> = entries.iter().map(|(p, _)| p).collect();
    let overlap: Vec<&str> = declared_gone
        .iter()
        .filter(|p| provided.contains(p))
        .map(String::as_str)
        .collect();
    if !overlap.is_empty() {
        bail!(crate::command::Refusal(format!(
            "paths declared missing but also provided with a fingerprint: [{}]",
            overlap.join(", ")
        )));
    }
    let expected: Vec<&String> =
        gate.paths.iter().filter(|p| !declared_gone.contains(*p)).collect();
    ensure_scope_remainder(&expected, &declared_gone)?;
    let gap: Vec<&str> =
        expected.iter().filter(|p| !provided.contains(p)).map(|p| p.as_str()).collect();
    let extra: Vec<&str> = provided
        .iter()
        .filter(|p| !gate.paths.contains(**p))
        .map(|p| p.as_str())
        .collect();
    if !gap.is_empty() || !extra.is_empty() {
        bail!(crate::command::Refusal(format!(
            "provided scope does not match the ticket's scope union (missing: [{}], \
             unexpected: [{}]) — re-read the ticket and recompute the hashes",
            gap.join(", "),
            extra.join(", ")
        )));
    }
    write_stamp(st, store, change, &gate, actor, tool, &entries)
}

/// 盖章（spec「盖章守门与盖章效果」）：守门＝任务全完成＋末轮零待处理必修
/// （CRITICAL／WARNING）findings，SUGGESTION 不挡章（`accept` 仅豁免必修条件）；
/// 通过时以工单各轮 Scope 联集计算指纹，于同一原子写入内落站别字段与累加的
/// 回合数并删除工单。`head_commit` 是调用端当下看到的 commit（引擎不读 git）：有给
/// 就记进章里，形状不合即拒；它不参与冻结判定。`read_file` 供指纹计算读取 repo-root 相对
/// 路径的文件内容（remote 模式亦读本地工作树）；`file_exists` 判定联集文件是否
/// 仍在工作树——修正可能删除／改名早轮检查过的档，死档跳过不入锚（无从指纹也
/// 无从再变动），存在但读不到者仍 fail-closed。
pub fn stamp(
    st: &Station,
    store: &dyn Store,
    change: &str,
    accept: bool,
    actor: Option<&str>,
    tool: Option<&str>,
    head_commit: Option<&str>,
    read_file: &ScopeReadFn<'_>,
    file_exists: &dyn Fn(&str) -> bool,
) -> Result<()> {
    let gate = stamp_gate(st, store, change, accept, head_commit)?;
    let (present, gone): (Vec<String>, Vec<String>) =
        gate.paths.iter().cloned().partition(|p| file_exists(p));
    ensure_scope_remainder(&present, &gone)?;
    let entries = fingerprint_scope(&present, read_file)?;
    write_stamp(st, store, change, &gate, actor, tool, &entries)
}

/// 跳过死档跳到一个不剩就不是「检查过」——工作树与工单严重脱节，fail-closed
/// 并指名文件与处置（两个盖章入口共用）。
fn ensure_scope_remainder<P: AsRef<str>>(remaining: &[P], gone: &[String]) -> Result<()> {
    if remaining.is_empty() {
        bail!(crate::command::Refusal(format!(
            "every scope file in the ticket is gone from the work tree ([{}]) — nothing \
             left to fingerprint; restore the files or discard the ticket",
            gone.join(", ")
        )));
    }
    Ok(())
}

/// 各轮 Scope 的联集：`\`→`/` 范式、去重、排序（决定性）。指纹范围的唯一
/// 定义——本地盖章与 remote CLI 的预算路径共走这里，两端不各写一份。
pub fn scope_union<'a>(scopes: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let mut paths: Vec<String> = scopes.into_iter().map(|p| p.replace('\\', "/")).collect();
    paths.sort();
    paths.dedup();
    paths
}

/// finding 路径违规的原因（add-round 写入前的路径检查）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathViolationReason {
    /// 路径在最后一个冒号后只剩行号写法——finding 只锚定到文件。
    LineNumber,
    /// 路径不在工单各轮 Scope 的联集加本轮 Scope 之内。
    OutOfScope,
}

/// 一条违规的 finding 路径（stdin 原文）与原因；Display 即 stderr 的逐条消息。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PathViolation {
    pub path: String,
    pub reason: PathViolationReason,
}

impl std::fmt::Display for PathViolation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.reason {
            PathViolationReason::LineNumber => write!(
                f,
                "{} — carries a line number; a finding path names the file only",
                self.path
            ),
            PathViolationReason::OutOfScope => write!(
                f,
                "{} — outside the ticket's scope (every round's `**Scope**:` plus this \
                 round's); anchor the finding on the in-scope file it concerns",
                self.path
            ),
        }
    }
}

/// add-round 写入前的 finding 路径检查（spec「finding 路径落在工单范围内」，两站
/// 同一规则）。纯函数：`existing` 为工单既有各轮（无工单时为空）；
/// `exempt_prefixes` 是免除范围检查的目录名（规格目录与 `.specseal`——它们不进
/// 验证 patch，复验的范围解析本来就略过），由调用端提供，因为规格目录名来自
/// 本机设置。与上一轮某条 finding 的 severity、路径、描述（去掉结尾
/// `(accepted)`）完全相同的行是沿用的未解项，不检查。内容文法错误回与
/// `add_round` 同一则 invalid_argv 错误。
pub fn finding_path_violations(
    st: &Station,
    existing: &[Round],
    content: &str,
    exempt_prefixes: &[&str],
) -> Result<Vec<PathViolation>> {
    let body = parse_round_body(st, content)
        .map_err(|e| crate::command::InvalidContent(e.to_string()))?;
    let scope =
        scope_union(existing.iter().flat_map(|r| &r.scope).chain(&body.scope).map(String::as_str));
    let carried: &[Finding] = existing.last().map(|r| r.findings.as_slice()).unwrap_or_default();
    let is_carried = |f: &Finding| {
        carried.iter().any(|c| {
            c.severity == f.severity
                && c.path == f.path
                && strip_accepted(&c.text) == strip_accepted(&f.text)
        })
    };
    let mut violations = Vec::new();
    for finding in body.findings.iter().filter(|f| !is_carried(f)) {
        let path = finding.path.replace('\\', "/");
        let reason = if has_line_suffix(&path) {
            PathViolationReason::LineNumber
        } else if !is_under_any(&path, exempt_prefixes) && !scope.contains(&path) {
            PathViolationReason::OutOfScope
        } else {
            continue;
        };
        violations.push(PathViolation { path: finding.path.clone(), reason });
    }
    Ok(violations)
}

/// 去掉 finding 描述结尾的 `(accepted)` 结构标记——沿用比对不计这个标记。
fn strip_accepted(text: &str) -> &str {
    text.strip_suffix("(accepted)").map(str::trim_end).unwrap_or(text)
}

/// 冒号后只剩行号写法的路径：`src/a.rs:42`、`src/a.rs:42-50`、`src/a.rs:42-`、
/// `src/a.rs:L42`，以及结尾单独的冒号。
fn has_line_suffix(path: &str) -> bool {
    path.rsplit_once(':').is_some_and(|(_, tail)| {
        tail.is_empty()
            || (tail.trim_start_matches(['L', 'l']).starts_with(|c: char| c.is_ascii_digit())
                && tail.chars().all(|c| c.is_ascii_digit() || matches!(c, '-' | 'L' | 'l')))
    })
}

fn is_under_any(path: &str, dirs: &[&str]) -> bool {
    dirs.iter().any(|d| path.strip_prefix(d).is_some_and(|rest| rest.starts_with('/')))
}

/// 逐档算内容指纹（`read_file` 收 repo-root 相对路径）。缺档 fail-closed——
/// 读不到就无从证明检查过的是哪份内容。路径在读取前过 repo-root 相对守门：
/// remote 模式的清单来自 server 回应，是外部输入。
pub fn fingerprint_scope(
    paths: &[String],
    read_file: &ScopeReadFn<'_>,
) -> Result<Vec<(String, String)>> {
    let mut entries = Vec::with_capacity(paths.len());
    for path in paths {
        ensure_repo_relative(path)?;
        let Some(content) = read_file(path) else {
            // 读不到可能是缺档，也可能是 I/O 失败（非 UTF-8 不是读取失败，
            // 走字节指纹）——只说事实。
            bail!("cannot read scope file '{path}' — it must be present and readable");
        };
        entries.push((path.clone(), content_fingerprint_bytes(&content)));
    }
    Ok(entries)
}

/// 两个盖章入口共用的守门结果：解析通过的 meta 原文、工单 Scope 联集
/// （`\`→`/` 范式、去重、排序）、任务锚总数、累加后的回合数，以及形状验过的 commit。
struct StampGate {
    raw_meta: String,
    paths: Vec<String>,
    tasks_total: usize,
    rounds: u64,
    commit: Option<String>,
}

fn stamp_gate(
    st: &Station,
    store: &dyn Store,
    change: &str,
    accept: bool,
    head_commit: Option<&str>,
) -> Result<StampGate> {
    ensure_single_segment(change)?;
    let commit = head_commit.map(crate::model::checked_commit).transpose()?;
    if !store.change_exists(change) {
        bail!(NotFound(format!("change not found: {change}")));
    }
    // Fail-closed gate（沿 set_board_rank）：文本手术前先解析，坏档不得被叠写。
    let raw_meta = store.read_change_meta(change).unwrap_or_default();
    let meta = crate::model::check_meta_text(store, change, Some(&raw_meta))?;
    let Some(ticket_text) = store.read_artifact(change, st.doc) else {
        bail!(NotFound(format!("no {} ticket for change '{change}'", st.noun)));
    };
    let ticket = parse_ticket(st, &ticket_text)?;

    // 守门 (1)：写码任务全数完成——`[M]` 手测任务不计（章＝验证过，成品定案的
    // 语意由封存承接）。零写码任务比照 archive gate 放行。
    let counts = crate::tasks::counts_for(store, change);
    if !counts.code_done() {
        bail!(crate::command::Refusal(format!(
            "change '{change}' has {}/{} code tasks complete — {} stamp \
             requires every code task done ([M] manual tasks excluded)",
            counts.code_complete, counts.code_total, st.noun
        )));
    }
    // 守门 (2)：末轮零待处理必修（CRITICAL／WARNING）findings；SUGGESTION 不挡章；
    // `--accept` 仅豁免此条。计数含带 `(accepted)` 的必修行（design D2：接受不豁免
    // 守门，只改走 `--accept`），故消息用 outstanding 而非 unresolved。
    let outstanding = ticket
        .last_round()
        .findings
        .iter()
        .filter(|f| f.severity != Severity::Suggestion)
        .count();
    if outstanding > 0 && !accept {
        bail!(crate::command::Refusal(format!(
            "the last round has {outstanding} outstanding must-fix finding(s) (CRITICAL/WARNING) \
             — fix and {}, or pass --accept to stamp with reservations",
            st.recheck
        )));
    }

    let paths =
        scope_union(ticket.rounds.iter().flat_map(|r| r.scope.iter().map(String::as_str)));
    // 回合数累加（process-cost-metrics D1）：章失效后重跑也是成本，原值缺席读作 0。
    let rounds =
        meta.stamp_rounds(st).unwrap_or(0).saturating_add(ticket.rounds.len() as u64);
    // 锚记全任务总数（含 `[M]`）——字段形状不变，旧章数据兼容。
    Ok(StampGate { raw_meta, paths, tasks_total: counts.total, rounds, commit })
}

fn write_stamp(
    st: &Station,
    store: &dyn Store,
    change: &str,
    gate: &StampGate,
    actor: Option<&str>,
    tool: Option<&str>,
    entries: &[(String, String)],
) -> Result<()> {
    // 文本手术（直接用 `KeyLines`，不走 `edit_meta`：meta 原文已由 `stamp_gate`
    // 读过并验过，且「先删工单再写章」要求写入前插一步删除）：先移除既有站别
    // 六键与回合数（重盖不留重复键、章永远落在档尾），再写新章；其余字段逐字节保留。
    let [at_key, by_key, with_key, tasks_total_key, scope_key, commit_key] = &st.stamp_keys();
    let rounds_key = &st.rounds_key();
    let mut m = KeyLines::whole(&gate.raw_meta);
    for key in [at_key, by_key, with_key, tasks_total_key, rounds_key, commit_key, scope_key] {
        m.remove(key);
    }
    // 身分／工具／指纹一律过 YAML 纯量守门（沿 started_* 的同一道）：带 `:`、
    // `#` 或换行的字符串会注入字段或炸掉整份 meta——而工单已在同一步删除，
    // 无从回复。
    m.set(at_key, &crate::util::now_rfc3339())?;
    if let Some(actor) = actor {
        m.set(by_key, &crate::util::yaml_scalar(actor))?;
    }
    if let Some(tool) = tool {
        m.set(with_key, &crate::util::yaml_scalar(tool))?;
    }
    m.set(tasks_total_key, &gate.tasks_total.to_string())?;
    m.set(rounds_key, &gate.rounds.to_string())?;
    if let Some(commit) = &gate.commit {
        m.set(commit_key, &crate::util::yaml_roundtrip_scalar(commit))?;
    }
    let body: Vec<String> = entries
        .iter()
        .flat_map(|(path, hash)| {
            [
                format!("  - path: {}", crate::util::yaml_scalar(path)),
                format!("    hash: {}", crate::util::yaml_scalar(hash)),
            ]
        })
        .collect();
    m.set_block(scope_key, &body)?;

    // 同一原子写入（design D3）：remote 走 bridge 的 staged commit 天然原子；
    // 本地顺序为先删工单再写章——中断时宁可退回「未检查」，也不得出现
    // 「章已写而工单仍在」的半套状态（spec 明文禁止的唯一中间态）。
    store.delete_artifact(change, st.doc)?;
    store.write_change_meta(change, &m.text())?;
    Ok(())
}

/// 文本指纹规则：CRLF→LF 范式后的 SHA-256（spec「内容指纹锚与失效判定」）。
/// 这是 [`content_fingerprint_bytes`] 分流后的文本分支——新调用端一律走那个
/// 唯一入口，不直接调用这里（原名原签名保留是 design D1：既有测试与消费端
/// 都在用）。两站共用同一实作——指纹规则比特级同构是 design D2 的硬性要求。
pub fn content_fingerprint(text: &str) -> String {
    hex_sha256(text.replace("\r\n", "\n").as_bytes())
}

/// 指纹计算的唯一入口——调用端一律用这个，UTF-8 判定不在各调用端重复
/// （spec「指纹分流表」）：可 UTF-8 解读 → 转呼文本规则（既有已落的章逐字节
/// 兼容）；不可解读 → 原始字节 SHA-256（不做行尾范式——binary 没有
/// 「行」，范式会让不同字节算出同一指纹）。
pub fn content_fingerprint_bytes(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(text) => content_fingerprint(text),
        Err(_) => hex_sha256(bytes),
    }
}

/// SHA-256 十六进位——两条指纹规则共用的输出形。
fn hex_sha256(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}

/// meta 是否带了可判定的完整章（缺席读作未盖章）。
pub fn is_stamped(anchors: StampAnchors<'_>) -> bool {
    anchors.tasks_total.is_some() && anchors.stamped_at.is_some() && !anchors.scope.is_empty()
}

/// [`StationStatus::freshness`] 的判定本体，附破锚原因。未盖章（见 [`is_stamped`]）与两锚皆符
/// 都回 None——调用端先以 `is_stamped` 分辨。`read_file` 为 None 时只判任务锚：
/// remote 封存信道无工作树可读，内容锚无从判定（design D5 的已知非对称）。
pub fn stale_reason(
    anchors: StampAnchors<'_>,
    counts: &crate::tasks::Counts,
    read_file: ScopeReader<'_>,
) -> Option<StaleReason> {
    let stamped_total = anchors.tasks_total?;
    if counts.total != stamped_total || !counts.code_done() {
        return Some(StaleReason::TaskAnchor {
            stamped_total,
            total: counts.total,
            code_complete: counts.code_complete,
            code_total: counts.code_total,
        });
    }
    let read_file = read_file?;
    anchors.scope.iter().find_map(|entry| match read_file(&entry.path) {
        Some(content) if content_fingerprint_bytes(&content) == entry.hash => None,
        _ => Some(StaleReason::ContentAnchor { path: entry.path.clone() }),
    })
}

/// 未结工单的处置说明（design D4／D5）——archive 守门对每个有未结工单的站别
/// 各产生一段，并列后成为拒绝消息。
pub fn open_ticket_disposal(st: &Station, name: &str) -> String {
    let (noun, phrase) = (st.noun, st.noun_phrase);
    // 指令栏对齐：标签长度随站别词变动（review／verification），宽度由最长标签
    // 决定——写死字段会让较长的站别词把指令挤歪。
    let labels = [
        format!("finish the {phrase} and stamp it:"),
        format!("abandon the {phrase}:"),
        "archive it as-is:".to_string(),
    ];
    let w = labels.iter().map(String::len).max().expect("three labels") + 2;
    format!(
        "change '{name}' has an open {noun} ticket ({}) — settle it before archiving:\n  \
         {:<w$}specseal {noun} stamp {name}\n  \
         {:<w$}specseal {noun} discard {name}\n  \
         {:<w$}specseal archive {name} --carry-{noun} \
         (permanently shown as {}-not-passed)",
        st.doc,
        labels[0],
        labels[1],
        labels[2],
        st.meta_prefix,
        w = w
    )
}

/// 沿 in-progress add／set_board_rank 的同款防护：change 名称必须是单一路径段，
/// 否则可能经 store 的相对路径触及 changes/ 外的文档。
fn ensure_single_segment(name: &str) -> Result<()> {
    if name.contains(['/', '\\', ':']) || name.contains("..") {
        bail!("invalid change name: {name}");
    }
    Ok(())
}

/// Scope 项须是 repo-root 相对路径：指纹读档以 `root.join(p)` 解析，绝对路径会
/// 整个取代 root、`..` 会爬出工作树。remote 模式的工单来自 server，若不守门即
/// 等于由 server 指定 client 读哪个本机档并把哈希回传——守门落在文法层，
/// stdin 与工单解析共用同一道。拿在线回应的 scope 去读工作树的用户端也过这一道。
pub fn ensure_repo_relative(path: &str) -> Result<()> {
    let normalized = path.replace('\\', "/");
    if normalized.starts_with('/')
        || normalized.split('/').any(|seg| seg == ".." || seg.contains(':'))
    {
        bail!(
            "scope path must be repo-root relative (no leading `/`, no `..`, \
             no drive letter): {path}"
        );
    }
    Ok(())
}

/// 一轮内容的解析结果（stdin 验证与 show 的轮次解析共用）。
struct RoundBody {
    scope: Vec<String>,
    findings: Vec<Finding>,
    phase: Option<RoundPhase>,
    patch_hash: Option<String>,
    rules: Option<ReviewConfig>,
}

/// 解析并验证一轮内容：非空 `**Scope**:` 清单＋合法 findings 行；结构化轮次
/// 另带成对的 `**Phase**:` 与 `**Patch**:`，discovery 轮可再带套用规则记录
/// （spec「工单的创建与追加」）。stdin 验证与 show 的轮次解析共用同一文法——
/// 动词产生的格式即动词验证的格式。
fn parse_round_body(st: &Station, content: &str) -> Result<RoundBody> {
    if content.trim().is_empty() {
        bail!("round content is empty — a round must carry a `**Scope**:` line");
    }
    let mut scope: Option<Vec<String>> = None;
    let mut findings = Vec::new();
    let mut phase: Option<RoundPhase> = None;
    let mut patch_hash: Option<String> = None;
    let mut baseline: Option<ReviewBaseline> = None;
    let mut rule_lines: Vec<(Severity, String)> = Vec::new();
    for line in content.lines() {
        let t = line.trim_start();
        if let Some(rest) = t.strip_prefix("**Scope**:") {
            if scope.is_some() {
                bail!("multiple `**Scope**:` lines in one round — one scope list per round");
            }
            let list: Vec<String> = rest
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect();
            if list.is_empty() {
                bail!("`**Scope**:` must list at least one repo-root relative path");
            }
            for path in &list {
                ensure_repo_relative(path)?;
            }
            scope = Some(list);
        } else if let Some(rest) = t.strip_prefix("**Phase**:") {
            if phase.is_some() {
                bail!("multiple `**Phase**:` lines in one round");
            }
            let token = rest.trim();
            phase = Some(RoundPhase::parse(token).ok_or_else(|| {
                anyhow!("unknown phase '{token}' — expected discovery or validation")
            })?);
        } else if let Some(rest) = t.strip_prefix("**Patch**:") {
            if patch_hash.is_some() {
                bail!("multiple `**Patch**:` lines in one round");
            }
            patch_hash = Some(ensure_patch_hash(rest.trim())?);
        } else if let Some(rest) = t.strip_prefix("**Rules**:") {
            if baseline.is_some() {
                bail!("multiple `**Rules**:` lines in one round — one applied-rules record per round");
            }
            let token = rest.trim();
            baseline = Some(ReviewBaseline::parse(token).ok_or_else(|| {
                anyhow!("unknown rules baseline '{token}' — expected extend or replace")
            })?);
        } else if let Some(rest) = t.strip_prefix("**Rule**:") {
            rule_lines.push(parse_rule(rest)?);
        } else if t.starts_with("##") && !t.starts_with("###") {
            // `## Round N` 是轮次分隔符——内容夹带二级标题会伪造轮次结构。
            bail!("round content must not contain `## ` headings (round delimiter): {t}");
        } else if t.starts_with("- [") {
            findings.push(parse_finding(t)?);
        }
    }
    if phase.is_some() != patch_hash.is_some() {
        bail!("`**Phase**:` and `**Patch**:` must appear together — a structured round \
               binds its phase to a frozen patch hash");
    }
    let rules = applied_rules(phase, baseline, rule_lines)?;
    let Some(scope) = scope else {
        bail!(
            "round content must contain a `**Scope**:` line listing the files {}",
            st.meta_prefix
        );
    };
    Ok(RoundBody { scope, findings, phase, patch_hash, rules })
}

/// 组出一轮的套用规则记录：`**Rule**:` 行需要同轮的 `**Rules**:`，带
/// `**Rules**:` 的轮必须是 discovery（复验不重新套用规则）。规则依严重度分组、
/// 组内保持出现顺序。
fn applied_rules(
    phase: Option<RoundPhase>,
    baseline: Option<ReviewBaseline>,
    rule_lines: Vec<(Severity, String)>,
) -> Result<Option<ReviewConfig>> {
    let Some(baseline) = baseline else {
        if !rule_lines.is_empty() {
            bail!("`**Rule**:` lines need a `**Rules**:` line in the same round");
        }
        return Ok(None);
    };
    if phase != Some(RoundPhase::Discovery) {
        bail!("applied rules are recorded only in a discovery round — `**Rules**:` needs \
               `**Phase**: discovery`");
    }
    let mut rules = ReviewConfig { baseline, ..ReviewConfig::default() };
    for (severity, text) in rule_lines {
        match severity {
            Severity::Critical => rules.critical.push(text),
            Severity::Warning => rules.warning.push(text),
            Severity::Suggestion => rules.suggestion.push(text),
        }
    }
    Ok(Some(rules))
}

/// 解析 `**Rule**:` 之后的值：`<SEVERITY> <规则原文>`，原文去头尾空白后须非空。
fn parse_rule(rest: &str) -> Result<(Severity, String)> {
    let rest = rest.trim();
    let (sev, text) = rest.split_once(char::is_whitespace).unwrap_or((rest, ""));
    let Some(severity) = Severity::parse(sev) else {
        bail!("unknown rule severity '{sev}' — expected CRITICAL, WARNING, or SUGGESTION");
    };
    let text = text.trim();
    if text.is_empty() {
        bail!("`**Rule**: {sev}` is missing the rule text — expected `**Rule**: <SEVERITY> <rule text>`");
    }
    Ok((severity, text.to_string()))
}

/// Patch 行的格式守门：`sha256:` ＋恰好 64 个小写十六进位字符。
fn ensure_patch_hash(s: &str) -> Result<String> {
    let hex = s
        .strip_prefix("sha256:")
        .ok_or_else(|| anyhow!("malformed patch hash '{s}' — expected `sha256:<64 hex>`"))?;
    if hex.len() != 64 || !hex.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()) {
        bail!("malformed patch hash '{s}' — expected exactly 64 lowercase hex digits");
    }
    Ok(s.to_string())
}

/// 解析一行 finding：`- [severity] path — 描述`。
fn parse_finding(line: &str) -> Result<Finding> {
    let rest = line.strip_prefix("- [").expect("caller matched the prefix");
    let Some((sev, tail)) = rest.split_once(']') else {
        bail!("malformed finding line (no closing `]`): {line}");
    };
    let Some(severity) = Severity::parse(sev) else {
        bail!("unknown severity '{sev}' — expected CRITICAL, WARNING, or SUGGESTION");
    };
    let Some((path, text)) = tail.trim_start().split_once(" — ") else {
        bail!("malformed finding line (expected `- [severity] path — text`): {line}");
    };
    Ok(Finding {
        severity,
        path: path.trim().to_string(),
        text: text.trim().to_string(),
    })
}

/// 解析整份工单：`## Round N` 分段，每段过同一轮文法。纯函数、无 I/O——
/// 桌面对封存原文与远程封存原文的解析也走这一份，工单文法只有一个实作。
pub fn parse_ticket(st: &Station, text: &str) -> Result<Ticket> {
    let mut rounds = Vec::new();
    let mut current: Option<(usize, String)> = None;
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("## Round ") {
            if let Some((index, body)) = current.take() {
                rounds.push(build_round(st, index, &body)?);
            }
            let index: usize = rest.trim().parse().map_err(|_| {
                anyhow!("malformed round header in {} ticket: {line}", st.noun)
            })?;
            current = Some((index, String::new()));
        } else if let Some((_, body)) = current.as_mut() {
            body.push_str(line);
            body.push('\n');
        }
    }
    if let Some((index, body)) = current.take() {
        rounds.push(build_round(st, index, &body)?);
    }
    if rounds.is_empty() {
        bail!("{} ticket has no rounds — corrupt document", st.noun);
    }
    Ok(Ticket { rounds })
}

fn build_round(st: &Station, index: usize, body: &str) -> Result<Round> {
    let body = parse_round_body(st, body)?;
    Ok(Round {
        index,
        phase: body.phase,
        patch_hash: body.patch_hash,
        rules: body.rules,
        scope: body.scope,
        findings: body.findings,
    })
}

#[cfg(test)]
mod tests;
