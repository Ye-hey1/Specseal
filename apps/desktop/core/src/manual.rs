//! 手册页查找（change desktop-manual-page design D1〜D3）：读 `openspec/manual/`
//! 各页的 frontmatter、推导阅读序、依 manual-pages 契约计算「可能过期」与
//! 「生成后添加且未入册」。纯本机路径、不经 store 抽象（v1 只有本机；remote
//! 投影未定）；Tauri 壳各一行委派。
//!
//! 宽容降级：缺字段的页照常列出（缺 title 用文件名、缺 section 为 null、缺或非整数
//! order 为 null 并置分区末）；frontmatter 无法解析的页列入 `pages` 且进 `malformed`，
//! 不报错、不改档。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use chrono::{DateTime, FixedOffset, NaiveDate};
use regex::Regex;
use serde_json::{json, Value};
use specseal_core::archive::parse_canonical;
use specseal_core::store::Store;

use crate::query::{is_safe_path_param, DocumentLocation};
use crate::{init_core_context, ProjectContext};

/// 一页 frontmatter 解析后的索引数据；缺字段以 `None`／空数组表示。
struct Page {
    slug: String,
    title: String,
    section: Option<String>,
    order: Option<i64>,
    keywords: Vec<String>,
    sources: Vec<Source>,
    /// 生成时戳；缺席或既非 RFC 3339 也非 `YYYY-MM-DD` 皆为 `None`——视为未生成，
    /// 不判过期。
    generated: Option<Generated>,
    malformed: bool,
}

/// `sources` 的一项（manual-pages「frontmatter 六栏」）：`<capability>` 或
/// `<capability>#<Requirement 名>`。`raw` 原样回给索引；判定只用拆开的两半。
struct Source {
    raw: String,
    capability: String,
    /// 井号后的 Requirement 标题（去头尾空白）；无井号即 `None`＝整份规格语意。
    anchor: Option<String>,
}

impl Source {
    /// 以第一个 `#` 切开、两半各去头尾空白；空锚定（`cap#`）视同裸名。路径守门只看井号前
    /// （capability 之后会拼成 `specs/{cap}/spec.md` 去读正典：只收单一路径段、无 `..`、无 `:`），
    /// 违者整项丢弃。锚定本身得含 `/` 或 `:`（正典确有「build/pack workflow …」这样的标题）。
    fn parse(raw: &str) -> Option<Source> {
        let (capability, anchor) = match raw.split_once('#') {
            Some((cap, anchor)) => (cap.trim(), Some(anchor.trim()).filter(|a| !a.is_empty())),
            None => (raw.trim(), None),
        };
        if !is_safe_path_param(capability) || capability.contains(['/', '\\']) {
            return None;
        }
        Some(Source {
            raw: raw.to_string(),
            capability: capability.to_string(),
            anchor: anchor.map(str::to_string),
        })
    }

    /// 契约「过期判定基准」的单项判定：裸名看整份规格（规格不存在＝无时戳＝不过期）；
    /// 带锚定只看该段，段找不到或规格不存在即过期——改名／删除要可见，不静默失联。
    fn is_stale(&self, spec: Option<&SpecStamps>, page: Stamp) -> bool {
        let stamps: &[Stamp] = match (&self.anchor, spec) {
            (None, None) => &[],
            (None, Some(spec)) => &spec.all,
            (Some(_), None) => return true,
            (Some(anchor), Some(spec)) => match spec.by_requirement.get(anchor) {
                Some(stamps) => stamps,
                None => return true,
            },
        };
        stamps.iter().any(|u| u.counts_as_after(page))
    }
}

/// 一页的 `generated`：索引回传的原字符串（已 trim）与判定用的解析值。
struct Generated {
    raw: String,
    stamp: Stamp,
}

impl Generated {
    fn parse(raw: &str) -> Option<Generated> {
        let raw = raw.trim();
        Stamp::parse(raw).map(|stamp| Generated { raw: raw.to_string(), stamp })
    }
}

/// manual-pages 契约的时戳：纯日（放宽前写入的 `generated` 与旧封存的 `updated`）
/// 或带时区偏移量的瞬间（RFC 3339）。
#[derive(Clone, Copy, Debug)]
enum Stamp {
    Day(NaiveDate),
    Instant(DateTime<FixedOffset>),
}

impl Stamp {
    /// 先试 RFC 3339（含 `Z` 与 `±hh:mm`），再试 `YYYY-MM-DD`；都不是即缺席。
    fn parse(s: &str) -> Option<Stamp> {
        let s = s.trim();
        if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
            return Some(Stamp::Instant(dt));
        }
        NaiveDate::parse_from_str(s, "%Y-%m-%d").ok().map(Stamp::Day)
    }

    /// 日历日；带时间的一方取其时戳自身偏移量下的日历日。
    fn day(self) -> NaiveDate {
        match self {
            Stamp::Day(d) => d,
            Stamp::Instant(dt) => dt.date_naive(),
        }
    }

    /// 契约「过期判定基准」的「在之后」——名字说「算作」，因为第二段不是严格晚于：
    /// 两边都是瞬间时比到秒、严格晚于才算（同秒与小数秒差都不算）；任一边纯日期时
    /// 退回日历日不早于（同日也算）——生成当天的封存不得漏判。
    fn counts_as_after(self, page: Stamp) -> bool {
        match (self, page) {
            (Stamp::Instant(spec), Stamp::Instant(page)) => spec.timestamp() > page.timestamp(),
            _ => self.day() >= page.day(),
        }
    }
}

/// 没有手册可列时的索引；`reason` 恒为 null——「remote」那个值由前端 remote 数据源
/// 自己填，Rust 端没有第二种理由。
fn empty_index() -> Value {
    json!({
        "present": false,
        "reason": Value::Null,
        "pages": [],
        "uncoveredNew": [],
        "malformed": []
    })
}

// 正式规格的 `@trace` 注解区块与其中的 `updated:` 栏。区块的抓法与前端 trace.ts 相同；
// `updated:` 栏比前端的 `source:` 读法宽：多行式与单行式 `<!-- @trace source: x updated: … -->`
// 都认（archive 只写多行式，这里是超集）。
static TRACE_BLOCK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)<!--\s*@trace\b(.*?)-->").expect("static regex"));
static TRACE_UPDATED_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\bupdated:\s*(\S+)").expect("static regex"));

/// 对应 Tauri command `list_manual_pages`：`{ present, reason, pages, uncoveredNew,
/// malformed }`（字段 camelCase）。目录不存在、无 `.md`、不可读或非项目时
/// `present` 为 false（错误只记日志）。
pub fn list_manual_pages_at(root: &Path) -> Value {
    let Some(ctx) = init_core_context(root) else {
        return empty_index();
    };
    // `openspec/manual/` 跟 spec 目录名走（`.specseal.yaml` 的 spec_dir）。
    let dir = ctx.workspace.spec_dir().join("manual");
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(e) => {
            if e.kind() != std::io::ErrorKind::NotFound {
                eprintln!("manual: cannot read {}: {e}", dir.display());
            }
            return empty_index();
        }
    };
    let mut pages: Vec<Page> = entries
        .filter_map(|entry| {
            let path = entry.ok()?.path();
            if !path.is_file() || path.extension().and_then(|e| e.to_str()) != Some("md") {
                return None;
            }
            let slug = path.file_stem()?.to_str()?.to_string();
            Some(match std::fs::read_to_string(&path) {
                Ok(text) => parse_page(slug, &text),
                Err(e) => {
                    eprintln!("manual: cannot read {}: {e}", path.display());
                    malformed_page(slug)
                }
            })
        })
        .collect();
    if pages.is_empty() {
        return empty_index();
    }
    sort_reading_order(&mut pages);

    // 每个 capability 的正典只读一次（stale 与 uncoveredNew 共用）：整份的 @trace updated
    // 时戳，加上按 `### Requirement:` 切段后各段自己的时戳；规格不存在即 `None`。
    // 先把页面引用的与正典既有的 capability 一次读齐，之后只借用、不拷贝。
    let store: &dyn Store = &ctx.store;
    let canonical = store.list_canonical_capabilities();
    let specs: HashMap<String, Option<SpecStamps>> = pages
        .iter()
        .flat_map(|p| p.sources.iter().map(|s| s.capability.clone()))
        .chain(canonical.iter().cloned())
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .map(|cap| {
            let stamps = store.read_canonical_spec(&cap).map(|doc| SpecStamps::parse(&doc));
            (cap, stamps)
        })
        .collect();
    let spec_of = |cap: &str| -> Option<&SpecStamps> { specs.get(cap).and_then(Option::as_ref) };

    let items: Vec<Value> = pages
        .iter()
        .map(|p| {
            // manual-pages 契约「过期判定基准」：逐项判定，任一项过期即页过期。
            let stale = p
                .generated
                .as_ref()
                .is_some_and(|g| p.sources.iter().any(|s| s.is_stale(spec_of(&s.capability), g.stamp)));
            let sources: Vec<&str> = p.sources.iter().map(|s| s.raw.as_str()).collect();
            json!({
                "slug": p.slug,
                "title": p.title,
                "section": p.section,
                "order": p.order,
                "keywords": p.keywords,
                "sources": sources,
                "generated": p.generated.as_ref().map(|g| g.raw.clone()),
                "stale": stale,
            })
        })
        .collect();

    // 未入册：正典 capability 的每一个 updated 都在每一页 generated 之后（同一套
    // 三段式；纯日期与时戳混用时没有全序，故以量词取代最小／最大），且不在任何页的
    // sources。没有任何页带 generated 时不判。
    let generated: Vec<Stamp> = pages.iter().filter_map(|p| p.generated.as_ref().map(|g| g.stamp)).collect();
    let mut uncovered: Vec<String> = if generated.is_empty() {
        Vec::new()
    } else {
        canonical
            .into_iter()
            .filter(|cap| !pages.iter().any(|p| p.sources.iter().any(|s| &s.capability == cap)))
            .filter(|cap| {
                let updated: &[Stamp] = spec_of(cap).map(|s| s.all.as_slice()).unwrap_or(&[]);
                !updated.is_empty() && updated.iter().all(|u| generated.iter().all(|g| u.counts_as_after(*g)))
            })
            .collect()
    };
    uncovered.sort_unstable();

    let malformed: Vec<&str> = pages.iter().filter(|p| p.malformed).map(|p| p.slug.as_str()).collect();
    json!({
        "present": true,
        "reason": Value::Null,
        "pages": items,
        "uncoveredNew": uncovered,
        "malformed": malformed,
    })
}

/// 一页手册的文件位置与所属项目：读内文与「打开 ▾」定位共用。slug 是单一文件名段——拒绝
/// 路径分隔与 `..`（与其他 document 读取同一守门）；`manual/` 跟 spec 目录名走。
fn manual_file(root: &Path, slug: &str) -> Option<(ProjectContext, PathBuf)> {
    if !is_safe_path_param(slug) || slug.contains(['/', '\\']) {
        return None;
    }
    let ctx = init_core_context(root)?;
    let path = ctx.workspace.spec_dir().join("manual").join(format!("{slug}.md"));
    Some((ctx, path))
}

/// 对应 Tauri command `get_manual_page`：去掉 frontmatter 的内文；frontmatter 坏掉
/// 的页回全文；页不存在（或 slug 不安全）回 `None`。
pub fn manual_page_at(root: &Path, slug: &str) -> Option<String> {
    let (_, path) = manual_file(root, slug)?;
    let text = std::fs::read_to_string(path).ok()?;
    Some(match split_frontmatter(&text) {
        Some((yaml, body)) if parse_frontmatter_yaml(yaml).is_some() => body.to_string(),
        _ => text,
    })
}

/// 对应 Tauri command `manual_location`（手册页「打开 ▾」，desktop-spec-manual-pages design D8）：
/// 与 [`manual_page_at`] 同一条守门与路径解析。不检查文件存在（缺档由 opener 回报）；slug 不安全
/// 或不在项目内回 `None`。
pub fn manual_location_at(root: &Path, slug: &str) -> Option<DocumentLocation> {
    let (ctx, path) = manual_file(root, slug)?;
    Some(DocumentLocation::within(&ctx.workspace.root, path))
}

/// 切出 frontmatter：首行为 `---`、到下一个 `---` 行为止（皆容忍 `\r`）。回传
/// （YAML 原文、收尾行之后的内文）；不以 `---` 开头或没有收尾行时 `None`。
fn split_frontmatter(text: &str) -> Option<(&str, &str)> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut lines = text.split_inclusive('\n');
    let first = lines.next()?;
    if first.trim_end_matches(['\r', '\n']) != "---" {
        return None;
    }
    let yaml_start = first.len();
    let mut pos = yaml_start;
    for line in lines {
        if line.trim_end_matches(['\r', '\n']) == "---" {
            return Some((&text[yaml_start..pos], &text[pos + line.len()..]));
        }
        pos += line.len();
    }
    None
}

/// frontmatter YAML → 映射（全空白的 frontmatter 视为空映射）；解析失败或非映射回
/// `None`。只含 `#` 注解行的 YAML 也解成 Null，但那多半是「首行水平线＋标题」的
/// 内文而非 frontmatter——不当空映射剥掉，让它走 malformed 路径保留全文。
fn parse_frontmatter_yaml(yaml: &str) -> Option<serde_yaml::Mapping> {
    let cleaned = yaml.replace('\r', "");
    match serde_yaml::from_str::<serde_yaml::Value>(&cleaned).ok()? {
        serde_yaml::Value::Mapping(map) => Some(map),
        serde_yaml::Value::Null if cleaned.trim().is_empty() => Some(serde_yaml::Mapping::new()),
        _ => None,
    }
}

fn malformed_page(slug: String) -> Page {
    Page {
        title: slug.clone(),
        slug,
        section: None,
        order: None,
        keywords: Vec::new(),
        sources: Vec::new(),
        generated: None,
        malformed: true,
    }
}

fn parse_page(slug: String, text: &str) -> Page {
    let Some(map) = split_frontmatter(text).and_then(|(yaml, _)| parse_frontmatter_yaml(yaml)) else {
        return malformed_page(slug);
    };
    let string_field = |key: &str| map.get(key).and_then(|v| v.as_str()).map(str::to_string);
    let list_field = |key: &str| -> Vec<String> {
        map.get(key)
            .and_then(|v| v.as_sequence())
            .map(|seq| seq.iter().filter_map(scalar_to_string).collect())
            .unwrap_or_default()
    };
    // 守门在 Source::parse（与 manual_page_at 的 slug 守门同一条线）。
    let sources = list_field("sources").iter().filter_map(|s| Source::parse(s)).collect();
    Page {
        title: string_field("title").unwrap_or_else(|| slug.clone()),
        slug,
        section: string_field("section"),
        order: map.get("order").and_then(|v| v.as_i64()),
        keywords: list_field("keywords"),
        sources,
        generated: string_field("generated").and_then(|raw| Generated::parse(&raw)),
        malformed: false,
    }
}

fn scalar_to_string(v: &serde_yaml::Value) -> Option<String> {
    match v {
        serde_yaml::Value::String(s) => Some(s.clone()),
        serde_yaml::Value::Number(n) => Some(n.to_string()),
        serde_yaml::Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

/// 阅读序（manual-pages 契约「页的排序仅由 order 决定；分区顺序由分区内最小
/// order 决定」）：分区依（最小 order、该 order 的最小文件名）排、分区内依
/// （order、文件名）排；缺或非整数 order 以 i64::MAX 沉底。
fn sort_reading_order(pages: &mut [Page]) {
    let order_key = |p: &Page| (p.order.unwrap_or(i64::MAX), p.slug.clone());
    let mut section_rank: HashMap<Option<String>, (i64, String)> = HashMap::new();
    for p in pages.iter() {
        let key = order_key(p);
        section_rank
            .entry(p.section.clone())
            .and_modify(|best| {
                if key < *best {
                    *best = key.clone();
                }
            })
            .or_insert(key);
    }
    pages.sort_by_cached_key(|p| (section_rank[&p.section].clone(), order_key(p)));
}

/// 一份正式规格的 @trace updated 时戳：整份的，与按 Requirement 段落分的。
struct SpecStamps {
    all: Vec<Stamp>,
    /// 键为 `### Requirement:` 之后的标题（去头尾空白）；同名段落的时戳合并。
    by_requirement: HashMap<String, Vec<Stamp>>,
}

impl SpecStamps {
    /// 切段沿用引擎正典的唯一实作 `specseal_core::archive::parse_canonical`（行首
    /// `### Requirement:` 为段界、`lines()` 已吃掉 `\r\n` 的 `\r`、标题前的内容不属任何段），
    /// 标题语法一动只改引擎那一处。
    fn parse(doc: &str) -> SpecStamps {
        let mut by_requirement: HashMap<String, Vec<Stamp>> = HashMap::new();
        for (title, block) in parse_canonical(doc).1 {
            by_requirement.entry(title).or_default().extend(trace_updated_stamps(&block));
        }
        SpecStamps { all: trace_updated_stamps(doc), by_requirement }
    }
}

/// 正式规格全文 `@trace` 注解区块内每一行 `updated:` 的可解析时戳；无法解析的行
/// 视为缺席、直接略过。
fn trace_updated_stamps(doc: &str) -> Vec<Stamp> {
    TRACE_BLOCK_RE
        .captures_iter(doc)
        .flat_map(|block| {
            TRACE_UPDATED_RE
                .captures_iter(&block[1])
                .filter_map(|cap| Stamp::parse(&cap[1]))
                .collect::<Vec<_>>()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testfixture::FixtureRoot;

    fn page(fx: &FixtureRoot, slug: &str, frontmatter: &str, body: &str) {
        fx.write(
            &format!("specseal/manual/{slug}.md"),
            &format!("---\n{frontmatter}\n---\n\n{body}\n"),
        );
    }

    fn spec_with_trace(fx: &FixtureRoot, cap: &str, updated: &[&str]) {
        let blocks: String = updated
            .iter()
            .map(|d| format!("<!-- @trace\nsource: some-change\nupdated: {d}\n-->\n"))
            .collect();
        fx.write(
            &format!("specseal/specs/{cap}/spec.md"),
            &format!("# {cap} Specification\n\n## Purpose\n\nx\n\n{blocks}"),
        );
    }

    fn slugs(v: &Value) -> Vec<String> {
        v["pages"]
            .as_array()
            .expect("pages array")
            .iter()
            .map(|p| p["slug"].as_str().unwrap().to_string())
            .collect()
    }

    fn page_of<'a>(v: &'a Value, slug: &str) -> &'a Value {
        v["pages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["slug"] == slug)
            .unwrap_or_else(|| panic!("page {slug} listed"))
    }

    #[test]
    fn manual_location_resolves_under_the_manual_dir_and_refuses_escapes() {
        // 手册页「打开 ▾」（desktop-spec-manual-pages design D8）：spec 目录下 manual/<slug>.md，
        // 不检查文件存在；slug 守门与 manual_page_at 同一条。
        let fx = FixtureRoot::new("manual-loc");
        let loc = manual_location_at(fx.root(), "tray").expect("location");
        assert_eq!(loc.relative, "specseal/manual/tray.md");
        let abs = Path::new(&loc.path);
        assert!(abs.starts_with(fx.root()), "{} 应在 {}", loc.path, fx.root().display());
        assert!(abs.ends_with("specseal/manual/tray.md"), "{}", loc.path);
        assert!(manual_location_at(fx.root(), "../x").is_none());
        assert!(manual_location_at(fx.root(), "a/b").is_none());
        assert!(manual_location_at(fx.root(), "a\\b").is_none());
        // spec 目录名改设置时跟着走。
        let custom = FixtureRoot::new("manual-loc-custom");
        custom.write(".specseal.yaml", "spec_dir: docs/specs\n");
        let loc = manual_location_at(custom.root(), "tray").expect("custom location");
        assert_eq!(loc.relative, "docs/specs/manual/tray.md");
    }

    #[test]
    fn index_shape_and_reading_order_follow_the_spec_example() {
        // spec「依 order 排序并依 section 分组」Example：四页 10/20/30/40。
        let fx = FixtureRoot::new("manual-shape");
        page(&fx, "editor", "title: 编辑器\nsection: 文档协作\norder: 30\nsources: []\ngenerated: 2026-09-02", "e");
        page(&fx, "about", "title: 本手册的来源\nsection: 附录\norder: 40\nsources: []\ngenerated: 2026-09-02", "a");
        page(
            &fx,
            "first-login",
            "title: 第一次登录\nsection: 开始使用\norder: 20\nkeywords: [登录, github, 审核]\nsources: [github-oauth, user-pending-blocked-pages]\ngenerated: 2026-09-05T23:31:00+08:00",
            "f",
        );
        page(&fx, "index", "title: 手册\nsection: 开始使用\norder: 10\nsources: []\ngenerated: 2026-09-02", "i");
        let v = list_manual_pages_at(fx.root());
        assert_eq!(v["present"], true);
        assert_eq!(v["reason"], Value::Null);
        assert_eq!(slugs(&v), ["index", "first-login", "editor", "about"]);
        assert_eq!(v["malformed"], serde_json::json!([]));
        assert_eq!(v["uncoveredNew"], serde_json::json!([]));
        let fl = page_of(&v, "first-login");
        assert_eq!(fl["title"], "第一次登录");
        assert_eq!(fl["section"], "开始使用");
        assert_eq!(fl["order"], 20);
        assert_eq!(fl["keywords"], serde_json::json!(["登录", "github", "审核"]));
        assert_eq!(fl["sources"], serde_json::json!(["github-oauth", "user-pending-blocked-pages"]));
        assert_eq!(fl["generated"], "2026-09-05T23:31:00+08:00");
        assert_eq!(fl["stale"], false);
        // 字段名是对外契约：每页恰好这八个 camelCase 键。
        let mut keys: Vec<&str> = fl.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["generated", "keywords", "order", "section", "slug", "sources", "stale", "title"]);
    }

    #[test]
    fn ties_break_by_slug_and_sections_rank_by_their_smallest_order() {
        // 同 order 以文件名决断；分区顺序为分区内最小 order（交错的 A10/B20/A30 →
        // A 区整组在前）。
        let fx = FixtureRoot::new("manual-order");
        page(&fx, "b-second", "section: B\norder: 20", "");
        page(&fx, "a-late", "section: A\norder: 30", "");
        page(&fx, "a-first", "section: A\norder: 10", "");
        page(&fx, "z-tie", "section: A\norder: 30", "");
        page(&fx, "m-tie", "section: A\norder: 30", "");
        let v = list_manual_pages_at(fx.root());
        assert_eq!(slugs(&v), ["a-first", "a-late", "m-tie", "z-tie", "b-second"]);
    }

    #[test]
    fn missing_fields_degrade_without_error() {
        // spec「缺字段的页宽容降级」：缺 title 用文件名、缺 section 为 null、非整数
        // order 为 null 且置该分区末、缺 keywords/sources 为空数组、缺 generated
        // 为 null 且不判过期。
        let fx = FixtureRoot::new("manual-degrade");
        page(&fx, "index", "title: 手册\nsection: 开始使用\norder: 10", "");
        page(&fx, "orphan", "order: abc", "");
        page(&fx, "no-order", "section: 开始使用", "");
        page(&fx, "float-order", "section: 开始使用\norder: 15.5", "");
        let v = list_manual_pages_at(fx.root());
        assert_eq!(slugs(&v), ["index", "float-order", "no-order", "orphan"]);
        let orphan = page_of(&v, "orphan");
        assert_eq!(orphan["title"], "orphan");
        assert_eq!(orphan["section"], Value::Null);
        assert_eq!(orphan["order"], Value::Null);
        assert_eq!(orphan["keywords"], serde_json::json!([]));
        assert_eq!(orphan["sources"], serde_json::json!([]));
        assert_eq!(orphan["generated"], Value::Null);
        assert_eq!(orphan["stale"], false);
        assert_eq!(page_of(&v, "float-order")["order"], Value::Null);
        assert_eq!(v["malformed"], serde_json::json!([]));
    }

    #[test]
    fn malformed_frontmatter_pages_are_listed_and_flagged() {
        // spec「frontmatter 坏掉的页仍可开」：不以 --- 开头、YAML 坏掉、没有收尾
        // --- 的页都以文件名为标题列出并进 malformed；其他页顺序与内容不受影响。
        let fx = FixtureRoot::new("manual-malformed");
        page(&fx, "index", "title: 手册\nsection: 开始使用\norder: 10", "");
        fx.write("specseal/manual/plain.md", "# 没有 frontmatter\n\n内文。\n");
        fx.write("specseal/manual/broken.md", "---\ntitle: [unclosed\norder: 5\n---\n\n内文。\n");
        fx.write("specseal/manual/unterminated.md", "---\ntitle: 永远不收尾\n\n内文。\n");
        let v = list_manual_pages_at(fx.root());
        assert_eq!(v["present"], true);
        assert_eq!(slugs(&v), ["index", "broken", "plain", "unterminated"]);
        for slug in ["plain", "broken", "unterminated"] {
            let p = page_of(&v, slug);
            assert_eq!(p["title"], slug);
            assert_eq!(p["section"], Value::Null);
            assert_eq!(p["order"], Value::Null);
        }
        assert_eq!(v["malformed"], serde_json::json!(["broken", "plain", "unterminated"]));
        assert_eq!(page_of(&v, "index")["title"], "手册");
        // 坏页仍可开：回全文。
        assert_eq!(
            manual_page_at(fx.root(), "broken").as_deref(),
            Some("---\ntitle: [unclosed\norder: 5\n---\n\n内文。\n")
        );
        assert_eq!(manual_page_at(fx.root(), "plain").as_deref(), Some("# 没有 frontmatter\n\n内文。\n"));
        // 首行水平线、到下一条水平线之间只有标题行：YAML 解成 Null，不是 frontmatter——
        // 走 malformed、全文保留，内容不得无声消失。
        fx.write("specseal/manual/ruled.md", "---\n# 标题\n---\n\n内文。\n");
        let v = list_manual_pages_at(fx.root());
        assert!(v["malformed"].as_array().unwrap().contains(&serde_json::json!("ruled")));
        assert_eq!(manual_page_at(fx.root(), "ruled").as_deref(), Some("---\n# 标题\n---\n\n内文。\n"));
    }

    #[test]
    fn stale_follows_the_max_trace_updated_of_the_sources() {
        // spec「可能过期与未入册的标示」Example 判定表。
        let fx = FixtureRoot::new("manual-stale");
        spec_with_trace(&fx, "x", &["2026-08-01", "2026-09-05"]);
        spec_with_trace(&fx, "y", &["2026-08-20"]);
        page(&fx, "px", "order: 10\nsources: [x]\ngenerated: 2026-09-01", "");
        page(&fx, "py", "order: 20\nsources: [y]\ngenerated: 2026-09-01", "");
        page(&fx, "pxy", "order: 25\nsources: [y, x]\ngenerated: 2026-09-01", "");
        page(&fx, "p-empty", "order: 30\nsources: []\ngenerated: 2026-09-01", "");
        page(&fx, "p-nogen", "order: 40\nsources: [x]", "");
        page(&fx, "p-missing-spec", "order: 50\nsources: [nope]\ngenerated: 2026-09-01", "");
        page(&fx, "p-same-day", "order: 60\nsources: [x]\ngenerated: 2026-09-05", "");
        let v = list_manual_pages_at(fx.root());
        assert_eq!(page_of(&v, "px")["stale"], true);
        assert_eq!(page_of(&v, "py")["stale"], false);
        assert_eq!(page_of(&v, "pxy")["stale"], true, "任一来源更新即过期");
        assert_eq!(page_of(&v, "p-empty")["stale"], false);
        assert_eq!(page_of(&v, "p-nogen")["stale"], false);
        assert_eq!(page_of(&v, "p-missing-spec")["stale"], false);
        assert_eq!(page_of(&v, "p-same-day")["stale"], true, "同日算过期：生成当天的封存不得漏判");
    }

    #[test]
    fn stamp_parses_rfc3339_with_offset_or_z_then_plain_date() {
        // manual-pages「frontmatter 六栏」：generated／updated 先试 RFC 3339（含 Z 与 ±hh:mm），
        // 再试 YYYY-MM-DD；都不是就视为缺席。
        assert!(matches!(Stamp::parse("2026-09-05T23:17:28+08:00"), Some(Stamp::Instant(_))));
        assert!(matches!(Stamp::parse("2026-09-05T15:40:00Z"), Some(Stamp::Instant(_))));
        assert!(matches!(Stamp::parse("2026-09-05"), Some(Stamp::Day(_))));
        assert!(Stamp::parse("not-a-date").is_none());
        assert!(Stamp::parse("2026/09/01").is_none());
        // 带时间的一方取其自身偏移量下的日历日。
        let z = Stamp::parse("2026-09-05T20:30:00-05:00").unwrap();
        assert_eq!(z.day(), NaiveDate::from_ymd_opt(2026, 9, 5).unwrap());
    }

    #[test]
    fn single_line_trace_blocks_and_padded_generated_are_read() {
        // 单行式 `<!-- @trace source: x updated: … -->` 也算一个 updated 时戳；
        // generated 带尾空白时解析后回传的原字符串已 trim。
        let fx = FixtureRoot::new("manual-single-line-trace");
        fx.write(
            "specseal/specs/x/spec.md",
            "# x Specification\n\n## Purpose\n\nx\n\n<!-- @trace source: x updated: 2026-09-05T23:40:00+08:00 -->\n",
        );
        page(&fx, "p", "order: 10\nsources: [x]\ngenerated: \"2026-09-05T23:31:00+08:00 \"", "");
        let v = list_manual_pages_at(fx.root());
        assert_eq!(page_of(&v, "p")["generated"], "2026-09-05T23:31:00+08:00");
        assert_eq!(page_of(&v, "p")["stale"], true);
    }

    #[test]
    fn generated_is_echoed_as_the_frontmatter_string() {
        // 索引的 generated 字段为 frontmatter 原字符串（RFC 3339 或纯日期），无法解析时 null。
        let fx = FixtureRoot::new("manual-gen-raw");
        spec_with_trace(&fx, "x", &["2026-08-01"]);
        page(&fx, "stamp", "order: 10\nsources: [x]\ngenerated: 2026-09-05T23:31:00+08:00", "");
        page(&fx, "day", "order: 20\nsources: [x]\ngenerated: 2026-09-02", "");
        let v = list_manual_pages_at(fx.root());
        assert_eq!(page_of(&v, "stamp")["generated"], "2026-09-05T23:31:00+08:00");
        assert_eq!(page_of(&v, "day")["generated"], "2026-09-02");
        let keys: Vec<&str> = page_of(&v, "stamp").as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(keys, ["generated", "keywords", "order", "section", "slug", "sources", "stale", "title"]);
    }

    #[test]
    fn stale_compares_at_second_precision_when_both_sides_carry_time() {
        // design「Implementation Contract」判定表：两边带时间严格晚于才算；任一边纯日期退回同日规则。
        let fx = FixtureRoot::new("manual-stale-time");
        let rows: &[(&str, &str, &str, bool)] = &[
            ("earlier", "2026-09-05T23:31:00+08:00", "2026-09-05T23:17:28+08:00", false),
            ("later", "2026-09-05T23:31:00+08:00", "2026-09-05T23:40:00+08:00", true),
            ("same-second", "2026-09-05T23:31:00+08:00", "2026-09-05T23:31:00+08:00", false),
            ("sub-second", "2026-09-05T23:31:00+08:00", "2026-09-05T23:31:00.001+08:00", false),
            ("zulu", "2026-09-05T23:31:00+08:00", "2026-09-05T15:40:00Z", true),
            ("spec-day-only", "2026-09-05T23:31:00+08:00", "2026-09-05", true),
            ("page-day-only", "2026-09-05", "2026-09-05T23:17:28+08:00", true),
            ("next-day-page", "2026-09-06T00:10:00+08:00", "2026-09-05", false),
            ("garbage", "2026-09-05T23:31:00+08:00", "not-a-date", false),
        ];
        for (i, (slug, generated, updated, _)) in rows.iter().enumerate() {
            spec_with_trace(&fx, &format!("cap-{slug}"), &[updated]);
            page(&fx, slug, &format!("order: {}\nsources: [cap-{slug}]\ngenerated: {generated}", (i + 1) * 10), "");
        }
        let v = list_manual_pages_at(fx.root());
        for (slug, generated, updated, expected) in rows {
            assert_eq!(page_of(&v, slug)["stale"], *expected, "{slug}: generated {generated} vs updated {updated}");
        }
    }

    #[test]
    fn uncovered_new_requires_every_stamp_after_every_page_at_second_precision() {
        // 未入册的对称规则：规格每一个 updated 都在每一页 generated 之后才计入。
        let fx = FixtureRoot::new("manual-uncovered-time");
        page(&fx, "index", "order: 10\nsources: []\ngenerated: 2026-09-05T23:31:00+08:00", "");
        page(&fx, "older", "order: 20\nsources: []\ngenerated: 2026-09-01", "");
        spec_with_trace(&fx, "after", &["2026-09-05T23:40:00+08:00", "2026-09-06T01:00:00+08:00"]);
        spec_with_trace(&fx, "before", &["2026-09-05T23:17:28+08:00", "2026-09-06T01:00:00+08:00"]);
        spec_with_trace(&fx, "same-second", &["2026-09-05T23:31:00+08:00"]);
        spec_with_trace(&fx, "day-only", &["2026-09-05"]);
        spec_with_trace(&fx, "zulu", &["2026-09-05T15:40:00Z"]);
        let v = list_manual_pages_at(fx.root());
        assert_eq!(v["uncoveredNew"], serde_json::json!(["after", "day-only", "zulu"]));
    }

    #[test]
    fn unparseable_generated_is_null_and_never_stale() {
        // 既非 RFC 3339 也非 YYYY-MM-DD 的 generated 视同缺席：输出 null、不判过期。
        let fx = FixtureRoot::new("manual-badgen");
        spec_with_trace(&fx, "x", &["2026-09-05"]);
        page(&fx, "index", "order: 10\nsources: [x]\ngenerated: 2026/09/01", "");
        let v = list_manual_pages_at(fx.root());
        assert_eq!(page_of(&v, "index")["generated"], Value::Null);
        assert_eq!(page_of(&v, "index")["stale"], false);
        assert_eq!(v["uncoveredNew"], serde_json::json!([]));
    }

    #[test]
    fn uncovered_new_lists_specs_born_after_the_manual_and_absent_from_every_sources() {
        // spec「生成后添加的规格计入未入册」：规格的每一个 updated 都在每一页 generated
        // 之后、且不在任何 sources；加进某页 sources 后消失。
        let fx = FixtureRoot::new("manual-uncovered");
        spec_with_trace(&fx, "z", &["2026-09-03", "2026-09-04"]);
        spec_with_trace(&fx, "w", &["2026-09-03"]);
        spec_with_trace(&fx, "v", &["2026-08-01", "2026-09-04"]);
        fx.write("specseal/specs/no-trace/spec.md", "# no-trace\n");
        page(&fx, "index", "order: 10\nsources: []\ngenerated: 2026-08-15", "");
        page(&fx, "pw", "order: 20\nsources: [w]\ngenerated: 2026-09-01", "");
        let v = list_manual_pages_at(fx.root());
        assert_eq!(v["uncoveredNew"], serde_json::json!(["z"]));
        page(&fx, "pz", "order: 30\nsources: [z]\ngenerated: 2026-09-01", "");
        let v = list_manual_pages_at(fx.root());
        assert_eq!(v["uncoveredNew"], serde_json::json!([]));
    }

    #[test]
    fn uncovered_new_counts_a_spec_first_traced_on_the_generation_day() {
        // 生成当天封存的新规格同样算「生成后添加」（与过期判定同一基准）。
        let fx = FixtureRoot::new("manual-uncovered-sameday");
        spec_with_trace(&fx, "s", &["2026-09-01"]);
        spec_with_trace(&fx, "old", &["2026-08-31"]);
        page(&fx, "index", "order: 10\nsources: []\ngenerated: 2026-09-01", "");
        let v = list_manual_pages_at(fx.root());
        assert_eq!(v["uncoveredNew"], serde_json::json!(["s"]));
    }

    #[test]
    fn uncovered_new_is_empty_when_no_page_carries_generated() {
        let fx = FixtureRoot::new("manual-uncovered-nogen");
        spec_with_trace(&fx, "z", &["2026-09-03"]);
        page(&fx, "index", "order: 10", "");
        let v = list_manual_pages_at(fx.root());
        assert_eq!(v["uncoveredNew"], serde_json::json!([]));
    }

    #[test]
    fn absent_or_empty_manual_dir_reports_present_false() {
        // spec「无手册目录」：目录不存在、只有非 .md 档、非 specseal 项目。
        let fx = FixtureRoot::new("manual-absent");
        let v = list_manual_pages_at(fx.root());
        assert_eq!(
            v,
            serde_json::json!({
                "present": false,
                "reason": null,
                "pages": [],
                "uncoveredNew": [],
                "malformed": []
            })
        );
        fx.write("specseal/manual/notes.txt", "not a page");
        let v = list_manual_pages_at(fx.root());
        assert_eq!(v["present"], false);
        assert_eq!(v["pages"], serde_json::json!([]));
        assert_eq!(manual_page_at(fx.root(), "index"), None);

        let non_project = crate::testfixture::fresh_non_project_dir("manual");
        assert_eq!(list_manual_pages_at(&non_project)["present"], false);
        assert_eq!(manual_page_at(&non_project, "index"), None);
    }

    #[test]
    fn crlf_content_parses_and_body_keeps_its_line_endings() {
        // design Risks：Windows 换行——frontmatter 以行为单位剥 \r；内文原样回传。
        let fx = FixtureRoot::new("manual-crlf");
        fx.write(
            "specseal/manual/index.md",
            "---\r\ntitle: 手册\r\nsection: 开始使用\r\norder: 10\r\nkeywords: [a, b]\r\nsources: []\r\ngenerated: 2026-09-02\r\n---\r\n\r\n# 标题\r\n\r\n内文。\r\n",
        );
        let v = list_manual_pages_at(fx.root());
        let p = page_of(&v, "index");
        assert_eq!(p["title"], "手册");
        assert_eq!(p["section"], "开始使用");
        assert_eq!(p["order"], 10);
        assert_eq!(p["keywords"], serde_json::json!(["a", "b"]));
        assert_eq!(p["generated"], "2026-09-02");
        assert_eq!(v["malformed"], serde_json::json!([]));
        assert_eq!(manual_page_at(fx.root(), "index").as_deref(), Some("\r\n# 标题\r\n\r\n内文。\r\n"));
    }

    #[test]
    fn manual_page_strips_frontmatter_and_refuses_escapes() {
        let fx = FixtureRoot::new("manual-page");
        page(&fx, "index", "title: 手册\norder: 10", "# 手册\n\n内文。");
        fx.write("specseal/manual/empty-fm.md", "---\n---\nbody only\n");
        fx.write("specseal/secret.md", "not a manual page");
        assert_eq!(manual_page_at(fx.root(), "index").as_deref(), Some("\n# 手册\n\n内文。\n"));
        assert_eq!(manual_page_at(fx.root(), "empty-fm").as_deref(), Some("body only\n"));
        assert_eq!(manual_page_at(fx.root(), "missing"), None);
        assert_eq!(manual_page_at(fx.root(), "../secret"), None);
        assert_eq!(manual_page_at(fx.root(), "sub/index"), None);
        assert_eq!(manual_page_at(fx.root(), ""), None);
    }

    #[test]
    fn keywords_and_sources_accept_scalars_and_ignore_non_lists() {
        let fx = FixtureRoot::new("manual-lists");
        page(&fx, "index", "order: 10\nkeywords: [登录, 42, true]\nsources: github-oauth", "");
        let v = list_manual_pages_at(fx.root());
        let p = page_of(&v, "index");
        assert_eq!(p["keywords"], serde_json::json!(["登录", "42", "true"]));
        assert_eq!(p["sources"], serde_json::json!([]), "非数组的 sources 视为缺席");
    }

    #[test]
    fn sources_drop_values_that_are_not_a_single_path_segment() {
        // sources 会拼成正典路径去读：`..`、分隔符、绝对路径一律丢弃，不去读 specs 外的档。
        let fx = FixtureRoot::new("manual-sources-guard");
        fx.write("specseal/secret/spec.md", "<!-- @trace\nsource: s\nupdated: 2026-09-09\n-->\n");
        spec_with_trace(&fx, "ok-cap", &["2026-08-01"]);
        page(
            &fx,
            "index",
            "order: 10\nsources: [../secret, ok-cap, sub/ok-cap, /abs, 'c:x']\ngenerated: 2026-09-01",
            "",
        );
        let v = list_manual_pages_at(fx.root());
        let p = page_of(&v, "index");
        assert_eq!(p["sources"], serde_json::json!(["ok-cap"]));
        assert_eq!(p["stale"], false, "被丢弃的来源不参与过期判定");
    }

    /// 正式规格夹具：每条 `### Requirement:` 段各带自己的 @trace updated 时戳；`newline`
    /// 可换成 `\r\n` 验跨平台切段。
    fn spec_with_requirements(fx: &FixtureRoot, cap: &str, sections: &[(&str, &[&str])], newline: &str) {
        let mut doc = format!("# {cap} Specification\n\n## Purpose\n\nx\n\n## Requirements\n\n");
        for (title, updated) in sections {
            doc.push_str(&format!("### Requirement: {title}\n\n内文\n\n#### Scenario: s\n\n- **WHEN** a\n- **THEN** b\n\n"));
            for d in updated.iter() {
                doc.push_str(&format!("<!-- @trace\nsource: some-change\nupdated: {d}\n-->\n\n"));
            }
            doc.push_str("---\n");
        }
        fx.write(&format!("specseal/specs/{cap}/spec.md"), &doc.replace('\n', newline));
    }

    #[test]
    fn sources_keep_anchor_verbatim_and_guard_only_the_capability_part() {
        // manual-pages「frontmatter 六栏」＋ desktop-manual-page「可能过期与未入册的标示」：
        // sources 回传 frontmatter 原字符串（含 #锚定）；路径守门只看井号前，违者整项略去。
        let fx = FixtureRoot::new("manual-anchor-parse");
        spec_with_requirements(&fx, "desktop-app", &[("看板与任务", &["2026-08-14"])], "\n");
        // 锚定本身得含 `/`（正典确有「build/pack workflow 可被 release 管线重用」）——守门不看井号后。
        spec_with_requirements(&fx, "release-pipeline", &[("build/pack workflow 可被 release 管线重用", &["2026-08-14"])], "\n");
        page(
            &fx,
            "p",
            "order: 10\nsources: [\"desktop-app#看板与任务\", \"release-pipeline#build/pack workflow 可被 release 管线重用\", \"../evil#段\", \"a/b#段\"]\ngenerated: 2026-09-05",
            "",
        );
        let v = list_manual_pages_at(fx.root());
        let p = page_of(&v, "p");
        assert_eq!(
            p["sources"],
            serde_json::json!(["desktop-app#看板与任务", "release-pipeline#build/pack workflow 可被 release 管线重用"])
        );
        assert!(p["sources"].as_array().unwrap().iter().all(Value::is_string));
        assert!(p["stale"].is_boolean());
    }

    #[test]
    fn anchored_source_only_reads_the_named_requirement_section() {
        // manual-pages「过期判定基准」Example 判定表：锚定项只看该段；裸名看整份；\r\n 同结果。
        for (nl, tag) in [("\n", "lf"), ("\r\n", "crlf")] {
            let fx = FixtureRoot::new(&format!("manual-anchor-section-{tag}"));
            spec_with_requirements(
                &fx,
                "desktop-app",
                &[("桌面上的品质关卡", &["2026-08-14"]), ("看板与任务", &["2026-09-10T17:15:24+08:00"])],
                nl,
            );
            page(&fx, "quality", "order: 10\nsources: [\"desktop-app#桌面上的品质关卡\"]\ngenerated: 2026-09-05", "");
            page(&fx, "board", "order: 20\nsources: [\"desktop-app#看板与任务\"]\ngenerated: 2026-09-05", "");
            page(&fx, "whole", "order: 30\nsources: [desktop-app]\ngenerated: 2026-09-05", "");
            let v = list_manual_pages_at(fx.root());
            assert_eq!(page_of(&v, "quality")["stale"], false, "{tag}: 他段封存不影响锚定页");
            assert_eq!(page_of(&v, "board")["stale"], true, "{tag}: 锚定段自身封存即过期");
            assert_eq!(page_of(&v, "whole")["stale"], true, "{tag}: 裸名维持整份规格语意");
        }
    }

    #[test]
    fn missing_anchor_or_missing_spec_behind_an_anchor_counts_as_stale() {
        // manual-pages「锚定找不到即过期」：改名／删除或规格不存在都可见；裸名对不存在规格维持不标。
        let fx = FixtureRoot::new("manual-anchor-missing");
        spec_with_requirements(&fx, "desktop-app", &[("桌面上的品质关卡", &["2026-08-14"])], "\n");
        spec_with_trace(&fx, "x", &["2026-09-10T17:15:24+08:00"]);
        page(&fx, "renamed", "order: 10\nsources: [\"desktop-app#不存在的段\"]\ngenerated: 2026-09-05", "");
        page(&fx, "nospec-anchor", "order: 20\nsources: [\"not-exist#段\"]\ngenerated: 2026-09-05", "");
        page(&fx, "nospec-bare", "order: 30\nsources: [not-exist]\ngenerated: 2026-09-05", "");
        page(&fx, "mixed", "order: 40\nsources: [\"desktop-app#桌面上的品质关卡\", x]\ngenerated: 2026-09-05", "");
        let v = list_manual_pages_at(fx.root());
        assert_eq!(page_of(&v, "renamed")["stale"], true);
        assert_eq!(page_of(&v, "nospec-anchor")["stale"], true);
        assert_eq!(page_of(&v, "nospec-bare")["stale"], false);
        assert_eq!(page_of(&v, "mixed")["stale"], true, "任一项过期即页过期");
        assert_eq!(page_of(&v, "renamed")["sources"], serde_json::json!(["desktop-app#不存在的段"]));
    }

    #[test]
    fn empty_anchor_means_bare_capability_and_both_halves_are_trimmed() {
        // review 站 WARNING：`"cap#"` 不得永久过期（视同裸名）；`" cap # 段 "` 两半都去空白后照常解析。
        let fx = FixtureRoot::new("manual-anchor-edges");
        spec_with_requirements(&fx, "desktop-app", &[("桌面上的品质关卡", &["2026-08-14"])], "\n");
        page(&fx, "empty-anchor", "order: 10\nsources: [\"desktop-app#\"]\ngenerated: 2026-09-05", "");
        page(&fx, "padded", "order: 20\nsources: [\" desktop-app # 桌面上的品质关卡 \"]\ngenerated: 2026-09-05", "");
        page(&fx, "padded-old", "order: 30\nsources: [\" desktop-app # 桌面上的品质关卡 \"]\ngenerated: 2026-08-01", "");
        let v = list_manual_pages_at(fx.root());
        // 裸名语意：整份规格最新 2026-08-14 早于 2026-09-05 → 不过期（而非「找不到段」的永久过期）。
        assert_eq!(page_of(&v, "empty-anchor")["stale"], false);
        assert_eq!(page_of(&v, "padded")["stale"], false, "去空白后锚定命中该段，段时戳早于页");
        assert_eq!(page_of(&v, "padded-old")["stale"], true, "同一锚定对更早的页照常判过期");
        assert_eq!(page_of(&v, "padded")["sources"], serde_json::json!([" desktop-app # 桌面上的品质关卡 "]), "索引仍回原字符串");
    }

    #[test]
    fn uncovered_new_matches_the_capability_before_the_anchor() {
        // manual-pages「锚定项不影响未入册判定」：x 只以 "x#某段" 出现也算已入册。
        let fx = FixtureRoot::new("manual-anchor-uncovered");
        spec_with_requirements(&fx, "x", &[("某段", &["2026-09-10T17:15:24+08:00"])], "\n");
        spec_with_trace(&fx, "y", &["2026-09-10T17:15:24+08:00"]);
        page(&fx, "index", "order: 10\nsources: []\ngenerated: 2026-09-05", "");
        page(&fx, "px", "order: 20\nsources: [\"x#某段\"]\ngenerated: 2026-09-05", "");
        let v = list_manual_pages_at(fx.root());
        assert_eq!(v["uncoveredNew"], serde_json::json!(["y"]));
    }
}
