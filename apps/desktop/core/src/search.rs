//! workspace 全文查找（desktop-ux-polish design D6）：遍历 active 变更的
//! artifacts（proposal／design／tasks／delta 规格）与 active 讨论记录，
//! 不分大小写子字符串比对，回传命中卡片与 snippet——看板全文搜索的单一数据源。
//! 每张卡取首个命中 artifact 的首个命中处；比对走 char 层，snippet 裁切
//! 不会落在多字节字符中间（内容多为中文）。

use std::path::Path;

use serde_json::{json, Value};
use specseal_core::store::Store;

use crate::init_core_context;

/// snippet 于命中前后各保留的字符数（char，非 byte）。
const SNIPPET_CONTEXT: usize = 30;

/// 对看板全文搜索：`{ "hits": [{ kind, id, artifact, snippet }] }`。
/// 空（或仅空白）query 与非项目目录一律回传空命中，不视为错误。
pub fn search_workspace_at(root: &Path, query: &str) -> Value {
    let q = query.trim();
    if q.is_empty() {
        return json!({ "hits": [] });
    }
    let Some(ctx) = init_core_context(root) else {
        return json!({ "hits": [] });
    };
    // 扫的全是 artifact，overlay 即足够（design D2）——有 worktree 映射的 change
    // 命中其副本现值，其余直通主 checkout；facts 为空时 overlay 全数直通，即主
    // store 本身，毋须另设守门。
    let facts = crate::facts_for(&ctx);
    let overlaid = crate::query::overlay_store(&ctx, &facts);
    let store: &dyn Store = &overlaid;
    let mut hits: Vec<Value> = Vec::new();

    // active 变更：artifacts 依固定序扫描，首个命中即代表该卡。
    for change in specseal_core::model::list_changes(store) {
        let mut artifacts = vec![
            "proposal.md".to_string(),
            "design.md".to_string(),
            "tasks.md".to_string(),
        ];
        for cap in store.delta_capabilities(&change.name) {
            artifacts.push(format!("specs/{cap}/spec.md"));
        }
        for artifact in artifacts {
            let Some(text) = store.read_artifact(&change.name, &artifact) else { continue };
            if let Some(snippet) = find_snippet(&text, q) {
                hits.push(json!({
                    "kind": "change",
                    "id": change.name,
                    "artifact": artifact,
                    "snippet": snippet,
                }));
                break;
            }
        }
    }

    // active 讨论记录全文。
    for doc in store.list_live_discussions() {
        if let Some(snippet) = find_snippet(&doc.text, q) {
            hits.push(json!({
                "kind": "discussion",
                "id": doc.slug,
                "artifact": doc
                    .path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                "snippet": snippet,
            }));
        }
    }

    json!({ "hits": hits })
}

/// char 层不分大小写子字符串搜索：命中时回传前后各 [`SNIPPET_CONTEXT`] 字符的
/// 裁切（含命中原文；截断端补 …），未命中回 None。以 char 为单位比对与裁切，
/// 避开 to_lowercase 位移与多字节边界问题。
fn find_snippet(text: &str, query: &str) -> Option<String> {
    let hay: Vec<char> = text.chars().collect();
    let hay_lower: Vec<char> = hay.iter().map(lower_first).collect();
    let needle: Vec<char> = query.chars().map(|c| lower_first(&c)).collect();
    if needle.is_empty() || hay_lower.len() < needle.len() {
        return None;
    }
    let start = (0..=hay_lower.len() - needle.len())
        .find(|&i| hay_lower[i..i + needle.len()] == needle[..])?;
    let end = start + needle.len();
    let from = start.saturating_sub(SNIPPET_CONTEXT);
    let to = (end + SNIPPET_CONTEXT).min(hay.len());
    let mut snippet = String::new();
    if from > 0 {
        snippet.push('…');
    }
    // 换行压成空白：snippet 是卡片上的单行呈现。
    snippet.extend(hay[from..to].iter().map(|c| if *c == '\n' || *c == '\r' { ' ' } else { *c }));
    if to < hay.len() {
        snippet.push('…');
    }
    Some(snippet)
}

/// char 层小写化：取 to_lowercase 的首字符（ASCII 与 CJK 皆 1:1；罕见多字符
/// 展开取首字符即可——本查找是辅助路径，不追求 Unicode 完备折叠）。
fn lower_first(c: &char) -> char {
    c.to_lowercase().next().unwrap_or(*c)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testfixture::FixtureRoot;

    const META: &str = "schema: spec-driven\ncreated: 2026-07-01\ncreated_by: momo\ncreated_with: claude\n";

    fn write_discussion(fx: &FixtureRoot, slug: &str, body: &str) {
        fx.write(
            &format!("specseal/discussions/{slug}.md"),
            &format!("---\ntopic: t\nslug: {slug}\nstatus: open\ncreated: 2026-07-01\n---\n\n{body}\n"),
        );
    }

    #[test]
    fn hits_change_artifacts_case_insensitively_with_snippet() {
        let fx = FixtureRoot::new("s-change");
        fx.add_change("demo", META);
        fx.write(
            "specseal/changes/demo/design.md",
            "## Context\n\n唯一 Command Runtime 的 Dispatch 兼容层设计。\n",
        );
        let v = search_workspace_at(fx.root(), "dispatch");
        let hits = v["hits"].as_array().expect("hits array");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0]["kind"], "change");
        assert_eq!(hits[0]["id"], "demo");
        assert_eq!(hits[0]["artifact"], "design.md");
        let snippet = hits[0]["snippet"].as_str().unwrap();
        assert!(snippet.contains("Dispatch"), "snippet 保留命中原文大小写: {snippet}");
        assert!(snippet.contains("兼容层"), "snippet 含命中后文: {snippet}");
    }

    #[test]
    fn first_matching_artifact_wins_one_hit_per_card() {
        // 每卡一命中：proposal 先于 design 扫描，两者皆含关键字时取 proposal。
        let fx = FixtureRoot::new("s-first");
        fx.add_change("demo", META);
        fx.write("specseal/changes/demo/proposal.md", "## Why\n\nkeyword here\n");
        fx.write("specseal/changes/demo/design.md", "## Context\n\nkeyword again\n");
        let v = search_workspace_at(fx.root(), "keyword");
        let hits = v["hits"].as_array().unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0]["artifact"], "proposal.md");
    }

    #[test]
    fn hits_delta_specs_and_live_discussions() {
        let fx = FixtureRoot::new("s-spec-disc");
        fx.add_change("demo", META);
        fx.write(
            "specseal/changes/demo/specs/some-cap/spec.md",
            "## ADDED Requirements\n\n### Requirement: 浮层落点\n\n内容 zebra-token 在此。\n",
        );
        write_discussion(&fx, "talk", "## Rounds\n\n关于 zebra-token 的讨论。");
        let v = search_workspace_at(fx.root(), "ZEBRA-TOKEN");
        let hits = v["hits"].as_array().unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0]["kind"], "change");
        assert_eq!(hits[0]["artifact"], "specs/some-cap/spec.md");
        assert_eq!(hits[1]["kind"], "discussion");
        assert_eq!(hits[1]["id"], "talk");
    }

    #[test]
    fn hits_content_that_only_exists_in_the_worktree_copy() {
        // spec worktree-overlay Scenario「全文搜索命中 worktree 内容」：某字符串仅存在
        // 于 worktree 副本的 design.md、不存在于主 checkout，仍须命中该卡且 snippet
        // 取自副本内容。
        let fx = FixtureRoot::new("s-worktree");
        fx.add_change("add-auth", META);
        fx.write("specseal/changes/add-auth/design.md", "## Context\n\n主 checkout 的旧设计。\n");
        let wt = fx.attach_worktree("add-auth");
        std::fs::write(
            wt.change_dir("add-auth").join("design.md"),
            "## Context\n\n只在 worktree 的 zebra-token 段落。\n",
        )
        .unwrap();

        let v = search_workspace_at(fx.root(), "zebra-token");
        let hits = v["hits"].as_array().expect("hits array");
        assert_eq!(hits.len(), 1, "仅存在于 worktree 的字符串须命中: {v}");
        assert_eq!(hits[0]["id"], "add-auth");
        assert_eq!(hits[0]["artifact"], "design.md");
        assert!(
            hits[0]["snippet"].as_str().unwrap().contains("只在 worktree"),
            "snippet 取自 worktree 副本: {v}"
        );
    }

    #[test]
    fn no_match_empty_query_and_non_project_all_return_empty_hits() {
        let fx = FixtureRoot::new("s-empty");
        fx.add_change("demo", META);
        assert!(search_workspace_at(fx.root(), "nonexistent-zzz")["hits"].as_array().unwrap().is_empty());
        assert!(search_workspace_at(fx.root(), "   ")["hits"].as_array().unwrap().is_empty());
        let non_project = std::env::temp_dir().join("specseal-search-nonproj");
        let _ = std::fs::create_dir_all(&non_project);
        assert!(search_workspace_at(&non_project, "x")["hits"].as_array().unwrap().is_empty());
    }

    #[test]
    fn snippet_truncates_around_cjk_match_without_panicking() {
        // 中文（多字节）内容的长文命中：char 层裁切、两端补 …，不 panic。
        let fx = FixtureRoot::new("s-cjk");
        fx.add_change("demo", META);
        let long = format!("{}目标词{}", "前".repeat(80), "后".repeat(80));
        fx.write("specseal/changes/demo/design.md", &format!("## Context\n\n{long}\n"));
        let v = search_workspace_at(fx.root(), "目标词");
        let snippet = v["hits"][0]["snippet"].as_str().unwrap().to_string();
        assert!(snippet.starts_with('…') && snippet.ends_with('…'), "两端截断补 …: {snippet}");
        assert!(snippet.contains("目标词"));
        // 前后各约 30 字符＋命中 3 字＋两个 …。
        assert!(snippet.chars().count() <= 30 + 3 + 30 + 2);
    }
}
