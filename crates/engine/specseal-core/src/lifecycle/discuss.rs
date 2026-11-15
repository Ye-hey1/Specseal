//! Discussion documents — a specseal extension: discussions are durable records.
//!
//! Each discussion is a single append-only document (stored by the Store as a
//! live discussion under its slug) so an iterative conversation accumulates a
//! durable record that `propose` can later consume. Archived discussions are
//! renamed by the store with a `<created>-` date prefix — like archived
//! changes — so a slug can be reused by a later discussion.

use crate::keylines::KeyLines;
use crate::store::{DiscussionDoc, Store};
use crate::util;
use anyhow::{bail, Result};
use serde::Serialize;
use std::path::PathBuf;

/// Why `new`, `link`, `seal` or `discard` turned a discussion write away,
/// for a host that answers it with a status (the HTTP door). The text is the
/// whole message. The command layer still files it as a plain error with
/// that text, so the CLI's output and exit code are what they were.
#[derive(Debug)]
pub struct WriteRefusal {
    pub kind: WriteRefusalKind,
    message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteRefusalKind {
    /// The discussion or the change does not exist.
    NotFound,
    /// A slug, a kind or a topic that cannot be one.
    Invalid,
    /// A guard: it exists already, it is archived, or the link is missing.
    Guard,
}

impl WriteRefusal {
    fn not_found(message: String) -> anyhow::Error {
        WriteRefusal { kind: WriteRefusalKind::NotFound, message }.into()
    }

    fn invalid(message: String) -> anyhow::Error {
        WriteRefusal { kind: WriteRefusalKind::Invalid, message }.into()
    }

    fn guard(message: String) -> anyhow::Error {
        WriteRefusal { kind: WriteRefusalKind::Guard, message }.into()
    }
}

impl std::fmt::Display for WriteRefusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for WriteRefusal {}

pub mod cuts;

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct DiscussionInfo {
    pub slug: String,
    pub topic: String,
    pub status: String,
    pub rounds: usize,
    pub created: String,
    /// 创建者（"Name <email>"），discuss new 由 git 身分盖章；缺席时省略。
    #[serde(rename = "createdBy", skip_serializing_if = "Option::is_none", default)]
    pub created_by: Option<String>,
    /// 讨论类型（目前唯一合法值 `improve`）；一般讨论缺席时省略。
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub kind: Option<String>,
    pub path: String,
    pub archived: bool,
    /// 自由字段（host-free-fields D5）；没有时省略，`discuss list --json` 逐比特不变。
    #[serde(skip_serializing_if = "std::collections::BTreeMap::is_empty", default)]
    pub fields: crate::fields::Fields,
    /// Conclusion 段是否已写入内文（占位注解不算）。不进 JSON（`discuss list --json`
    /// 逐比特不变）；反串行化取缺省。
    #[serde(skip)]
    pub concluded: bool,
    /// 同一趟 frontmatter 解析的类型化结果（`promoted_to`、`hold`、`board_rank` 都在
    /// 这里）：desktop 看板与 server 列表直接读它，不再逐卡读档。不进 JSON；反串行化
    /// 取缺省（remote 端由 wire DTO 回填 `promoted_to`）。
    #[serde(skip)]
    pub head: DiscussionHead,
}

/// `discuss new --kind` 的白名单——验证与拒绝消息的单一事实来源。
/// CLI `--kind` 的 help 字面（clap 静态字符串）另行点名合法值，扩充时同步。
pub const DISCUSSION_KINDS: &[&str] = &["improve"];

/// 讨论记录 frontmatter 的 `status` 三值枚举；手写坏值以 [`Status::Unknown`] 原字符串
/// 保留（读端不拒绝、投影逐比特回原字符串），三个转移方法把它视同 `Open`。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum Status {
    #[default]
    Open,
    Concluded,
    Promoted,
    Unknown(String),
}

impl Status {
    pub fn as_str(&self) -> &str {
        match self {
            Status::Open => "open",
            Status::Concluded => "concluded",
            Status::Promoted => "promoted",
            Status::Unknown(s) => s,
        }
    }

    /// 缺席沿现况缺省 `open`。
    fn from_field(value: Option<&str>) -> Status {
        match value {
            None | Some("open") => Status::Open,
            Some("concluded") => Status::Concluded,
            Some("promoted") => Status::Promoted,
            Some(other) => Status::Unknown(other.to_string()),
        }
    }
}

/// 讨论记录的 frontmatter，一次解析为九个字段；只管 frontmatter，Context／Rounds／
/// Conclusion 的区段函数另有落点。三条状态转移（[`promote`](Self::promote)、
/// [`unlink`](Self::unlink)、[`conclude`](Self::conclude)）是这里的方法，
/// [`write_back`](Self::write_back) 只把**有改动的** status／promoted_to／hold／
/// board_rank 写回 frontmatter 围栏内，其余字节（含内文撞字符串的 `status: open`、
/// 手改的 `hold: false`、没动到的字段的空白）逐字保留。
#[derive(Debug, Clone, Default)]
pub struct DiscussionHead {
    pub slug: Option<String>,
    pub topic: Option<String>,
    pub status: Status,
    pub created: Option<String>,
    pub created_by: Option<String>,
    pub kind: Option<String>,
    pub promoted_to: Vec<String>,
    pub hold: bool,
    pub board_rank: Option<String>,
    /// 自由字段（host-free-fields D2）：frontmatter 的 `fields` 区块，宽松读取。写入走
    /// [`crate::fields::edit_discussion`]，不经 [`write_back`](Self::write_back)。
    pub fields: crate::fields::Fields,
    /// frontmatter 区域；记录没有 frontmatter 时为 `None`。
    lines: Option<KeyLines>,
    /// 解析当下的四个可写字段——`write_back` 只写与它不同的字段。
    parsed: Parsed,
    /// `conclude` 与带 `last` 的 `promote` 对 hold 是明确重述：即使布尔值没变（例如
    /// 手写 `hold: yes` 读成 false、再 conclude(false) 或 promote(_, true)），任何
    /// `hold:` 行也整行移除。不带 `last` 的 `promote` 不重述。
    hold_restated: bool,
}

#[derive(Debug, Clone, Default)]
struct Parsed {
    status: Status,
    promoted_to: Vec<String>,
    hold: bool,
    board_rank: Option<String>,
}

impl DiscussionHead {
    /// 永远成功：没有 frontmatter 的记录回全缺省（status `Open`）。
    pub fn parse(text: &str) -> DiscussionHead {
        let lines = KeyLines::frontmatter(text);
        let get = |key: &str| lines.as_ref().and_then(|l| l.get(key)).map(str::to_string);
        // 空值 `kind:`／`board_rank:`（手改记录）范式为缺席，维持「缺席即省略」的形状。
        let non_empty = |key: &str| get(key).filter(|v| !v.is_empty());
        let parsed = Parsed {
            status: Status::from_field(get("status").as_deref()),
            promoted_to: lines.as_ref().map(|l| l.list("promoted_to")).unwrap_or_default(),
            // 只有字面 true 算旗标。
            hold: get("hold").is_some_and(|v| v == "true"),
            board_rank: non_empty("board_rank"),
        };
        DiscussionHead {
            slug: get("slug"),
            topic: get("topic"),
            status: parsed.status.clone(),
            created: get("created"),
            created_by: get("created_by"),
            kind: non_empty("kind"),
            promoted_to: parsed.promoted_to.clone(),
            hold: parsed.hold,
            board_rank: parsed.board_rank.clone(),
            fields: lines.as_ref().map(crate::fields::read).unwrap_or_default(),
            lines,
            parsed,
            hold_restated: false,
        }
    }

    /// 把**有改动的**可写字段同步回 frontmatter 后回整份文本；没改的字段一个比特
    /// 都不碰（`set_board_rank` 因此不会顺手补 `status: open` 或删 `hold: false`）。
    /// `Ok(None)`＝没有 frontmatter 可锚定——调用端沿既有 None 契约决定：
    /// `conclude --hold`／`set_board_rank` 回错误，其余动词不落档。
    /// `Err`＝frontmatter 未闭合（缺尾 `---`）而要新插的行无处可插——与「没有
    /// frontmatter」分开回报，调用端不得把它当成功。
    pub fn write_back(&self) -> Result<Option<String>> {
        let Some(mut lines) = self.lines.clone() else {
            return Ok(None);
        };
        if self.status != self.parsed.status {
            lines.set("status", self.status.as_str())?;
        }
        if self.promoted_to != self.parsed.promoted_to {
            if self.promoted_to.is_empty() {
                lines.remove("promoted_to");
            } else {
                lines.set("promoted_to", &self.promoted_to.join(", "))?;
            }
        }
        if self.hold_restated || self.hold != self.parsed.hold {
            if self.hold {
                lines.set("hold", "true")?;
            } else {
                lines.remove("hold");
            }
        }
        if self.board_rank != self.parsed.board_rank {
            if let Some(rank) = &self.board_rank {
                lines.set("board_rank", rank)?;
            }
        }
        Ok(Some(lines.text()))
    }

    /// 转出：status 由 Open／Concluded／Unknown 转 Promoted（已是 Promoted 不动）、
    /// `promoted_to` 去重累加。回 `true`＝累加了新名字；名字已在清单（re-ingest 旧变更
    /// 的 seal）回 `false`。`last`＝这是结论规划的最后一刀：不论名字新旧，都把 hold
    /// 明确重述为 false（`write_back` 因此整行移除 `hold:`）——名字已在清单也解除，
    /// 忘了在立最后一刀时带旗标，`seal --last` 才有一条不经 conclude 的补救路。
    /// 不带 `last` 的转出**不碰 hold**：旗标只由不带 `--hold` 的
    /// [`conclude`](Self::conclude)、`specseal discuss archive` 或带 `last` 的转出解除。
    pub fn promote(&mut self, change: &str, last: bool) -> bool {
        self.status = Status::Promoted;
        if last {
            self.hold = false;
            self.hold_restated = true;
        }
        if self.promoted_to.iter().any(|c| c == change) {
            return false;
        }
        self.promoted_to.push(change.to_string());
        true
    }

    /// discard 的解链：change 不在清单回 `None`（幂等、调用端不落档）；移除后仍有
    /// 名字 → 保持 Promoted；清单清空 → 移除 `promoted_to` 行、status 回退为
    /// `has_conclusion ? Concluded : Open`。回移除后的 status。`has_conclusion` 由
    /// 调用端以 `conclusion_body` 提供——head 不读内文。
    pub fn unlink(&mut self, change: &str, has_conclusion: bool) -> Option<Status> {
        let before = self.promoted_to.len();
        self.promoted_to.retain(|c| c != change);
        if self.promoted_to.len() == before {
            return None;
        }
        if self.promoted_to.is_empty() {
            self.status = if has_conclusion { Status::Concluded } else { Status::Open };
        }
        Some(self.status.clone())
    }

    /// 结论：Open／Unknown → Concluded（Promoted 保持、Concluded 不动）；`hold` 依参数设或清。
    pub fn conclude(&mut self, hold: bool) {
        if !matches!(self.status, Status::Promoted | Status::Concluded) {
            self.status = Status::Concluded;
        }
        self.hold = hold;
        self.hold_restated = true;
    }
}

/// 轮标题前缀：scaffold 版面（level-3）与 pre-scaffold 容忍（level-2）。
/// 辨识端（计数、跳脱、区段边界、discard 保护）与产生端（add_round）共用。
const SCAFFOLD_ROUND_PREFIX: &str = "### Round ";
const PRE_SCAFFOLD_ROUND_PREFIX: &str = "## Round ";

/// Fenced code block 围栏行（``` 或 ~~~ 开头；容忍前导空白）。围栏内的行不是
/// 结构——跳脱、计数与区段解析一致跳过。简化：不比对围栏长度与缩进细则，
/// 讨论记录引用版面的用途以此为足。
fn is_fence_line(line: &str) -> bool {
    let t = line.trim_start();
    t.starts_with("```") || t.starts_with("~~~")
}

/// 合法轮标题形状（scaffold 版面）：`### Round <编号> — <mode> (<日期>)`，
/// 与 UI splitRounds 的判准同形。跳脱后的内文行（行首带反斜线）与
/// 缺编号、缺 mode、缺日期括号的撞名行都不是轮。
fn is_scaffold_round_heading(line: &str) -> bool {
    let Some(rest) = line.strip_prefix(SCAFFOLD_ROUND_PREFIX) else {
        return false;
    };
    let digits = rest.chars().take_while(|c| c.is_ascii_digit()).count();
    if digits == 0 {
        return false;
    }
    let Some(tail) = rest[digits..].strip_prefix(" — ") else {
        return false;
    };
    // `<mode> (<date>)`：mode 与日期都非空。
    let t = tail.trim_end();
    match t.rfind(" (") {
        Some(i) => i > 0 && t.ends_with(')') && i + 2 < t.len() - 1,
        None => false,
    }
}

fn count_rounds(text: &str) -> usize {
    // `## Round ` tolerates pre-scaffold documents.
    let mut in_fence = false;
    text.lines()
        .filter(|l| {
            if is_fence_line(l) {
                in_fence = !in_fence;
                return false;
            }
            !in_fence
                && (is_scaffold_round_heading(l) || l.starts_with(PRE_SCAFFOLD_ROUND_PREFIX))
        })
        .count()
}

/// discard 的保护侦测：对形状宽松（任何轮标题前缀都算，含手改坏形状），
/// 与 [`count_rounds`] 的严格计数刻意分离——保护面误拒比误删安全。
/// 围栏内的引用不算：写入端保证围栏成对，围栏内容确定不是轮。
fn round_traces(text: &str) -> usize {
    let mut in_fence = false;
    text.lines()
        .filter(|l| {
            if is_fence_line(l) {
                in_fence = !in_fence;
                return false;
            }
            !in_fence
                && (l.starts_with(SCAFFOLD_ROUND_PREFIX)
                    || l.starts_with(PRE_SCAFFOLD_ROUND_PREFIX))
        })
        .count()
}

/// 结构标题白名单——只有这三个整行标题是讨论文档的区段边界；
/// 轮内文的其他「## 」行不是结构、不得截断区段。
const STRUCTURAL_HEADERS: &[&str] = &["## Context", "## Rounds", "## Conclusion"];

/// 区段边界：结构标题白名单，加 pre-scaffold 轮标题（`## Round ` 前缀）的容忍——
/// 内文的同形行经写入端跳脱必带反斜线，故未跳脱者必为结构。
fn is_section_boundary(line: &str) -> bool {
    STRUCTURAL_HEADERS.contains(&line) || line.starts_with(PRE_SCAFFOLD_ROUND_PREFIX)
}

/// Byte range of a structural section's body: after the `## <name>` line, up to the next
/// section boundary ([`is_section_boundary`]) or EOF. Content lines that merely start
/// with `## `, and any line inside a fenced code block, do not terminate the section.
/// `None` when the header is absent.
fn section_body_range(text: &str, name: &str) -> Option<(usize, usize)> {
    let header = format!("## {name}");
    let mut offset = 0;
    let mut start: Option<usize> = None;
    let mut in_fence = false;
    for line in text.split_inclusive('\n') {
        let trimmed = line.trim_end();
        if is_fence_line(trimmed) {
            in_fence = !in_fence;
        } else if !in_fence {
            if let Some(s) = start {
                if is_section_boundary(trimmed) {
                    return Some((s, offset));
                }
            } else if trimmed == header {
                start = Some(offset + line.len());
            }
        }
        offset += line.len();
    }
    start.map(|s| (s, text.len()))
}

/// 讨论内容写入动词共用的落盘前跳脱：撞名内容行（整行为结构标题，或行首为
/// 轮标题前缀）加 markdown 反斜线，使内容不可能被解读为文档结构。
/// 成对 fenced code block 内的行照原样保留（markdown 在围栏内不解跳脱）；
/// 围栏行为奇数时，最后一个落单的围栏行一并跳脱——落盘内容因此永远成对，
/// 全文档的围栏解析（section_body_range／count_rounds）得以保持健全。
/// 其他「# 」开头行维持原样（最小改动，非全面跳脱）。
fn escape_colliding_lines(content: &str) -> String {
    let fence_lines: Vec<usize> = content
        .split('\n')
        .enumerate()
        .filter(|(_, l)| is_fence_line(l.trim_end()))
        .map(|(i, _)| i)
        .collect();
    let dangling = (fence_lines.len() % 2 == 1).then(|| *fence_lines.last().unwrap());
    let mut in_fence = false;
    content
        .split('\n')
        .enumerate()
        .map(|(i, l)| {
            let t = l.trim_end();
            if is_fence_line(t) {
                if Some(i) == dangling {
                    return format!("\\{l}");
                }
                in_fence = !in_fence;
                return l.to_string();
            }
            if !in_fence
                && (STRUCTURAL_HEADERS.contains(&t)
                    || t.starts_with(SCAFFOLD_ROUND_PREFIX)
                    || t.starts_with(PRE_SCAFFOLD_ROUND_PREFIX))
            {
                format!("\\{l}")
            } else {
                l.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Replace a level-2 section's body, keeping its header. `None` when the section is absent.
fn replace_section(text: &str, name: &str, body: &str) -> Option<String> {
    let (s, e) = section_body_range(text, name)?;
    let tail = &text[e..];
    let mid = if tail.is_empty() {
        format!("\n{}\n", body.trim_end())
    } else {
        format!("\n{}\n\n", body.trim_end())
    };
    Some(format!("{}{}{}", &text[..s], mid, tail))
}

fn strip_html_comments(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(i) = rest.find("<!--") {
        out.push_str(&rest[..i]);
        match rest[i..].find("-->") {
            Some(j) => rest = &rest[i + j + 3..],
            None => rest = "",
        }
    }
    out.push_str(rest);
    out
}

fn info_from_doc(doc: &DiscussionDoc) -> DiscussionInfo {
    let head = DiscussionHead::parse(&doc.text);
    DiscussionInfo {
        slug: head.slug.clone().unwrap_or_else(|| doc.slug.clone()),
        topic: head.topic.clone().unwrap_or_else(|| doc.slug.clone()),
        status: head.status.as_str().to_string(),
        rounds: count_rounds(&doc.text),
        created: head.created.clone().unwrap_or_default(),
        created_by: head.created_by.clone(),
        kind: head.kind.clone(),
        path: util::to_slash(&doc.path),
        archived: doc.archived,
        fields: head.fields.clone(),
        concluded: conclusion_body(&doc.text).is_some(),
        head,
    }
}

/// Load a live discussion for mutation; a helpful error distinguishes "archived" from "missing".
fn load_live(store: &dyn Store, slug: &str) -> Result<String> {
    match store.read_live_discussion(slug) {
        Some(t) => Ok(t),
        None => {
            if store.archived_discussion_exists(slug) {
                bail!("discussion '{slug}' is archived — move it out of discussions/archive/ to continue it");
            }
            bail!("discussion '{slug}' not found — run `specseal discuss new` first")
        }
    }
}

/// Kebab-case gate for the slug override: lowercase ASCII letters/digits in
/// single-hyphen-separated runs. Deliberately stricter than the topic-derived
/// fallback (which keeps CJK) — the override exists to produce English names.
fn is_valid_slug_override(s: &str) -> bool {
    !s.is_empty()
        && !s.starts_with('-')
        && !s.ends_with('-')
        && !s.contains("--")
        && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// Create a new discussion document. Errors if a live one already exists.
/// `slug_override` names the record file directly (validated ASCII kebab-case);
/// without it the slug falls back to deriving from the topic. `kind` marks the
/// record's type (whitelist [`DISCUSSION_KINDS`]); absent means a plain discussion.
/// `fields` are the free fields the record starts with, in the frontmatter it is
/// created with; a field outside the rules creates nothing.
pub fn new_discussion(
    store: &dyn Store,
    topic: &str,
    slug_override: Option<&str>,
    created_by: Option<&str>,
    kind: Option<&str>,
    fields: &crate::fields::Fields,
) -> Result<DiscussionInfo> {
    crate::fields::check(fields)?;
    if let Some(k) = kind {
        if !DISCUSSION_KINDS.contains(&k) {
            return Err(WriteRefusal::invalid(format!(
                "invalid kind '{k}' — --kind accepts only: {}",
                DISCUSSION_KINDS.join(", ")
            )));
        }
    }
    // topic 逐字写入 frontmatter，夹带换行可注入伪造的 kind:/status: 行——
    // 在系统边界一次挡下整类注入。
    if topic.contains(['\n', '\r']) {
        return Err(WriteRefusal::invalid(format!(
            "invalid topic '{}' — must be a single line",
            topic.escape_debug()
        )));
    }
    let slug = match slug_override {
        Some(s) => {
            if !is_valid_slug_override(s) {
                return Err(WriteRefusal::invalid(format!(
                    "invalid slug '{s}' — must be ASCII kebab-case: lowercase letters/digits \
                     separated by single hyphens (e.g. board-search-bar)"
                )));
            }
            s.to_string()
        }
        None => util::slugify(topic),
    };
    if slug.is_empty() {
        return Err(WriteRefusal::invalid(format!("could not derive a slug from topic '{topic}'")));
    }
    if store.live_discussion_exists(&slug) {
        return Err(WriteRefusal::guard(format!(
            "discussion '{slug}' already exists at {}",
            util::to_slash(&store.live_discussion_path(&slug))
        )));
    }
    let created = util::today();
    // 创建者章（比照 change 的 newcmd）：有 git 身分才盖，无身分省略该行。
    let created_by_line = created_by
        .map(|id| format!("created_by: {id}\n"))
        .unwrap_or_default();
    // kind 已过白名单，写出的必是常数字串（无 YAML 跳脱顾虑）；缺席时整行不存在。
    let kind_line = kind.map(|k| format!("kind: {k}\n")).unwrap_or_default();
    let fields_block = crate::fields::block_text(fields);
    let content = format!(
        "---\n\
         topic: {topic}\n\
         slug: {slug}\n\
         status: open\n\
         created: {created}\n\
         {created_by_line}\
         {kind_line}\
         {fields_block}\
         ---\n\
         \n\
         # Discussion: {topic}\n\
         \n\
         <!--\n\
         Document rules:\n\
         - Rounds are appended by `specseal discuss add-round`; never rewrite an earlier round.\n\
         \x20 A changed position gets a new round that names what changed and why.\n\
         - Each round distills one focus question: **Focus** / **Position** / **Ruled out** / **Open**.\n\
         - The conclusion must resolve or explicitly defer every open question left by the rounds.\n\
         -->\n\
         \n\
         ## Context\n\
         \n\
         <!-- What prompted this discussion, whether a grill stage was needed and why,\n\
         and the related changes/specs. Set once via `specseal discuss context <slug> --stdin`. -->\n\
         \n\
         ## Rounds\n\
         \n\
         <!-- `### Round N — <mode> (<date>)` entries are appended here by the CLI. -->\n\
         \n\
         ## Conclusion\n\
         \n\
         <!-- Written by `specseal discuss conclude`:\n\
         **Decision** / **Rationale** / **Rejected alternatives** / **Deferred** / **Capture to** / **Next** -->\n"
    );
    let path = store.write_live_discussion(&slug, &content)?;
    Ok(DiscussionInfo {
        slug,
        topic: topic.to_string(),
        status: "open".to_string(),
        rounds: 0,
        created,
        created_by: created_by.map(str::to_string),
        kind: kind.map(str::to_string),
        path: util::to_slash(&path),
        archived: false,
        fields: fields.clone(),
        concluded: false,
        head: DiscussionHead::parse(&content),
    })
}

/// List live discussions (sorted by slug).
pub fn list_discussions(store: &dyn Store) -> Vec<DiscussionInfo> {
    let mut out: Vec<DiscussionInfo> = store
        .list_live_discussions()
        .iter()
        .map(info_from_doc)
        .collect();
    out.sort_by(|a, b| a.slug.cmp(&b.slug));
    out
}

/// Every live discussion whose Conclusion holds content, with that content as
/// [`conclusion_text`] returns it (HTML comments stripped) — each record read
/// once, so its conclusion and its `promoted_to` come from the same document,
/// in [`list_discussions`] order.
pub fn live_conclusions(store: &dyn Store) -> Vec<(DiscussionInfo, String)> {
    let mut out: Vec<(DiscussionInfo, String)> = store
        .list_live_discussions()
        .iter()
        .filter_map(|doc| Some((info_from_doc(doc), conclusion_body(&doc.text)?)))
        .collect();
    out.sort_by(|a, b| a.0.slug.cmp(&b.0.slug));
    out
}

/// List archived discussions (sorted by archived file name, i.e. by archive date).
pub fn list_archived(store: &dyn Store) -> Vec<DiscussionInfo> {
    let mut out: Vec<DiscussionInfo> = store
        .list_archived_discussions()
        .iter()
        .map(info_from_doc)
        .collect();
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

/// 记录的 info 与全文，取自同一次读取（server 以两者计算详情回应的 `cuts`，见 [`record_cuts`]）。
pub fn show(store: &dyn Store, slug: &str) -> Option<(DiscussionInfo, String)> {
    store.read_discussion(slug).map(|d| (info_from_doc(&d), d.text))
}

pub fn info(store: &dyn Store, slug: &str) -> Option<DiscussionInfo> {
    store.read_discussion(slug).map(|d| info_from_doc(&d))
}

/// One keyword hit inside a discussion record (`discuss search`, design D3):
/// `kind` names what matched (topic / slug / ruled-out / decision / rejected /
/// deferred), `where_` names where (frontmatter / round-N / conclusion) and
/// `text` is the matched line, outer whitespace trimmed. Serialize-only: the
/// remote CLI rebuilds it from the wire type by hand.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DiscussionMatch {
    pub kind: String,
    #[serde(rename = "where")]
    pub where_: String,
    pub text: String,
}

/// One record that `discuss search` matched: the listing fields plus every
/// match in document order. `info` flattens so `--json` reads as the list
/// payload's item with a `matches` array appended.
#[derive(Debug, Clone, Serialize)]
pub struct DiscussionHit {
    #[serde(flatten)]
    pub info: DiscussionInfo,
    pub matches: Vec<DiscussionMatch>,
}

/// Decision-line markers (design D2): the round-side one and the three
/// conclusion-side ones, each with the `kind` it reports.
const RULED_OUT_MARKER: &str = "**Ruled out**:";
/// 结论字段的标签行前缀——搜索（[`CONCLUSION_MARKERS`]）与分刀解析（[`cuts`]）共用。
const DECISION_LABEL: &str = "**Decision**:";
const REJECTED_LABEL: &str = "**Rejected alternatives**:";
const DEFERRED_LABEL: &str = "**Deferred**:";
const CONCLUSION_MARKERS: &[(&str, &str)] = &[
    (DECISION_LABEL, "decision"),
    (REJECTED_LABEL, "rejected"),
    (DEFERRED_LABEL, "deferred"),
];

/// Search live and archived discussions for any of `terms` (case-insensitive
/// substring; any term hitting counts). Every term is split on whitespace
/// first — the server's `q` arrives that way and the CLI's quoted argument
/// must mean the same thing — so a keyword can never contain a space. Only
/// the topic, the slug and the decision lines take part: each round's
/// `**Ruled out**:` line and the Conclusion's `**Decision**:` /
/// `**Rejected alternatives**:` / `**Deferred**:` line, each together with
/// the list-item lines that directly continue it (records habitually put
/// the marker on its own line and the verdicts as bullets under it).
/// Evidence, Focus, Position, Open and prose never match. A record without
/// round headings or a Conclusion still matches by topic and slug. Hits sort
/// with topic/slug hits first, then created newest first, then slug.
pub fn search(store: &dyn Store, terms: &[String]) -> Result<Vec<DiscussionHit>> {
    let needles: Vec<String> = terms
        .iter()
        .flat_map(|t| t.split_whitespace())
        .map(str::to_lowercase)
        .collect();
    if needles.is_empty() {
        bail!("discuss search needs at least one keyword");
    }
    let hits_any = |text: &str| {
        let lower = text.to_lowercase();
        needles.iter().any(|n| lower.contains(n.as_str()))
    };

    let mut docs = store.list_live_discussions();
    docs.extend(store.list_archived_discussions());
    // (topic or slug hit, hit) — the flag is the first sort key.
    let mut hits: Vec<(bool, DiscussionHit)> = docs
        .iter()
        .filter_map(|doc| {
            let info = info_from_doc(doc);
            let mut matches = Vec::new();
            for (kind, value) in [("topic", &info.topic), ("slug", &info.slug)] {
                if hits_any(value) {
                    matches.push(DiscussionMatch {
                        kind: kind.to_string(),
                        where_: "frontmatter".to_string(),
                        text: value.clone(),
                    });
                }
            }
            let frontmatter_hit = !matches.is_empty();
            matches.extend(decision_lines(&doc.text).filter(|m| hits_any(&m.text)));
            (!matches.is_empty()).then_some((frontmatter_hit, DiscussionHit { info, matches }))
        })
        .collect();
    hits.sort_by(|(a_fm, a), (b_fm, b)| {
        b_fm.cmp(a_fm)
            .then_with(|| b.info.created.cmp(&a.info.created))
            .then_with(|| a.info.slug.cmp(&b.info.slug))
    });
    Ok(hits.into_iter().map(|(_, hit)| hit).collect())
}

/// Every decision line of a record in document order, each tagged with its
/// kind and location. A `**Ruled out**:` marker counts only under a round
/// heading (its number comes from the nearest heading above); the three
/// conclusion markers count only inside `## Conclusion`. The list-item lines
/// directly under a counted marker belong to it (same kind and location, one
/// match per line); any other line — blank, prose, another `**Field**:` —
/// ends that block. Structure is read exactly as [`count_rounds`] and
/// [`section_body_range`] read it: headings at column 0 only, a malformed
/// round heading is no round, fenced code is skipped.
fn decision_lines(text: &str) -> impl Iterator<Item = DiscussionMatch> + '_ {
    let mut in_fence = false;
    let mut round: Option<String> = None;
    let mut in_conclusion = false;
    // The counted marker whose list items are still being collected.
    let mut continuing: Option<(&'static str, String)> = None;
    text.lines().filter_map(move |raw| {
        let line = raw.trim_end();
        if is_fence_line(line) {
            in_fence = !in_fence;
            continuing = None;
            return None;
        }
        if in_fence {
            return None;
        }
        if line.starts_with(SCAFFOLD_ROUND_PREFIX) || line.starts_with(PRE_SCAFFOLD_ROUND_PREFIX) {
            round = round_number(line);
            in_conclusion = false;
            continuing = None;
            return None;
        }
        if STRUCTURAL_HEADERS.contains(&line) {
            in_conclusion = line == "## Conclusion";
            round = None;
            continuing = None;
            return None;
        }
        let content = line.trim_start();
        let marker = if content.starts_with(RULED_OUT_MARKER) {
            round.as_ref().map(|n| ("ruled-out", format!("round-{n}")))
        } else if in_conclusion {
            CONCLUSION_MARKERS
                .iter()
                .find(|(marker, _)| content.starts_with(marker))
                .map(|(_, kind)| (*kind, "conclusion".to_string()))
        } else {
            None
        };
        if let Some((kind, where_)) = marker {
            continuing = Some((kind, where_.clone()));
            return Some(DiscussionMatch { kind: kind.to_string(), where_, text: content.to_string() });
        }
        if is_list_item(content) {
            return continuing.as_ref().map(|(kind, where_)| DiscussionMatch {
                kind: kind.to_string(),
                where_: where_.clone(),
                text: content.to_string(),
            });
        }
        continuing = None;
        None
    })
}

/// A markdown list item (`- `, `* `, `+ ` or `1. `) — the shape a decision
/// marker's continuation lines take.
fn is_list_item(content: &str) -> bool {
    if content.starts_with("- ") || content.starts_with("* ") || content.starts_with("+ ") {
        return true;
    }
    let digits = content.chars().take_while(|c| c.is_ascii_digit()).count();
    digits > 0 && content[digits..].starts_with(". ")
}

/// The number of a round heading — scaffold `### Round N — <mode> (<date>)`
/// or pre-scaffold `## Round N` — and `None` for a malformed one, which
/// [`count_rounds`] does not count either.
fn round_number(line: &str) -> Option<String> {
    let rest = if is_scaffold_round_heading(line) {
        line.strip_prefix(SCAFFOLD_ROUND_PREFIX)?
    } else {
        line.strip_prefix(PRE_SCAFFOLD_ROUND_PREFIX)?
    };
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    (!digits.is_empty()).then_some(digits)
}

/// Reject blank content at the write boundary. The CLI turns a forgotten `--stdin` into an
/// empty string, so guarding here — one place, covering local CLI / remote CLI / desktop —
/// makes that silent failure a loud error instead of a written-but-empty section.
fn ensure_content(content: &str) -> Result<()> {
    if content.trim().is_empty() {
        bail!("discussion content is empty — pass non-empty content via stdin (did you forget --stdin?)");
    }
    Ok(())
}

/// Set (or replace) the `## Context` section — the one-time framing written after mode pick.
pub fn set_context(store: &dyn Store, slug: &str, content: &str) -> Result<()> {
    ensure_content(content)?;
    let content = escape_colliding_lines(content);
    let text = load_live(store, slug)?;
    match replace_section(&text, "Context", &content) {
        Some(t) => {
            store.write_live_discussion(slug, &t)?;
            Ok(())
        }
        None => bail!(
            "discussion '{slug}' has no '## Context' section (pre-scaffold layout) — edit the file directly"
        ),
    }
}

/// Append a discussion round. Content is supplied verbatim (from the skill via stdin).
pub fn add_round(store: &dyn Store, slug: &str, mode: &str, content: &str) -> Result<usize> {
    ensure_content(content)?;
    let content = escape_colliding_lines(content);
    let mut text = load_live(store, slug)?;
    let round_no = count_rounds(&text) + 1;
    let date = util::today();
    // Scaffolded layout: insert at the end of the `## Rounds` section. Pre-scaffold
    // documents fall back to appending a level-2 round at the end.
    if let Some((_, e)) = section_body_range(&text, "Rounds") {
        let entry = format!(
            "{SCAFFOLD_ROUND_PREFIX}{round_no} — {mode} ({date})\n\n{}\n\n",
            content.trim_end()
        );
        text.insert_str(e, &entry);
    } else {
        if !text.ends_with('\n') {
            text.push('\n');
        }
        text.push_str(&format!(
            "\n{PRE_SCAFFOLD_ROUND_PREFIX}{round_no} — {mode} ({date})\n\n{}\n",
            content.trim_end()
        ));
    }
    store.write_live_discussion(slug, &text)?;
    Ok(round_no)
}

/// The text of the `## Conclusion` section, if the discussion has one (the scaffold's
/// placeholder comment does not count as content).
pub fn conclusion_text(store: &dyn Store, slug: &str) -> Option<String> {
    conclusion_body(&store.read_discussion(slug)?.text)
}

/// The cuts in a record's conclusion with their promotion state, in conclusion
/// order — the one entry point the server's discussion detail and the desktop
/// read. `text` and `promoted_to` MUST come from the same read of the same
/// record (`read_discussion`'s text and its head), as in [`live_conclusions`].
/// No conclusion, or no cut in it, gives an empty list.
pub fn record_cuts(text: &str, promoted_to: &[String]) -> Vec<cuts::RecordCut> {
    conclusion_body(text)
        .map(|c| cuts::parse_cuts(&c).into_iter().map(|cut| cut.record(promoted_to)).collect())
        .unwrap_or_default()
}

fn conclusion_body(text: &str) -> Option<String> {
    let (s, e) = section_body_range(text, "Conclusion")?;
    let body = strip_html_comments(&text[s..e]).trim().to_string();
    (!body.is_empty()).then_some(body)
}

/// Mark a discussion as promoted to a change (the discussion side of the bidirectional link).
/// A discussion can fan out into several changes, so `promoted_to` is a comma-separated
/// accumulator: repeated promotes append the new change name rather than being dropped.
/// Accumulating a change leaves the record's `hold: true` flag alone unless `last` says
/// this is the final cut the conclusion planned: a staged series spins out several cuts
/// from one record, the flag outlives every cut but the last, and the last cut's spin-out
/// drops it so the final archive co-archives the record. Without `last`, only a
/// `conclude` without `--hold` or a manual `specseal discuss archive` releases it.
pub fn mark_promoted(store: &dyn Store, slug: &str, change: &str, last: bool) -> Result<()> {
    if let Some(out) = promoted_text(store, slug, change, last)? {
        store.write_live_discussion(slug, &out)?;
    }
    Ok(())
}

/// The dry run of [`mark_promoted`]: the record text after the `promote` transition,
/// not yet written. `Ok(None)` = the record has no frontmatter to anchor the link (the
/// verb leaves it untouched); `Err` = the frontmatter is unclosed and the link line has
/// nowhere to go. Callers that create a change first (`promote`, `new change
/// --from-discussion`) run this BEFORE the change lands, so that failure cannot leave a
/// half-built change behind that a retry then trips over.
///
/// All three spin-out paths (promote, `new change --from-discussion`, seal) come through
/// here, so one rule covers them: spinning out keeps the `hold: true` flag unless `last`
/// is set, in which case the same write drops it (see [`DiscussionHead::promote`]).
/// `link` writes no discussion side and keeps the record byte-identical. A held record
/// therefore stays live across the whole staged series until the last cut is spun out
/// with `--last`; a series that forgot the flag is still ended by one
/// `specseal discuss archive <slug>`.
pub fn promoted_text(store: &dyn Store, slug: &str, change: &str, last: bool) -> Result<Option<String>> {
    let text = load_live(store, slug)?;
    let mut head = DiscussionHead::parse(&text);
    head.promote(change, last);
    head.write_back()
}

/// The discard-side inverse of [`mark_promoted`]: unlink a discarded change from a
/// discussion. Removes the change name from the record's `promoted_to` comma
/// accumulator; when other change names remain the record stays `promoted`, but once
/// the list empties the `promoted_to` line is dropped and the status reverts — to
/// `concluded` when the record carries a real conclusion, else `open` (a promote/link
/// can raise an `open` discussion, so the revert restores its true prior state). The
/// Context/Rounds/Conclusion sections are never touched — only the frontmatter link
/// fields change (same layer `mark_promoted` writes). Returns the record's status
/// after unlinking (`"promoted"` when merely shrunk, else the reverted status), or
/// `None` when there was nothing to do: no live record for the slug (skipped, not an
/// error — the record may be archived or gone), or the change was not in the list
/// (idempotent — re-running discard leaves an already-unlinked record byte-identical).
pub fn unlink_discarded(store: &dyn Store, slug: &str, change: &str) -> Result<Option<String>> {
    let Some(text) = store.read_live_discussion(slug) else {
        return Ok(None);
    };
    let mut head = DiscussionHead::parse(&text);
    let Some(status) = head.unlink(change, conclusion_body(&text).is_some()) else {
        // change was never linked here — idempotent no-op, no write
        return Ok(None);
    };
    // Nothing written (no frontmatter to anchor) → report nothing done, never a status
    // the file does not carry.
    let Some(out) = head.write_back()? else {
        return Ok(None);
    };
    store.write_live_discussion(slug, &out)?;
    Ok(Some(status.as_str().to_string()))
}

/// Stamp the re-ingest-pending flag on every **active** change in a re-concluded
/// discussion's `promoted_to`. The conclude-side mirror of [`unlink_discarded`]: a
/// discussion that was already reflected (its `promoted_to` is non-empty because
/// `seal` wrote it) and is now re-concluded flags each of its changes as stale
/// against the new conclusion. Change names that resolve to no active meta —
/// archived or gone — are skipped (their spec deltas are already in canon; a
/// re-ingest is impossible). Each active change's `restale_from` comma accumulator
/// gains this slug (idempotent: already present skips the write). Returns the active
/// change names carrying the flag, for CLI reporting. `promoted_to` absent/empty, or
/// resolving entirely to non-active changes, writes no change meta.
fn stamp_restale(store: &dyn Store, slug: &str, discussion_text: &str) -> Result<Vec<String>> {
    let mut flagged = Vec::new();
    for change in &DiscussionHead::parse(discussion_text).promoted_to {
        // 已旗标的 change 幂等（`push_list` 不改、`edit_meta` 不写），仍列入回报。
        match crate::model::edit_meta(store, change, |m| m.push_list("restale_from", slug)) {
            Ok(Some(_)) => flagged.push(change.to_string()),
            Ok(None) => continue, // archived or gone — not an active change, skip
            // 坏 metadata 卡跳过（沿 archived/gone 的 skip 原则）：不得对坏档
            // 叠写，也不得使 conclude 因单一坏档中止——用户修档后重新 conclude。
            Err(e) if e.downcast_ref::<crate::model::MetaError>().is_some() => continue,
            Err(e) => return Err(e),
        }
    }
    Ok(flagged)
}

/// Clear one discussion slug from a change's `restale_from` accumulator — the seal-side
/// inverse of [`stamp_restale`]. When the slug is the sole value the whole line is
/// dropped; otherwise the remaining slugs are kept. The slug being absent (or no
/// `restale_from` field at all) is an idempotent no-op that skips the write. Only the
/// `restale_from` field is touched; every other meta field stays byte-identical.
fn clear_restale(store: &dyn Store, change: &str, slug: &str) -> Result<()> {
    // 深度防御：唯一调用者 seal 已对坏 metadata 守门，此处到达即应可解析；
    // 万一未来添加未守门的调用者，`edit_meta` fail closed 而非静默叠写。
    // change 不存在（`None`）与 slug 不在清单都是幂等无写入。
    crate::model::edit_meta(store, change, |m| {
        m.remove_list("restale_from", slug)
    })?;
    Ok(())
}

/// Outcome of promoting a discussion into a change.
#[derive(Debug)]
pub struct PromoteOutcome {
    pub change: String,
    pub path: PathBuf,
}

/// Strip an archive-style `YYYY-MM-DD-` prefix from a candidate change name —
/// archived names are historical references, not active names to reuse. Kept
/// only when something remains after the prefix.
fn strip_date_prefix(name: &str) -> &str {
    crate::util::strip_date_prefix(name)
}

/// Promote a discussion into a new change (the whole flow, shared by CLI and
/// desktop): refuse archived records, derive the change name (explicit name or
/// the slug, minus any archive date prefix), create the change with a
/// `from_discussion` link, prefill the proposal's Why from the conclusion
/// (topic as fallback), and mark the discussion promoted. Any failure before a
/// step leaves the later steps unexecuted, so a name collision never marks the
/// discussion.
pub fn promote(
    store: &dyn Store,
    slug: &str,
    name: Option<&str>,
    actor: Option<&str>,
    last: bool,
) -> Result<PromoteOutcome> {
    promote_with_fields(store, slug, name, actor, last, &crate::fields::Fields::new())
}

/// [`promote`], and the change it creates starts with the free fields
/// `fields` (in the metadata document it is created with). A field outside
/// the rules fails before anything is written.
pub fn promote_with_fields(
    store: &dyn Store,
    slug: &str,
    name: Option<&str>,
    actor: Option<&str>,
    last: bool,
    fields: &crate::fields::Fields,
) -> Result<PromoteOutcome> {
    match info(store, slug) {
        None => bail!("discussion '{slug}' not found — run `specseal discuss new` first"),
        Some(i) if i.archived => {
            bail!("discussion '{slug}' is archived — move it out of discussions/archive/ to promote it")
        }
        Some(_) => {}
    }
    let change_name = strip_date_prefix(name.unwrap_or(slug)).to_string();
    // The discussion-side link is computed first: a record that cannot take it fails
    // here, before any change directory lands (a retry would otherwise hit "already
    // exists" on a half-built change).
    let linked = promoted_text(store, slug, &change_name, last)?;
    let schema =
        crate::config::WorkflowConfig::from_store(store)?
            .schema_name();
    let dir = crate::newcmd::new_change(store, &change_name, None, &schema, None, Some(slug), actor, fields)?;
    // Prefill the proposal's Why from the discussion conclusion (topic as fallback);
    // the remaining sections stay as TBD markers for /specseal-propose to complete.
    let why = conclusion_text(store, slug).unwrap_or_else(|| {
        info(store, slug).map(|i| i.topic).unwrap_or_else(|| slug.to_string())
    });
    let proposal = format!(
        "## Why\n\n{why}\n\n## What Changes\n\n<!-- TBD: derive from the discussion -->\n\n## Capabilities\n\n### New Capabilities\n\n<!-- TBD -->\n\n## Impact\n\n<!-- TBD -->\n"
    );
    store.write_artifact(&change_name, "proposal.md", &proposal)?;
    if let Some(out) = linked {
        store.write_live_discussion(slug, &out)?;
    }
    Ok(PromoteOutcome { change: change_name, path: dir })
}

/// Link a discussion to an EXISTING change — the ingest-side counterpart of
/// `promote` (which scaffolds a new change). Forges ONLY the change-side chain:
/// `from_discussion` in the change metadata. Marking the discussion promoted is
/// NOT done here — that reflection is sealed by [`seal`] once ingest has folded
/// the discussion's content in, so a linked-but-unfilled change never reads as
/// "已转出". The discussion record is left byte-identical by this call. Archive
/// co-travel still engages: it is driven by the change-side `from_discussion`,
/// not by the discussion's status.
/// The discussion↔change relationship is many-to-many: a change already born of
/// one discussion can be re-linked to a later one (an ingest that revisits an
/// earlier decision), so `from_discussion` is a comma-separated accumulator that
/// appends rather than rejecting. Guards run before any write (a rejection leaves
/// the change meta byte-identical); re-linking the same pair is an idempotent
/// success that skips the change-side write.
pub fn link(store: &dyn Store, slug: &str, change: &str) -> Result<()> {
    match info(store, slug) {
        None => {
            return Err(WriteRefusal::not_found(format!(
                "discussion '{slug}' not found — run `specseal discuss new` first"
            )))
        }
        Some(i) if i.archived => {
            return Err(WriteRefusal::guard(format!(
                "discussion '{slug}' is archived — move it out of discussions/archive/ to link it"
            )))
        }
        Some(_) => {}
    }
    // Fail-closed gate lives in `edit_meta`: corrupt metadata must not read as
    // "no source discussion" and take the from_discussion write. A chain already
    // forged for this slug is idempotent — `push_list` leaves the text alone and
    // nothing is written.
    let linked =
        crate::model::edit_meta(store, change, |m| m.push_list("from_discussion", slug))?;
    if linked.is_none() {
        return Err(WriteRefusal::not_found(format!("Change '{change}' not found.")));
    }
    Ok(())
}

/// 内容落地后的封印：把讨论标记已转出（status: promoted、promoted_to 累加变更名）。
/// `link` 只铸变更侧链、不再翻状态——「标记已转出」的职责移交本动词，由 ingest 于
/// artifacts 落地完成时调用。前置守卫全数通过方写入：讨论存在且未封存、变更存在、且
/// 变更 meta 的 from_discussion 清单已含该 slug（链须先由 link／promote／new change
/// 铸妥）。守卫失败回可记录的 Err，两侧文件逐比特不变。幂等：promoted_to 已含该变更名
/// 时 `mark_promoted` 改写等值内容。
pub fn seal(store: &dyn Store, slug: &str, change: &str, last: bool) -> Result<()> {
    match info(store, slug) {
        None => {
            return Err(WriteRefusal::not_found(format!(
                "discussion '{slug}' not found — run `specseal discuss new` first"
            )))
        }
        Some(i) if i.archived => {
            return Err(WriteRefusal::guard(format!(
                "discussion '{slug}' is archived — move it out of discussions/archive/ to seal it"
            )))
        }
        Some(_) => {}
    }
    let Some(meta) = store.read_change_meta(change) else {
        return Err(WriteRefusal::not_found(format!("Change '{change}' not found.")));
    };
    // Fail-closed gate: a corrupt document must report itself, not a missing
    // from_discussion chain.
    let parsed = crate::model::check_meta_text(store, change, Some(&meta))?;
    if !parsed
        .from_discussions()
        .iter()
        .any(|s| s == slug)
    {
        return Err(WriteRefusal::guard(format!(
            "Change '{change}' is not linked to discussion '{slug}' — run `specseal discuss link` first."
        )));
    }
    mark_promoted(store, slug, change, last)?;
    // Sealing is the honest "content landed" act: clear this discussion's re-ingest flag
    // from the change (the seal-side inverse of the conclude-time stamp). Per-slug — a
    // change stale against another discussion keeps that slug pending its own re-seal.
    clear_restale(store, change, slug)
}

/// 写入（或原位更新）一笔 live 讨论的看板排序键：既有 `board_rank:` 行原位代换
/// （多出来的重复键一并收掉，与读端只认第一行的看法对齐），否则插入 frontmatter
/// 尾端（closing `---` 前）；其余内容逐字节保留。走 [`DiscussionHead`]，
/// 非法 rank、封存或不存在的讨论、无 frontmatter 可插皆回明确错误（封存记录不上看板）。
pub fn set_board_rank(store: &dyn Store, slug: &str, rank: &str) -> Result<()> {
    if !crate::util::is_valid_board_rank(rank) {
        bail!("invalid board rank '{rank}' — lowercase ASCII letters only");
    }
    let text = load_live(store, slug)?;
    let mut head = DiscussionHead::parse(&text);
    head.board_rank = Some(rank.to_string());
    let Some(out) = head.write_back()? else {
        bail!("discussion '{slug}' has no frontmatter — cannot set board rank");
    };
    store.write_live_discussion(slug, &out)?;
    Ok(())
}

/// The change names a discussion has fanned out into — the frontmatter's
/// comma-separated `promoted_to` accumulator, live or archived. Kept out of
/// `DiscussionInfo` so `discuss list --json` stays bit-identical (design D2).
pub fn promoted_to(store: &dyn Store, slug: &str) -> Vec<String> {
    store
        .read_discussion(slug)
        .map(|doc| DiscussionHead::parse(&doc.text).promoted_to)
        .unwrap_or_default()
}

/// The single closing judgment for a discussion's life: archive it only when all three
/// conditions hold — no in-flight change references it (a change whose `.openspec.yaml`
/// exists but fails to parse counts as still referencing, fail-closed), its Conclusion
/// section holds real content, and it carries no `hold: true` flag. Shared by the
/// `conclude` closing step and the change-archive co-archival path so the rule cannot
/// drift between them again. `Ok(Some(file))` = archived; `Ok(None)` = a condition
/// failed or no live record (an unreadable record counts as not concluded — it stays
/// live); `Err` = the archive step itself failed.
pub fn close_if_finished(store: &dyn Store, slug: &str) -> Result<Option<String>> {
    let still_referenced = crate::model::list_changes(store).iter().any(|c| {
        c.meta_error.is_some() || c.meta.from_discussions().iter().any(|s| s == slug)
    });
    // A missing or unreadable record counts as not concluded (stays live, per spec);
    // a missing record also counts as not held — the concluded check already keeps it live.
    let Some(doc) = store.read_discussion(slug) else {
        return Ok(None);
    };
    if still_referenced || conclusion_body(&doc.text).is_none() || DiscussionHead::parse(&doc.text).hold {
        return Ok(None);
    }
    archive_discussion(store, slug)
}

/// Archive a live discussion under its creation date. Returns the archived
/// file name, or `None` when no live discussion exists. Same-day name
/// collisions are resolved by the store so co-archival never fails on a
/// reused slug.
pub fn archive_discussion(store: &dyn Store, slug: &str) -> Result<Option<String>> {
    let Some(text) = store.read_live_discussion(slug) else {
        return Ok(None);
    };
    let created = DiscussionHead::parse(&text)
        .created
        .filter(|c| !c.is_empty())
        .unwrap_or_else(util::today);
    store.archive_discussion(slug, &created)
}

/// Delete a live discussion outright — the exit for a record that turned out not to be
/// needed. Refuses once rounds exist (unless `force`): a discussion that examined real
/// trade-offs should keep its reasoning via `conclude` + `archive` instead.
pub fn discard_discussion(store: &dyn Store, slug: &str, force: bool) -> Result<()> {
    let Some(text) = store.read_live_discussion(slug) else {
        if store.archived_discussion_exists(slug) {
            return Err(WriteRefusal::guard(format!(
                "discussion '{slug}' is archived — archived records are kept, not discarded"
            )));
        }
        return Err(WriteRefusal::not_found(format!("discussion '{slug}' not found")));
    };
    let rounds = round_traces(&text);
    if rounds > 0 && !force {
        // Typed refusal: same frozen text, classified `refused` by the command layer.
        return Err(crate::command::Refusal(format!(
            "discussion '{slug}' has {rounds} recorded round(s) — `conclude` + `archive` keeps the reasoning; pass --force to delete anyway"
        ))
        .into());
    }
    store.delete_live_discussion(slug)?;
    Ok(())
}

/// Outcome of [`conclude`]: the restale-flagged change names, whether the closing
/// step auto-archived the record (its spun-out changes had all left the in-flight set),
/// and — when the closing archive step failed — the reason. The failure rides in the
/// outcome instead of an `Err` so the conclusion and restale writes stay committed on
/// every store (a remote Unit of Work would discard them on `Err`); the caller turns
/// `closing_error` into its own non-zero exit.
pub struct ConcludeOutcome {
    pub restale_flagged: Vec<String>,
    pub auto_archived: bool,
    pub closing_error: Option<String>,
    /// Whether the record carries the hold flag after this write.
    pub held: bool,
}

/// Write the conclusion into the `## Conclusion` section (replacing the placeholder — or a
/// previous conclusion, so a revised conclusion stays a single section) and mark the
/// discussion concluded.
pub fn conclude(
    store: &dyn Store,
    slug: &str,
    content: &str,
    hold: bool,
) -> Result<ConcludeOutcome> {
    ensure_content(content)?;
    let content = escape_colliding_lines(content);
    let text = load_live(store, slug)?;
    // Flip status: open -> concluded in frontmatter (a promoted discussion stays
    // promoted). The hold flag rides the same head write as the conclusion, so no half
    // state can survive a failure. Concluding without --hold restates the intent: an
    // existing flag is dropped. A record with nowhere to put the flag refuses `--hold`
    // outright rather than dropping it silently; without `--hold` it concludes as before.
    let mut head = DiscussionHead::parse(&text);
    head.conclude(hold);
    let mut text = match head.write_back()? {
        Some(t) => t,
        None if hold => bail!("discussion '{slug}' has no frontmatter — cannot hold it live"),
        None => text,
    };
    text = match replace_section(&text, "Conclusion", &content) {
        Some(t) => t,
        None => {
            // Pre-scaffold document: append the section.
            if !text.ends_with('\n') {
                text.push('\n');
            }
            format!("{text}\n## Conclusion\n\n{}\n", content.trim_end())
        }
    };
    let held = head.hold;
    store.write_live_discussion(slug, &text)?;
    // Re-concluding an already-reflected discussion (promoted_to non-empty) flags each
    // of its active changes as stale against the new conclusion. Returns the flagged
    // change names for the CLI to report; empty when nothing was reflected yet.
    let restale_flagged = stamp_restale(store, slug, &text)?;
    // Closing step: a spun-out discussion (promoted_to non-empty — a link-only record
    // has none and is closed by its change's archive instead) whose changes have all
    // left the in-flight set has no future change archive left to co-archive it, so
    // conclude closes the record itself via [`close_if_finished`] — the same three-way
    // judgment the archive path uses (corrupt change metadata fails closed; a record
    // concluded with `--hold` still owes a change that does not exist yet, so it stays).
    // A failed archive step rides in `closing_error` (see [`ConcludeOutcome`]) — the
    // caller recovers with a plain `discuss archive`.
    let mut closing_error = None;
    let auto_archived = if head.promoted_to.is_empty() {
        false
    } else {
        match close_if_finished(store, slug) {
            Ok(moved) => moved.is_some(),
            Err(e) => {
                closing_error = Some(e.to_string());
                false
            }
        }
    };
    Ok(ConcludeOutcome { restale_flagged, auto_archived, closing_error, held })
}

#[cfg(test)]
mod tests;
