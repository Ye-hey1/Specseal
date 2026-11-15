//! 讨论结论的分刀解析（plan-unpromoted-cuts design D1）：Decision 字段里以粗体刀编号
//! 开头的顶层列点为一把刀。`plan`、server 的讨论详情回应与桌面详情页都读这一份
//! （discussion-cuts-from-engine），前端不另做判定。纯函数，不做 I/O。

use super::{DECISION_LABEL, DEFERRED_LABEL, REJECTED_LABEL};
use regex::Regex;
use serde::Serialize;
use std::sync::LazyLock;

/// 结论里规划的一把刀。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cut {
    /// 刀编号的原文（`cut 2`、`第 2 刀`、`刀二`）。
    pub id: String,
    /// 范围句；没有时为空字符串。
    pub title: String,
    /// 变更名，依出现顺序去重。
    pub names: Vec<String>,
    /// 变更名写在粗体内（``**cut N `change-name`**``）。false 时名称取自粗体之后，
    /// 可能混有识别字或文件名，无从判定是否已转出。
    pub names_in_bold: bool,
    /// 首行其余的说明（刀卡的第一条细线列）：范围句取自粗体时为粗体之后的全部文本
    /// （去掉开头冒号、外围整组括号），否则为第一个「——」之后的文本；没有时为空字符串。
    pub note: String,
    /// 列点首行去掉 `- ` 与头尾空白的原文——前端以它把刀对回结论里的那一条列点。
    pub line: String,
}

/// 一份记录里的一把刀，连同它在该记录 `promoted_to` 下的转出状态
/// （[`super::record_cuts`]）。栏名沿用 `plan` 的 `unpromotedCuts`。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordCut {
    pub cut: String,
    pub title: String,
    pub note: String,
    pub line: String,
    pub changes: Vec<String>,
    pub changes_in_bold: bool,
    /// [`Cut::unpromoted`]。
    pub unpromoted: Vec<String>,
}

impl Cut {
    /// 还不在 `promoted_to` 的变更名，依 `names` 的顺序。全部已转出时为空；变更名不在粗体内时
    /// 也为空——无从判定，不算尚未转出（与前端 `cutPromotion` 的 unknown 同义）。
    pub fn unpromoted(&self, promoted_to: &[String]) -> Vec<String> {
        if !self.names_in_bold {
            return Vec::new();
        }
        self.names.iter().filter(|n| !promoted_to.contains(n)).cloned().collect()
    }

    /// 这把刀在 `promoted_to` 下的 [`RecordCut`]。
    pub fn record(self, promoted_to: &[String]) -> RecordCut {
        RecordCut {
            unpromoted: self.unpromoted(promoted_to),
            cut: self.id,
            title: self.title,
            note: self.note,
            line: self.line,
            changes: self.names,
            changes_in_bold: self.names_in_bold,
        }
    }
}

/// Decision 字段到这些标签行为止。
const NEXT_LABELS: [&str; 5] = [
    "**Rationale**:",
    REJECTED_LABEL,
    DEFERRED_LABEL,
    "**Capture to**:",
    "**Next**:",
];

/// 粗体开头的刀编号：`cut <编号>`（编号以数字起头：`cut 3a`；`cutover` 不算）、
/// `第 N 刀`、`刀…`。与 discussionModel.ts 的 `CUT_ID_RE` 同形；`\d` 写成 `[0-9]`，
/// 因为 Rust 的 `\d` 含全角数字而 JS 的不含。
static CUT_ID: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(?:cut\s*[0-9][^\s，,：:（(]*|第\s*[^\s刀]+?\s*刀|刀[^\s，,：:（(]*)").unwrap()
});

/// 反引号片段（含内容为空的）。
static TICKS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"`[^`]*`").unwrap());

/// 反引号片段的内容。
static TICK_CONTENT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"`([^`]+)`").unwrap());

/// 解析结论（[`super::conclusion_text`] 的回传值）的 Decision 字段里的刀，依结论内的顺序。
/// 没有 Decision 字段或没有刀时回空。
pub fn parse_cuts(conclusion: &str) -> Vec<Cut> {
    let mut lines = conclusion.lines();
    let Some(first) = lines.find_map(|l| l.strip_prefix(DECISION_LABEL)) else {
        return Vec::new();
    };
    // 标签行的其余文本也属于字段（与前端 splitLabeledFields 的 `:\s?` 同形）。
    let first = first.strip_prefix(' ').unwrap_or(first);
    // 开着的围栏符号串；围栏行与围栏内的行都不是列点。
    let mut open: Option<&str> = None;
    std::iter::once(first)
        .chain(lines.take_while(|l| !NEXT_LABELS.iter().any(|label| l.starts_with(label))))
        .filter(|line| {
            let fence = fence_of(line);
            match (open, fence) {
                (None, Some((marks, _))) => open = Some(marks),
                (Some(o), Some((marks, info)))
                    if marks.starts_with(&o[..1]) && marks.len() >= o.len() && info.trim().is_empty() =>
                {
                    open = None
                }
                (None, None) => return true,
                _ => {}
            }
            false
        })
        .filter_map(|line| line.strip_prefix("- "))
        .filter_map(cut_of)
        .collect()
}

/// 围栏行的符号串（3 个以上 ` 或 ~，容忍前导空白）与其后的 info 字符串；不是围栏行时为 None。
/// 与前端 specSections.ts 的 `FENCE_RE` 同形：收尾行要与开头同字符、长度不短于开头、
/// 其后没有 info 字符串。
fn fence_of(line: &str) -> Option<(&str, &str)> {
    let t = line.trim_start();
    let mark = t.chars().next().filter(|c| *c == '`' || *c == '~')?;
    let n = t.len() - t.trim_start_matches(mark).len();
    (n >= 3).then(|| t.split_at(n))
}

/// 顶层列点首行（去掉 `- `）为一把刀时回刀。
fn cut_of(item: &str) -> Option<Cut> {
    let line = item.trim();
    let rest = line.strip_prefix("**")?;
    let close = rest.find("**")?;
    let (bold, after) = (&rest[..close], &rest[close + 2..]);
    let plain = TICKS
        .replace_all(bold, " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let id = CUT_ID.find(&plain)?.as_str();
    let scope = plain[id.len()..]
        .trim_start_matches(|c: char| c.is_whitespace() || ":：、—–-".contains(c))
        .trim();
    let tail = after.trim_start();
    let tail = tail.strip_prefix([':', '：']).unwrap_or(tail).trim();
    // 范围句取自粗体时粗体之后全部是说明；否则以第一个「——」切范围句与说明。
    let (title, note) = if !scope.is_empty() {
        (scope, unwrap_parens(tail))
    } else {
        match tail.find("——") {
            Some(i) => (tail[..i].trim(), tail[i + "——".len()..].trim()),
            None => (tail, ""),
        }
    };
    let in_bold = tick_names(bold);
    let names_in_bold = !in_bold.is_empty();
    Some(Cut {
        id: id.to_string(),
        title: title.to_string(),
        names: if names_in_bold { in_bold } else { tick_names(after) },
        names_in_bold,
        note: note.to_string(),
        line: line.to_string(),
    })
}

/// 外围恰为一整组括号（`（…）`／`(…)`，可嵌套；全角与半角视为同一种）时拿掉，否则原样。
fn unwrap_parens(text: &str) -> &str {
    let Some(first) = text.chars().next().filter(|c| "（(".contains(*c)) else {
        return text;
    };
    let mut depth = 0usize;
    for (i, c) in text.char_indices() {
        if "（(".contains(c) {
            depth += 1;
        } else if "）)".contains(c) {
            depth -= 1;
            if depth == 0 {
                let end = i + c.len_utf8();
                return if end == text.len() { text[first.len_utf8()..i].trim() } else { text };
            }
        }
    }
    text
}

/// 反引号片段里的名称，依出现顺序去重；内容含空白的不算（`specseal plan` 这类指令不是变更名）。
fn tick_names(text: &str) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    for m in TICK_CONTENT.captures_iter(text) {
        let name = m[1].trim();
        if !name.is_empty() && !name.contains(char::is_whitespace) && !names.iter().any(|n| n == name) {
            names.push(name.to_string());
        }
    }
    names
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 一段只含 Decision 字段的结论：定论句之后一条顶层列点。
    fn decision_with(item: &str) -> String {
        format!("**Decision**: 定案。\n\n- {item}\n")
    }

    fn only_cut(item: &str) -> Cut {
        let cuts = parse_cuts(&decision_with(item));
        assert_eq!(cuts.len(), 1, "{item:?} → {cuts:?}");
        cuts.into_iter().next().unwrap()
    }

    // --- spec「分刀解析」Example 的八列 ---

    #[test]
    fn example_rows_that_are_cuts_with_names_in_bold() {
        // (列点首行, cut, changes, title)
        let rows: &[(&str, &str, &[&str], &str)] = &[
            (
                "**cut 2 `plan-unpromoted-cuts`**: 引擎解析讨论结论的分刀列",
                "cut 2",
                &["plan-unpromoted-cuts"],
                "引擎解析讨论结论的分刀列",
            ),
            ("**Cut 3a `add-x`**: 范围——补充说明", "Cut 3a", &["add-x"], "范围"),
            ("**第 2 刀 `add-y`**", "第 2 刀", &["add-y"], ""),
            ("**刀二 收尾 `add-z`**", "刀二", &["add-z"], "收尾"),
            ("**cut 1 `specseal plan` `add-w`**: 说明", "cut 1", &["add-w"], "说明"),
        ];
        for (item, id, names, title) in rows {
            let cut = only_cut(item);
            assert_eq!(cut.id, *id, "{item}");
            assert_eq!(cut.names, *names, "{item}");
            assert_eq!(cut.title, *title, "{item}");
            assert!(cut.names_in_bold, "{item}");
        }
    }

    #[test]
    fn example_rows_that_are_not_cuts() {
        for item in ["**cutover `add-v`**: 说明", "`add-u` 不以粗体开头"] {
            assert_eq!(parse_cuts(&decision_with(item)), [], "{item}");
        }
    }

    #[test]
    fn example_row_cut_without_names_in_bold_is_flagged() {
        // 是刀，但粗体内没有变更名：名称改取粗体之后，names_in_bold 为 false（plan 不列出）。
        let cut = only_cut("**cut 2 外壳**（`add-x`）");
        assert_eq!(cut.id, "cut 2");
        assert_eq!(cut.title, "外壳");
        assert_eq!(cut.names, ["add-x"]);
        assert!(!cut.names_in_bold);
    }

    // --- Decision 字段边界 ---

    #[test]
    fn a_cut_item_after_the_rationale_label_is_not_a_cut() {
        let conclusion = "**Decision**: 定案。\n\n- **cut 1 `add-a`**: 第一刀\n\n\
                          **Rationale**: 理由。\n\n- **cut 2 `add-b`**: 不在 Decision 内\n";
        let cuts = parse_cuts(conclusion);
        assert_eq!(cuts.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), ["cut 1"]);
    }

    #[test]
    fn a_nested_item_is_not_a_cut() {
        let conclusion = "**Decision**: 定案。\n\n- **cut 1 `add-a`**: 第一刀\n  - **cut 2 `add-b`**: 嵌套\n";
        let cuts = parse_cuts(conclusion);
        assert_eq!(cuts.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), ["cut 1"]);
    }

    #[test]
    fn a_conclusion_without_a_decision_label_has_no_cuts() {
        let conclusion = "**Rationale**: 理由。\n\n- **cut 1 `add-a`**: 第一刀\n";
        assert_eq!(parse_cuts(conclusion), []);
    }

    #[test]
    fn cuts_keep_their_order_in_the_conclusion() {
        let conclusion = "**Decision**: 定案。\n\n- **cut 1 `add-a`**: 一\n- 一般细节\n- **cut 2 `add-b`**: 二\n";
        let cuts = parse_cuts(conclusion);
        assert_eq!(cuts.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), ["cut 1", "cut 2"]);
    }

    // --- sharp-edges 稽核（tasks 5.1）：手改讨论档的五种形状 ---

    #[test]
    fn crlf_line_endings_parse_like_lf() {
        // 判定：无缺口——`str::lines` 去掉行尾 `\r`，标签、列点与围栏判定都不受影响。
        let lf = "**Decision**: 定案。\n\n- **cut 1 `add-a`**: 一\n\n**Rationale**: 理由。\n\n- **cut 2 `add-b`**: 二\n";
        let cuts = parse_cuts(&lf.replace('\n', "\r\n"));
        assert_eq!(cuts, parse_cuts(lf));
        assert_eq!(cuts[0].title, "一");
    }

    #[test]
    fn an_unpaired_bold_is_not_a_cut() {
        // 判定：无缺口——找不到收尾 `**` 就不是刀（与前端 indexOf 同形）。
        assert_eq!(parse_cuts(&decision_with("**cut 1 `add-a`: 说明")), []);
    }

    #[test]
    fn an_unclosed_backtick_in_bold_yields_no_name_in_bold() {
        // 判定：无缺口——未闭合的反引号不成名称，names_in_bold 为 false，plan 不列出。
        let cut = only_cut("**cut 1 `add-a**: 说明");
        assert_eq!(cut.id, "cut 1");
        assert!(!cut.names_in_bold);
    }

    #[test]
    fn a_very_long_item_parses_in_linear_time() {
        // 判定：无缺口——regex crate 保证线性时间，没有回溯爆炸；长度不设上限。
        let title = "长".repeat(200_000);
        let cut = only_cut(&format!("**cut 1 `add-a`**: {title}"));
        assert_eq!(cut.title.chars().count(), 200_000);
    }

    #[test]
    fn a_change_name_repeated_across_cuts_stays_in_each_cut() {
        // 判定：无缺口——同一刀内去重；两把刀写了同一名称是结论本身的写法，照实各列一把。
        let conclusion = "**Decision**: 定案。\n\n- **cut 1 `add-a` `add-a`**: 一\n- **cut 2 `add-a`**: 二\n";
        let cuts = parse_cuts(conclusion);
        assert_eq!(cuts[0].names, ["add-a"]);
        assert_eq!(cuts[1].names, ["add-a"]);
    }

    // --- 围栏：与前端 specSections.ts 的 fenceFlags 同一条收尾规则 ---

    #[test]
    fn a_shorter_fence_inside_a_longer_one_does_not_close_it() {
        let conclusion = "**Decision**: 定案。\n\n````\n```\n- **cut 1 `add-a`**: 范例\n```\n````\n\
                          - **cut 2 `add-b`**: 真的\n";
        let cuts = parse_cuts(conclusion);
        assert_eq!(cuts.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), ["cut 2"]);
    }

    #[test]
    fn a_tilde_line_does_not_close_a_backtick_fence() {
        let conclusion = "**Decision**: 定案。\n\n```\n~~~\n- **cut 1 `add-a`**: 范例\n```\n\
                          - **cut 2 `add-b`**: 真的\n";
        let cuts = parse_cuts(conclusion);
        assert_eq!(cuts.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), ["cut 2"]);
    }

    #[test]
    fn a_fence_line_with_an_info_string_does_not_close_a_fence() {
        let conclusion = "**Decision**: 定案。\n\n```\n```rust\n- **cut 1 `add-a`**: 范例\n```\n\
                          - **cut 2 `add-b`**: 真的\n";
        let cuts = parse_cuts(conclusion);
        assert_eq!(cuts.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), ["cut 2"]);
    }

    // --- 与改版前的前端判定不同、依规格字面的两处（第 4 刀起前端改读引擎数据，两边一致）---

    #[test]
    fn a_bold_cut_paragraph_outside_a_list_item_is_not_a_cut() {
        // 判定：依规格只认行首 `- ` 的顶层列点；改版前的前端另把列点后的散文段也当刀。
        let conclusion = "**Decision**: 定案。\n\n- **cut 1 `add-a`**: 一\n\n**cut 2 `add-b`**: 散文段\n";
        let cuts = parse_cuts(conclusion);
        assert_eq!(cuts.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), ["cut 1"]);
    }

    #[test]
    fn a_second_decision_label_does_not_end_the_field() {
        // 判定：依规格 Decision 字段到下一个 Rationale／Rejected alternatives／Deferred／
        // Capture to／Next 标签行为止，第二行 `**Decision**:` 不是边界；改版前的前端只取最后一段。
        let conclusion = "**Decision**: 一\n\n- **cut 1 `add-a`**: 一\n\n**Decision**: 二\n\n- **cut 2 `add-b`**: 二\n";
        let cuts = parse_cuts(conclusion);
        assert_eq!(cuts.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), ["cut 1", "cut 2"]);
    }

    // --- 转出判定 ---

    #[test]
    fn unpromoted_lists_the_names_not_in_promoted_to_in_names_order() {
        let cut = only_cut("**cut 1 `add-c` `add-a` `add-b`**: 三个");
        let promoted = ["add-a".to_string()];
        assert_eq!(cut.unpromoted(&promoted), ["add-c", "add-b"]);
        let all = ["add-a".to_string(), "add-b".to_string(), "add-c".to_string()];
        assert!(cut.unpromoted(&all).is_empty());
    }

    #[test]
    fn unpromoted_is_empty_when_the_names_are_not_in_bold() {
        // 粗体内没有变更名：无从判定，不算尚未转出。
        let cut = only_cut("**cut 2 外壳**（`add-x`）");
        assert!(cut.unpromoted(&[]).is_empty());
    }

    // --- 首行说明与列点原文（discussion-cuts-from-engine）---

    #[test]
    fn example_rows_carry_note_and_line() {
        // client-protocol「分刀各栏」Example 三列：(列点首行, cut, title, note, changes, changesInBold)
        let rows: &[(&str, &str, &str, &str, &[&str], bool)] = &[
            ("**cut 1 `a`**: 骨架——三种详情页改三栏", "cut 1", "骨架", "三种详情页改三栏", &["a"], true),
            (
                "**cut 2 外壳**（拆两个 change：`b` 外壳、`c` 菜单）",
                "cut 2",
                "外壳",
                "拆两个 change：`b` 外壳、`c` 菜单",
                &["b", "c"],
                false,
            ),
            ("**cut 3 `d` `e`**: 收尾", "cut 3", "收尾", "", &["d", "e"], true),
        ];
        for (item, id, title, note, names, in_bold) in rows {
            let cut = only_cut(item);
            assert_eq!(cut.id, *id, "{item}");
            assert_eq!(cut.title, *title, "{item}");
            assert_eq!(cut.note, *note, "{item}");
            assert_eq!(cut.names, *names, "{item}");
            assert_eq!(cut.names_in_bold, *in_bold, "{item}");
            assert_eq!(cut.line, *item, "{item}");
        }
    }

    #[test]
    fn note_matches_the_desktop_rows() {
        // 自前端 discussionModel.test.ts 移来的说明列案例（detail-content-redesign、desktop-ui-redesign 真实结论），
        // 加上 desktop-app「分刀列的解析」Example 第 1、4 列原句：
        // (列点首行, note)
        let rows: &[(&str, &str)] = &[
            (
                "**cut 1 `desktop-detail-doc-tree`**: 骨架——三种详情页改三栏，九份文档先以现有渲染器落进新骨架",
                "三种详情页改三栏，九份文档先以现有渲染器落进新骨架",
            ),
            (
                "**cut 2 `desktop-change-doc-views`**: 变更文档渲染器——提案、设计的新画法；依赖 cut 1",
                "提案、设计的新画法；依赖 cut 1",
            ),
            ("**cut 1 `desktop-detail-doc-tree`**: 骨架——三种详情页改三栏", "三种详情页改三栏"),
            (
                "**cut 2 外壳**（propose 期拆两个 change：`desktop-shell-redesign` 外壳结构、`desktop-native-menu` 原生菜单）",
                "propose 期拆两个 change：`desktop-shell-redesign` 外壳结构、`desktop-native-menu` 原生菜单",
            ),
            // 没有「——」、范围句不在粗体内：没有说明。
            ("**cut 0 `fix-drawer-open-dismisses-overlays`**: 独立 bug 修，不等换皮（已封存）", ""),
            ("**cut 5 `tray-panel-restyle`**: 系统匣面板，可与 3a、3b、4 并行", ""),
            // 粗体内有范围词：外围整组括号（内含嵌套括号）拿掉。
            (
                "**cut 2 外壳**（propose 期拆三个 change：`desktop-shell-redesign` 外壳结构、\
                 `desktop-notice-relocation` 提示归位（依赖前者）、`desktop-native-menu` macOS 原生菜单（独立）；三者皆已转出）",
                "propose 期拆三个 change：`desktop-shell-redesign` 外壳结构、\
                 `desktop-notice-relocation` 提示归位（依赖前者）、`desktop-native-menu` macOS 原生菜单（独立）；三者皆已转出",
            ),
            ("**cut 3a 看板**(半角括号说明)", "半角括号说明"),
            // 外围不是一整组括号：原样。
            ("**cut 2 外壳**（甲）乙（丙）", "（甲）乙（丙）"),
            // 粗体内有范围词：粗体之后的全部文本（去掉开头冒号）都是说明，「——」不切。
            ("**cut 2 外壳**: 说明——补充", "说明——补充"),
            ("**刀三**：系统匣面板", ""),
            ("**Cut 3a `x-y`**", ""),
        ];
        for (item, note) in rows {
            assert_eq!(only_cut(item).note, *note, "{item}");
        }
    }

    #[test]
    fn line_is_the_first_line_without_the_marker_and_outer_whitespace() {
        let conclusion = "**Decision**: 定案。\n\n- **cut 1 `a`**: 骨架   \n  续行散文。\n";
        let cuts = parse_cuts(conclusion);
        assert_eq!(cuts[0].line, "**cut 1 `a`**: 骨架");
    }

    // --- sharp-edges 稽核（discussion-cuts-from-engine tasks 2.4）：GET /discussions/{slug} 的 cuts
    // 来自 store 里手改得到的记录 ---

    #[test]
    fn a_very_long_note_and_line_parse_in_linear_time() {
        // 判定：无缺口——unwrap_parens 单趟扫描、note 与 line 只是拷贝，回应大小为内容的常数倍；长度不设上限。
        let long = "长".repeat(200_000);
        let cut = only_cut(&format!("**cut 1 外壳**（{long}）"));
        assert_eq!(cut.note.chars().count(), 200_000);
        assert_eq!(cut.line.chars().count(), 200_000 + "**cut 1 外壳**（）".chars().count());
    }

    #[test]
    fn mixed_and_unbalanced_parens_follow_the_desktop_rule() {
        // 判定：无缺口——全角与半角视为同一种括号（与改版前的前端规则相同）；不成对时原样保留；
        // 切点都落在 char_indices 给的字符边界，多字节括号不会 panic。
        for (item, note) in [
            ("**cut 2 外壳**（混用)", "混用"),
            ("**cut 2 外壳**(混用）", "混用"),
            ("**cut 2 外壳**（没有收尾", "（没有收尾"),
            ("**cut 2 外壳**（（只收一层）", "（（只收一层）"),
            ("**cut 2 外壳**（）", ""),
        ] {
            assert_eq!(only_cut(item).note, note, "{item}");
        }
    }

    #[test]
    fn an_unpaired_bold_leaves_no_cut_for_the_detail_response() {
        // 判定：无缺口——只有开头 `**` 的列不成刀（cut_of 找不到收尾即回 None），详情回应的 cuts 为空。
        assert_eq!(parse_cuts(&decision_with("**cut 1 外壳（`add-a`）")), []);
    }

    #[test]
    fn an_empty_promoted_to_leaves_every_name_in_bold_unpromoted() {
        // 判定：无缺口——promoted_to 为空时粗体内的变更名全部尚未转出；名称不在粗体内的刀仍为空（无从判定）。
        assert_eq!(only_cut("**cut 1 `add-a` `add-b`**: 一").record(&[]).unpromoted, ["add-a", "add-b"]);
        assert!(only_cut("**cut 2 外壳**（`add-x`）").record(&[]).unpromoted.is_empty());
    }

    // --- 自前端 discussionModel.test.ts 移来的案例（discussion-cuts-from-engine 移除前端分刀解析时逐列对照）---

    #[test]
    fn desktop_rows_that_are_cuts() {
        // (列点首行, cut, changes, title, changesInBold)
        let rows: &[(&str, &str, &[&str], &str, bool)] = &[
            // desktop-app「分刀列的解析」Example 第 1、4 列原句（第 2、3 列见下方两列）。
            ("**cut 1 `desktop-detail-doc-tree`**: 骨架——三种详情页改三栏", "cut 1", &["desktop-detail-doc-tree"], "骨架", true),
            (
                "**cut 2 外壳**（propose 期拆两个 change：`desktop-shell-redesign` 外壳结构、`desktop-native-menu` 原生菜单）",
                "cut 2",
                &["desktop-shell-redesign", "desktop-native-menu"],
                "外壳",
                false,
            ),
            ("**刀三**：系统匣面板", "刀三", &[], "系统匣面板", false),
            ("**第三刀**：系统匣", "第三刀", &[], "系统匣", false),
            (
                "**cut 2 `desktop-shell-redesign` `desktop-notice-relocation`**: 外壳 7 项",
                "cut 2",
                &["desktop-shell-redesign", "desktop-notice-relocation"],
                "外壳 7 项",
                true,
            ),
            // 粗体之后含空白的反引号片段（指令）不算变更名。
            (
                "**cut 4 设置**（先跑 `specseal plan`，再建 `desktop-settings-mode`）",
                "cut 4",
                &["desktop-settings-mode"],
                "设置",
                false,
            ),
            // 识别签止于括号；粗体内没有反引号片段时名称取自粗体之后。
            ("**刀一（候选 1＋2）**：`KeyLines` 原语＋`DiscussionHead`", "刀一", &["KeyLines", "DiscussionHead"], "（候选 1＋2）", false),
        ];
        for (item, id, names, title, in_bold) in rows {
            let cut = only_cut(item);
            assert_eq!(cut.id, *id, "{item}");
            assert_eq!(cut.names, *names, "{item}");
            assert_eq!(cut.title, *title, "{item}");
            assert_eq!(cut.names_in_bold, *in_bold, "{item}");
        }
    }

    #[test]
    fn desktop_rows_that_are_not_cuts() {
        for item in [
            "**范围与验收**：只改 UI 渲染",
            "**cutover 计划**：切换步骤",
            "**Cut scope**：范围说明",
            "**`desktop-app`**: 粗体内只有反引号",
            "cut 1 `x`：没有粗体",
        ] {
            assert_eq!(parse_cuts(&decision_with(item)), [], "{item}");
        }
    }

    #[test]
    fn bullets_other_than_a_dash_are_not_cuts() {
        // desktop-app「分刀列的解析」Example 第 6 列与同类写法：只认 `- ` 起头的顶层列点，
        // `*`、`+`、编号列点的刀列不成刀、留在定案细节（与 plan 的 unpromotedCuts 一致）。
        for item in ["* **cut 3 `add-x`**: 范围", "+ **cut 3 `add-x`**: 范围", "1. **cut 3 `add-x`**: 范围"] {
            let conclusion = format!("**Decision**: 定案。\n\n{item}\n");
            assert_eq!(parse_cuts(&conclusion), [], "{item}");
        }
    }

    fn ids_titles_names(conclusion: &str) -> Vec<(String, String, Vec<String>)> {
        parse_cuts(conclusion).into_iter().map(|c| (c.id, c.title, c.names)).collect()
    }

    fn row(id: &str, title: &str, names: &[&str]) -> (String, String, Vec<String>) {
        (id.into(), title.into(), names.iter().map(|n| n.to_string()).collect())
    }

    #[test]
    fn the_detail_content_redesign_conclusion_has_three_cuts() {
        let conclusion = "**Decision**: 变更、讨论、已封存三种详情页的内容呈现改成手册式三栏阅读页，原始 Markdown 格式与模板不动，分三刀落地。\n\
             - 范围与验收：只改 UI 渲染\n\
             - 版面：左栏 240px 文档树\n\
             - **cut 1 `desktop-detail-doc-tree`**: 骨架——三种详情页改三栏，九份文档先以现有渲染器落进新骨架\n\
             \x20 - 文档树栏（身分区、文档节点、状态区）\n\
             \x20 - 分页列退场；已封存详情页同步\n\
             - **cut 2 `desktop-change-doc-views`**: 变更文档渲染器——提案、设计的新画法；依赖 cut 1\n\
             \x20 - 章节白名单与逐项降级规则落在这一刀\n\
             - **cut 3 `desktop-discussion-doc-views`**: 讨论文档渲染器——结论分刀卡；最后一刀\n\
             \x20 - desktop-app 讨论轮、讨论结论、讨论详情页需求 MODIFIED\n\
             **Rationale**: 手册页已经证明三栏阅读页成立。\n";
        assert_eq!(
            ids_titles_names(conclusion),
            [
                row("cut 1", "骨架", &["desktop-detail-doc-tree"]),
                row("cut 2", "变更文档渲染器", &["desktop-change-doc-views"]),
                row("cut 3", "讨论文档渲染器", &["desktop-discussion-doc-views"]),
            ]
        );
    }

    #[test]
    fn the_desktop_ui_redesign_cuts_take_names_after_a_scoped_bold() {
        let conclusion = "**Decision**: 整个接口重新设计，分七刀落地。\n\
             - 底层不换：React 19＋Tailwind v4\n\
             - **cut 0 `fix-drawer-open-dismisses-overlays`**: 独立 bug 修，不等换皮（已封存）\n\
             \x20 - openDetail 清掉可取消浮层\n\
             - **cut 2 外壳**（propose 期拆三个 change：`desktop-shell-redesign` 外壳结构、`desktop-notice-relocation` 提示归位（依赖前者）、`desktop-native-menu` macOS 原生菜单（独立）；三者皆已转出）\n\
             \x20 - 三平台标题列\n\
             - **cut 3a 看板**（propose 期拆两个 change：`desktop-board-reskin` 栏与卡、`desktop-list-pages-reskin` 规格／已封存／手册三页；皆依赖 desktop-shell-redesign；两者皆已转出）\n\
             - **cut 5 `tray-panel-restyle`**: 系统匣面板，可与 3a、3b、4 并行\n";
        assert_eq!(
            ids_titles_names(conclusion),
            [
                row("cut 0", "独立 bug 修，不等换皮（已封存）", &["fix-drawer-open-dismisses-overlays"]),
                row("cut 2", "外壳", &["desktop-shell-redesign", "desktop-notice-relocation", "desktop-native-menu"]),
                row("cut 3a", "看板", &["desktop-board-reskin", "desktop-list-pages-reskin"]),
                row("cut 5", "系统匣面板，可与 3a、3b、4 并行", &["tray-panel-restyle"]),
            ]
        );
    }

    #[test]
    fn a_cut_item_inside_a_fenced_block_is_not_a_cut() {
        // 与桌面 parseListItems 同一条规则：围栏内的行不是列点。
        let conclusion = "**Decision**: 定案。\n\n```\n- **cut 1 `add-a`**: 范例\n```\n";
        assert_eq!(parse_cuts(conclusion), []);
    }
}
