//! capability 命名知识（design D4）：近似名排序与建议池组装。排序是纯函数；
//! 建议池唯读组合既有 Store 接口（正典枚举、delta 枚举、规格读取），不写入。
//! 不含 ANSI；消息文本由调用端（newcmd 的错误消息、validate 的 warning）组装，
//! 建议行的共用格式在 [`suggestion_line`]。
//!
//! 排序依序比较：名称 token 的完全包含关系（`auth` ⊂ `authentication`）优先，
//! 其次 kebab 字段交集数，再次编辑距离。入选门槛＝有任何交集（token 包含或
//! 共字段），编辑距离只排序不入选——毫无交集回空清单，拒绝与否由调用端的
//! 二元事实（正典有无收录）决定。比对一律先做 ASCII 小写折叠：大小写不敏感
//! 文档系统上的 `Auth` 与正典 `auth` 必须互相看得见。

use crate::model;
use crate::store::Store;

/// 建议的来源标注。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Source {
    /// 正式规格（openspec/specs/）。
    Canonical,
    /// 未封存 change 的 delta，值＝该 change 名。
    InFlight(String),
}

/// 带来源标注的既有 capability 名（建议池的一笔，也是建议清单的一笔）。
#[derive(Debug, Clone)]
pub struct KnownName {
    pub name: String,
    pub source: Source,
    /// 该规格 `## Purpose` 区段首行；来源无 Purpose 时为 None（消息略去该行）。
    pub purpose: Option<String>,
}

/// 候选名对既有名集合的近似建议：至多三笔，无近似回空。
pub fn suggest(candidate: &str, known: &[KnownName]) -> Vec<KnownName> {
    let cand = candidate.to_ascii_lowercase();
    let cand_tokens = tokens(&cand);
    let mut ranked: Vec<(bool, usize, usize, KnownName)> = known
        .iter()
        .filter_map(|k| {
            let name = k.name.to_ascii_lowercase();
            let name_tokens = tokens(&name);
            let contains = token_containment(&cand_tokens, &name_tokens);
            let overlap = name_tokens.iter().filter(|t| cand_tokens.contains(t)).count();
            if !contains && overlap == 0 {
                return None;
            }
            Some((contains, overlap, edit_distance(&cand, &name), k.clone()))
        })
        .collect();
    ranked.sort_by(|a, b| {
        b.0.cmp(&a.0) // 包含优先
            .then(b.1.cmp(&a.1)) // 交集数多者在前
            .then(a.2.cmp(&b.2)) // 编辑距离近者在前
            .then(a.3.name.cmp(&b.3.name)) // 全同时以名称定序，输出可重现
    });
    ranked.into_iter().take(3).map(|(_, _, _, k)| k).collect()
}

/// 近似名建议池（design D3）：正典 capabilities（附正典 Purpose 首行）＋所有
/// 未封存 change 的 delta capabilities（附来源 change 名与 delta Purpose 首行），
/// 同名以正典优先去重。创建点主闸与 validate 的 warning lint 共用这一份，
/// 两处建议一致；validate 端自行滤掉受检 capability 自身。
pub(crate) fn suggestion_pool(store: &dyn Store) -> Vec<KnownName> {
    let mut caps = store.list_canonical_capabilities();
    caps.sort();
    let mut pool: Vec<KnownName> = caps
        .iter()
        .map(|cap| KnownName {
            name: cap.clone(),
            source: Source::Canonical,
            purpose: purpose_first_line(store.read_canonical_spec(cap).as_deref()),
        })
        .collect();
    for change in store.list_changes() {
        for cap in store.delta_capabilities(&change.name) {
            if pool.iter().any(|k| k.name == cap) {
                continue;
            }
            let text = store.read_artifact(&change.name, &model::delta_spec_artifact(&cap));
            pool.push(KnownName {
                name: cap,
                source: Source::InFlight(change.name.clone()),
                purpose: purpose_first_line(text.as_deref()),
            });
        }
    }
    pool
}

/// 一笔建议的显示行（不含缩进与列点符号）：`name (来源标注): Purpose 首行`，
/// 无 Purpose 时略去冒号后段。
/// 建议清单的共用外框：`Similar existing names:` 标头加逐笔缩进列点，每行
/// 带结尾换行。调用端（newcmd 主闸、trace 的 not-found）共用同一份措辞。
pub(crate) fn suggestion_block(suggestions: &[KnownName]) -> String {
    let mut out = String::from("Similar existing names:\n");
    for s in suggestions {
        out.push_str(&format!("  - {}\n", suggestion_line(s)));
    }
    out
}

pub(crate) fn suggestion_line(k: &KnownName) -> String {
    let source = match &k.source {
        Source::Canonical => "canonical".to_string(),
        Source::InFlight(change) => format!("in-flight: {change}"),
    };
    match &k.purpose {
        Some(p) => format!("{} ({source}): {p}", k.name),
        None => format!("{} ({source})", k.name),
    }
}

/// 规格 `## Purpose` 区段的首行（trim 后）；无 Purpose 为 None。
fn purpose_first_line(text: Option<&str>) -> Option<String> {
    model::purpose_content(text?).map(|c| c.lines().next().unwrap_or("").trim().to_string())
}

/// token 层级的完全包含：两名各自的 kebab 字段中，存在一对相异字段互为子字符串
/// （`auth` ⊂ `authentication`）。被包含侧须达 3 字符——单字符或两字符的退化
/// 候选会与几乎所有既有名成立子字符串关系，只产杂讯。
fn token_containment(a: &[&str], b: &[&str]) -> bool {
    a.iter().any(|x| {
        b.iter().any(|y| {
            x != y && x.len().min(y.len()) >= 3 && (x.contains(*y) || y.contains(*x))
        })
    })
}

/// kebab 名称的字段（去空段——连字号异常时不产生空 token）。
fn tokens(name: &str) -> Vec<&str> {
    name.split('-').filter(|t| !t.is_empty()).collect()
}

/// Levenshtein 编辑距离（字符计），单列 DP。
fn edit_distance(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.iter().enumerate() {
        let mut prev = row[0];
        row[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let cost = if ca == cb { prev } else { prev + 1 };
            prev = row[j + 1];
            row[j + 1] = cost.min(row[j] + 1).min(prev + 1);
        }
    }
    row[b.len()]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn canonical(name: &str) -> KnownName {
        KnownName { name: name.to_string(), source: Source::Canonical, purpose: None }
    }

    fn names(suggestions: &[KnownName]) -> Vec<&str> {
        suggestions.iter().map(|s| s.name.as_str()).collect()
    }

    #[test]
    fn containment_ranks_first() {
        // spec Scenario「包含关系排在最前」：正典有 auth 与 author-tools，
        // 候选 authentication —— auth ⊂ authentication 的包含关系排首位。
        let known = [canonical("author-tools"), canonical("auth")];
        let out = suggest("authentication", &known);
        assert_eq!(names(&out).first(), Some(&"auth"), "包含关系排首位: {out:?}");
    }

    #[test]
    fn token_overlap_beats_edit_distance() {
        // 交集 2 的 alpha-beta-zzzzzzzzzzzzzzzz 编辑距离远大于交集 1 的
        // alpha-qqqq——交集数优先于编辑距离。
        let known = [canonical("alpha-qqqq"), canonical("alpha-beta-zzzzzzzzzzzzzzzz")];
        let out = suggest("alpha-beta-gamma", &known);
        assert_eq!(
            names(&out),
            vec!["alpha-beta-zzzzzzzzzzzzzzzz", "alpha-qqqq"],
            "交集数胜过编辑距离: {out:?}"
        );
    }

    #[test]
    fn edit_distance_orders_equal_overlap() {
        // 同为交集 1 时，编辑距离近者在前。
        let known = [canonical("gate-zzzzzzzzzzzzzzzz"), canonical("gate-flow")];
        let out = suggest("gate-flows-x", &known);
        assert_eq!(
            names(&out),
            vec!["gate-flow", "gate-zzzzzzzzzzzzzzzz"],
            "编辑距离近者在前: {out:?}"
        );
    }

    #[test]
    fn output_is_capped_at_three() {
        // spec：输出 SHALL 至多三笔——第四笔近似名被截掉。
        let known = [
            canonical("token-a"),
            canonical("token-b"),
            canonical("token-c"),
            canonical("token-d"),
        ];
        let out = suggest("token-rotation", &known);
        assert_eq!(out.len(), 3, "上限三笔: {out:?}");
    }

    #[test]
    fn no_overlap_yields_an_empty_list() {
        // spec Scenario「无近似名仍拒绝」的排序半部：毫无交集回空清单。
        let known = [canonical("auth"), canonical("review-station")];
        let out = suggest("zzz-unrelated", &known);
        assert!(out.is_empty(), "毫无交集回空: {out:?}");
    }

    #[test]
    fn source_and_purpose_ride_along() {
        // 来源标注与 Purpose 首行原样进入建议——调用端据此组消息。
        let known = [KnownName {
            name: "user-auth".to_string(),
            source: Source::InFlight("add-sso".to_string()),
            purpose: Some("用户验证。".to_string()),
        }];
        let out = suggest("user-authentication", &known);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].source, Source::InFlight("add-sso".to_string()));
        assert_eq!(out[0].purpose.as_deref(), Some("用户验证。"));
    }

    #[test]
    fn matching_folds_ascii_case() {
        // 大小写不敏感文档系统上 `Auth` 能写进磁盘，但建议不能因大小写而
        // 消失：比对折叠、输出保留原名。
        let known = [canonical("auth")];
        let out = suggest("Auth", &known);
        assert_eq!(names(&out), vec!["auth"], "折叠后互相看得见: {out:?}");
        let reversed = suggest("authentication", &[canonical("AUTH")]);
        assert_eq!(names(&reversed), vec!["AUTH"], "既有名侧同样折叠: {reversed:?}");
    }

    #[test]
    fn degenerate_candidates_produce_no_containment_noise() {
        // 单字符／双字符候选与几乎所有既有名都成立子字符串关系——3 字符
        // 门槛挡下退化杂讯；纯连字号连 token 都切不出来。
        for degenerate in ["a", "ab", "-"] {
            let out = suggest(degenerate, &[canonical("auth"), canonical("archive-merge")]);
            assert!(out.is_empty(), "退化候选 {degenerate:?} 回空: {out:?}");
        }
    }

    #[test]
    fn containment_is_token_level_not_whole_name() {
        // token 层级：candidate 的某字段与既有名的某字段互为子字符串才算，
        // 相等字段属交集不属包含。user-auth vs user-authentication：
        // auth ⊂ authentication 成立包含，排在仅共 user 一段的 user-flow 前。
        let known = [canonical("user-flow"), canonical("user-authentication")];
        let out = suggest("user-auth", &known);
        assert_eq!(
            names(&out),
            vec!["user-authentication", "user-flow"],
            "token 包含优先于单纯交集: {out:?}"
        );
    }

    #[test]
    fn suggestion_line_formats_source_and_purpose() {
        let with_purpose = KnownName {
            name: "auth".into(),
            source: Source::Canonical,
            purpose: Some("Auth session lifecycle.".into()),
        };
        assert_eq!(suggestion_line(&with_purpose), "auth (canonical): Auth session lifecycle.");
        let bare = KnownName {
            name: "user-auth".into(),
            source: Source::InFlight("add-sso".into()),
            purpose: None,
        };
        assert_eq!(suggestion_line(&bare), "user-auth (in-flight: add-sso)");
    }
}
