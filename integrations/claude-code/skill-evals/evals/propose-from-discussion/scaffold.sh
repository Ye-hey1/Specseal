#!/usr/bin/env bash
# 已结论的讨论 search-bar，Decision 含一项需要人工验收的步骤。
source "$(dirname "$0")/../fixtures.sh"
eval_init
mkdir -p src
cat >src/board.js <<'JS'
// 看板：依字段分组显卡片。
function renderBoard(columns) {
  return columns.map((column) => `${column.title}: ${column.cards.map((card) => card.title).join(', ')}`).join('\n');
}

module.exports = { renderBoard };
JS
specseal discuss new "看板搜索列" --slug search-bar >/dev/null
specseal discuss context search-bar --stdin >/dev/null <<'CTX'
用户要在看板上方加一个搜索列，依关键字即时过滤卡片。没有需要 grill 的前提；相关代码只有 src/board.js 的 renderBoard。
Prior discussions: none
CTX
specseal discuss add-round search-bar --mode assumptions --stdin >/dev/null <<'ROUND'
**Focus**: 搜索的范围与过滤方式
**Position**: 只比对卡片标题，不分大小写，输入时即时过滤。
- 过滤在 renderBoard 之前完成，字段结构不变，没有命中的字段显示为空
- 搜索列清空时显示全部卡片
**Ruled out**: 后端搜索 API——看板数据已全部在前端
ROUND
specseal discuss conclude search-bar --stdin >/dev/null <<'CONCLUSION'
**Decision**: 看板上方加一个只比对卡片标题的搜索列。
- 不分大小写，输入时即时过滤；过滤在 renderBoard 之前完成，字段结构不变
- 搜索列清空时显示全部卡片
- 上线前由用户在浏览器手动输入关键字，确认卡片即时过滤、清空后恢复全部卡片
**Rationale**: 看板数据已全部在前端，前端过滤最简单，也不需要新的 API。
**Rejected alternatives**:
- 后端搜索 API——数据已在前端，多一次往返没有好处
**Deferred**: none
**Capture to**: proposal
**Next**: /specseal-propose --from-discussion search-bar
CONCLUSION
