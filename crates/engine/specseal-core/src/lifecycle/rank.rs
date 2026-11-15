//! 看板卡片排序键演算（design D1）：字符串型 fractional key，不用浮点。
//!
//! 键为小写英文本母字符串，视为 base-26 分数（'a'=0 … 'z'=25），字典序＝数值序
//! （生成键永不以 'a' 结尾，避免同值异字符串）。中点取前后邻居的字典序中位，
//! 无缝隙时延长键长——以延长取代重平衡，重平衡机制整个不需要。
//!
//! 桌面拖排（本地与 remote）与 CLI 的 `change rank` 共用这一份演算，两端写出的
//! 键同形。

const BASE: u32 = 26;

/// 第 `i` 位数值：下界键超出长度视为 0（分数尾端补零）。
fn digit(s: &str, i: usize) -> u32 {
    s.as_bytes().get(i).map_or(0, |b| u32::from(b - b'a'))
}

/// 上界键第 `i` 位数值：`None`（栏底＝无上界）视为每一位皆 BASE。
fn upper_digit(s: Option<&str>, i: usize) -> u32 {
    match s {
        None => BASE,
        Some(s) => digit(s, i),
    }
}

/// 两邻居之间的中点键：严格介于 `prev` 与 `next` 之间（字典序）。
/// `prev`＝None 表栏顶（下界为零）、`next`＝None 表栏底（无上界）；两者皆 None
/// 产生首键。调用端保证 prev < next；键缝隙不足时延长键长，不改写任何邻居。
pub fn midpoint(prev: Option<&str>, next: Option<&str>) -> String {
    let a = prev.unwrap_or("");
    let mut out = String::new();
    let mut i = 0;
    // 沿共同前缀走到第一个分歧位；分歧位有缝隙即取中位收束。
    loop {
        let da = digit(a, i);
        let db = upper_digit(next, i);
        if da == db {
            out.push((b'a' + da as u8) as char);
            i += 1;
            continue;
        }
        let mid = (da + db) / 2;
        if mid > da {
            out.push((b'a' + mid as u8) as char);
            return out;
        }
        // db == da + 1：本位取 da（已严格小于上界），其后不再受上界约束，
        // 只需产生严格大于下界余位的尾段。
        out.push((b'a' + da as u8) as char);
        i += 1;
        loop {
            let da = digit(a, i);
            let mid = (da + BASE) / 2;
            if mid > da {
                out.push((b'a' + mid as u8) as char);
                return out;
            }
            // da == 'z'：无法在本位放大，照抄后续位。
            out.push((b'a' + da as u8) as char);
            i += 1;
        }
    }
}

/// 批量派发 `n` 个严格递增、两两留有可再分缝隙的键（整栏补章用，design D3）。
/// 键在 base-26^width 值域内等距取点（width 取到值域 ≥ 2(n+1)，保证步距 ≥ 2）；
/// 值恰为 26 的倍数时尾位会成零位 'a'，加一避开（步距 ≥ 2 保证仍严格递增）。
pub fn spread(n: usize) -> Vec<String> {
    if n == 0 {
        return Vec::new();
    }
    let mut width = 1u32;
    let mut total: u64 = u64::from(BASE);
    while total < 2 * (n as u64 + 1) {
        width += 1;
        total *= u64::from(BASE);
    }
    let step = total / (n as u64 + 1);
    (1..=n as u64)
        .map(|i| {
            let mut v = i * step;
            if v % u64::from(BASE) == 0 {
                v += 1;
            }
            // 以固定 width 位数渲染（高位在前）。
            let mut digits = vec![b'a'; width as usize];
            let mut rest = v;
            for d in digits.iter_mut().rev() {
                *d = b'a' + (rest % u64::from(BASE)) as u8;
                rest /= u64::from(BASE);
            }
            String::from_utf8(digits).expect("base-26 digits are ASCII")
        })
        .collect()
}

/// 以邻居现值推导新键：不在现存集合的邻居（已封存／删除的 race）视为开放端；
/// 现值逆序（stale 落点）时弃上界保底——宁可落位偏移，不产生非法键。
/// 本地拖排（manage）与 remote 拖排共用此单一来源，两模式落点语意同构。
pub fn neighbor_midpoint(
    ranks: &std::collections::HashMap<&str, String>,
    prev_id: Option<&str>,
    next_id: Option<&str>,
) -> String {
    let prev = prev_id.and_then(|p| ranks.get(p)).cloned();
    let next = next_id.and_then(|n| ranks.get(n)).cloned();
    let next = match (&prev, &next) {
        (Some(a), Some(b)) if a >= b => None,
        _ => next,
    };
    midpoint(prev.as_deref(), next.as_deref())
}

/// 栏内现有 rank 能否沿用（design D2；add-change-plan-remote D6）：全员具 rank 且依显示序
/// 严格递增。否则调用端依显示序整栏重派——缺 rank 的卡没有邻居键，反序或同值的两邻居之间
/// 也没有中点键。本地拖排（manage）与 remote 拖排共用此判定。
pub fn ranked_in_order(ranks: &[Option<&str>]) -> bool {
    ranks.iter().all(Option::is_some) && ranks.windows(2).all(|pair| pair[0] < pair[1])
}

/// 键合不合本演算的生成格式：合法的 board_rank，且不以零位 'a' 结尾。手改或外来的键
/// 不合格式时算不出中点；本机的写入步骤（plan 模块的 move_rank）把它当成缺 rank。
pub(crate) fn generated_shape(key: &str) -> bool {
    crate::util::is_valid_board_rank(key) && !key.ends_with('a')
}

#[cfg(test)]
mod tests {
    use super::{generated_shape, midpoint, ranked_in_order, spread};

    /// 生成键的合法形状：非空、仅小写字母、不以 'a'（零位）结尾。
    fn assert_valid_key(k: &str) {
        assert!(!k.is_empty(), "key must be non-empty");
        assert!(
            k.bytes().all(|b| b.is_ascii_lowercase()),
            "key must be lowercase ASCII letters only: {k:?}"
        );
        assert!(!k.ends_with('a'), "key must not end with the zero digit 'a': {k:?}");
    }

    #[test]
    fn midpoint_is_strictly_between_gapped_neighbors() {
        // spec Example「中点与延长」第 1 列：有缝隙取中点。
        let m = midpoint(Some("b"), Some("f"));
        assert_valid_key(&m);
        assert!("b" < m.as_str() && m.as_str() < "f", "b < {m} < f violated");
    }

    #[test]
    fn midpoint_extends_length_when_neighbors_are_adjacent() {
        // spec Example「中点与延长」第 2 列：ab 与 ac 无缝隙——以 ab 为前缀延长。
        let m = midpoint(Some("ab"), Some("ac"));
        assert_valid_key(&m);
        assert!("ab" < m.as_str() && m.as_str() < "ac", "ab < {m} < ac violated");
        assert!(m.starts_with("ab"), "adjacent keys must extend the lower key: {m}");

        let m2 = midpoint(Some("b"), Some("c"));
        assert_valid_key(&m2);
        assert!("b" < m2.as_str() && m2.as_str() < "c");
    }

    #[test]
    fn midpoint_handles_open_ends() {
        // spec Example 第 3、4 列：栏顶／栏底单侧推导。
        let top = midpoint(None, Some("b"));
        assert_valid_key(&top);
        assert!(top.as_str() < "b", "top insert must be strictly less than b: {top}");

        let bottom = midpoint(Some("n"), None);
        assert_valid_key(&bottom);
        assert!(bottom.as_str() > "n", "bottom insert must be strictly greater than n: {bottom}");

        // 首键（空栏第一次写入）。
        assert_valid_key(&midpoint(None, None));
    }

    #[test]
    fn midpoint_property_holds_across_generated_pairs() {
        // 性质测试：对 spread 生成集的任两相邻与跨距键，中点严格介于其间。
        let keys = spread(12);
        for i in 0..keys.len() {
            for j in (i + 1)..keys.len() {
                let (a, b) = (&keys[i], &keys[j]);
                let m = midpoint(Some(a), Some(b));
                assert_valid_key(&m);
                assert!(
                    a.as_str() < m.as_str() && m.as_str() < b.as_str(),
                    "{a} < {m} < {b} violated"
                );
            }
        }
    }

    #[test]
    fn repeated_top_insert_keeps_producing_smaller_valid_keys() {
        // 病态连续插入同一缝隙（栏顶）：每次仍严格更小、键形合法——延长取代重平衡。
        let mut first = midpoint(None, None);
        for _ in 0..60 {
            let smaller = midpoint(None, Some(&first));
            assert_valid_key(&smaller);
            assert!(smaller < first, "{smaller} must sort before {first}");
            first = smaller;
        }
    }

    #[test]
    fn spread_returns_strictly_increasing_subdividable_keys() {
        // 批量派发（整栏补章）：严格递增、键形合法、两两可再取中点插入。
        for n in [1usize, 2, 3, 10, 30, 200] {
            let keys = spread(n);
            assert_eq!(keys.len(), n, "spread({n}) must return {n} keys");
            for k in &keys {
                assert_valid_key(k);
            }
            for w in keys.windows(2) {
                assert!(w[0] < w[1], "spread keys must be strictly increasing: {w:?}");
                let m = midpoint(Some(&w[0]), Some(&w[1]));
                assert!(
                    w[0] < m && m < w[1],
                    "every adjacent pair must stay subdividable: {} < {m} < {}",
                    w[0],
                    w[1]
                );
            }
        }
        assert!(spread(0).is_empty());
    }

    #[test]
    fn ranked_in_order_needs_every_rank_present_and_strictly_increasing() {
        // 整栏重派的判定（本机与 remote 拖排共用）：全员具 rank 且依显示序严格递增才沿用。
        assert!(ranked_in_order(&[]));
        assert!(ranked_in_order(&[Some("f"), Some("n"), Some("t")]));
        assert!(!ranked_in_order(&[Some("f"), None, Some("t")]), "缺 rank 的卡没有邻居键");
        assert!(!ranked_in_order(&[Some("n"), Some("f")]), "反序的两邻居之间没有中点键");
        assert!(!ranked_in_order(&[Some("f"), Some("f")]), "同值的两邻居之间也没有");
    }

    #[test]
    fn generated_shape_accepts_only_keys_the_midpoint_can_use() {
        // 手改或外来的键不合生成格式：大写字母算中点会溢出，以 'a' 结尾的键当上界
        // 时中点永远延长不完，空字符串不是键。本机写入把它们当成缺 rank；remote 拖排
        // 共用的 ranked_in_order 只看有无与顺序，不看格式（remote-board-order 的规则）。
        for bad in ["N", "a", "na", ""] {
            assert!(!generated_shape(bad), "{bad:?}");
        }
        for good in ["n", "ab", "zz"] {
            assert!(generated_shape(good), "{good:?}");
        }
        assert!(ranked_in_order(&[Some("N"), Some("n")]));
    }
}
