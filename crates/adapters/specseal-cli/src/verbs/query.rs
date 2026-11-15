//! Read verbs: list, show, status.
//!
//! Each verb's output comes from one shared function (specseal-verbs'
//! `render::query`) that takes the core outcome type; the remote arm converts
//! the wire payload first, so both modes print the same bytes.

use anyhow::{bail, Result};
use specseal_core as core;
use specseal_protocol::query as protocol_query;

use crate::common::{
    emit, engine_command, info_if_no_changes, open_project, plain_command, render_options, run,
    worktree_overlay,
};
use crate::remote_base::{remote_resolve_change, RemoteCtx};
use core::listing::ListChangeJson;
use specseal_verbs::families::query::{ListArgs, ShowArgs, StatusArgs};
use specseal_verbs::render::query as render;
use specseal_verbs::{ToCommand, VerbInputs};

pub(crate) fn cmd_list(a: ListArgs) -> Result<()> {
    let (ws, fs_store) = open_project()?;
    // Worktree overlay (D3): only a local MAIN checkout with the policy on gets
    // here — everywhere else `facts` is empty, git is never spawned, and both
    // the store and the payload are exactly what they were before this feature.
    let (facts, overlaid) = worktree_overlay(&ws, &fs_store);
    let cmd = engine_command(a.to_command(VerbInputs {
        worktrees: specseal_host::worktree::payload_objects(&facts),
        ..Default::default()
    }))?;
    let list: core::command::ListOutcome =
        run(if facts.is_empty() { &fs_store } else { &overlaid }, Some(&ws), cmd)?;
    emit(render::list(&list, render_options(a.json)));
    Ok(())
}
/// The remote list's engine-shaped outcome, assembled from typed wire pieces.
/// The assembly lives on this side of the include because the remote intercept
/// layer speaks protocol DTOs only (tests/it/no_raw_wire_json.rs), while the
/// engine's `ListOutcome` carries its specs section as an opaque payload.
fn remote_list_outcome(
    changes: Option<Vec<ListChangeJson>>,
    specs: Option<Vec<protocol_query::SpecSummary>>,
) -> Result<core::command::ListOutcome> {
    let specs = specs.map(serde_json::to_value).transpose()?;
    Ok(core::command::ListOutcome { changes, specs })
}
pub(crate) fn cmd_show(a: ShowArgs) -> Result<()> {
    let (ws, store) = open_project()?;
    let cmd = plain_command(&a)?;
    let show: core::command::ShowOutcome = run(&store, Some(&ws), cmd)?;
    emit(render::show(&show, render_options(a.json)));
    Ok(())
}
pub(crate) fn cmd_status(a: StatusArgs) -> Result<()> {
    let (ws, store) = open_project()?;
    if info_if_no_changes(&store, a.change.as_deref()) {
        return Ok(());
    }
    let cmd = plain_command(&a)?;
    let report: core::status::StatusReport = run(&store, Some(&ws), cmd)?;
    emit(render::status(&report, render_options(a.json)));
    Ok(())
}
/// The wire summary reshaped into the core listing item — the same rendering
/// path then keeps stdout byte-identical to fs mode.
fn to_list_change_json(c: &protocol_query::ChangeSummary) -> ListChangeJson {
    ListChangeJson {
        completed_tasks: c.completed_tasks,
        name: c.name.clone(),
        status: c.status.clone(),
        summary: c.summary.clone(),
        total_tasks: c.total_tasks,
        restale_from: c.restale_from.clone(),
        meta_error: c.meta_error.clone(),
        delta_capabilities: c.delta_capabilities.clone(),
        // 两个时间字段照 server 给的带回：server 没给（保存答不出）就缺席。
        created: c.created.clone(),
        modified_at: c.modified_at.clone(),
        fields: c.fields.clone(),
        // remote 恒缺席：worktree 是本机主 checkout 的观察面，
        // server 端没有这回事（spec scenario remote list 恒无 worktree 字段）。
        worktree: None,
    }
}
pub(crate) fn remote_list(ctx: &RemoteCtx, a: &ListArgs) -> Result<()> {
    // 组出 fs 模式同一个 ListOutcome 再交给共用渲染：`--specs` 单独给定时
    // changes 为 None，与引擎的 List outcome 同构。
    let specs_only = a.specs && !a.changes;
    let changes = if specs_only {
        None
    } else {
        let mut items: Vec<ListChangeJson> =
            ctx.client.list_changes()?.changes.iter().map(to_list_change_json).collect();
        // `--sort name` 在本地重排对齐 fs；`created`／`modified` 的排序键
        // （meta created、store mtime）不在 wire 上，维持 server 回传序。
        if a.sort == "name" {
            items.sort_by(|x, y| x.name.cmp(&y.name));
        }
        Some(items)
    };
    let specs = if a.specs { Some(ctx.client.list_specs()?.specs) } else { None };
    emit(render::list(&remote_list_outcome(changes, specs)?, render_options(a.json)));
    Ok(())
}
/// The wire status reshaped into the fs report type — the same rendering
/// path keeps stdout byte-identical to fs mode; server extras (repo,
/// lifecycle, versions) simply don't cross this boundary.
fn to_status_report(status: protocol_query::ChangeStatus) -> core::status::StatusReport {
    core::status::StatusReport {
        change_name: status.change_name,
        schema_name: status.schema_name,
        is_complete: status.is_complete,
        apply_requires: status.apply_requires,
        artifacts: status
            .artifacts
            .into_iter()
            .map(|a| core::status::ArtifactStatusJson {
                id: a.id,
                output_path: a.output_path,
                status: a.status,
                blocked_by: a.missing_deps,
            })
            .collect(),
    }
}
pub(crate) fn remote_status(ctx: &RemoteCtx, a: &StatusArgs) -> Result<()> {
    if a.schema.is_some() {
        bail!("--schema is not supported in remote mode — the server's workflow config decides the schema");
    }
    let Some(name) =
        remote_resolve_change(ctx, a.change.as_deref(), "Use --change to specify one:")?
    else {
        return Ok(());
    };
    let report = to_status_report(ctx.client.get_change(&name)?);
    emit(render::status(&report, render_options(a.json)));
    Ok(())
}
/// remote show 的读取组合（design D4）：以既有读 API 组出与 fs 模式相同的
/// ShowOutcome，交给共用的输出函数。item 与 --item-type 的判别序
/// 对齐引擎 run_show：type==spec 直取规格；否则 change 优先、缺席时规格
/// 递补（type==change 不递补）；错误消息沿引擎冻结文本。
fn remote_show_outcome(
    ctx: &RemoteCtx,
    item: Option<&str>,
    item_type: Option<&str>,
) -> Result<core::command::ShowOutcome> {
    let Some(item) = item else {
        bail!("Please specify an item name.");
    };
    if let Some(t) = item_type {
        if t != "change" && t != "spec" {
            bail!("Unknown type: {t}. Use 'change' or 'spec'.");
        }
    }
    let is_spec = ctx.client.list_specs()?.specs.iter().any(|s| s.id == item);
    let status = if item_type == Some("spec") {
        None
    } else {
        match ctx.client.get_change(item) {
            Ok(status) => Some(status),
            Err(e) if e.status == Some(404) => None,
            Err(e) => return Err(e.into()),
        }
    };
    let show_spec =
        item_type == Some("spec") || (item_type != Some("change") && status.is_none() && is_spec);
    if show_spec {
        if !is_spec {
            bail!("Spec '{item}' not found.");
        }
        let content = ctx.client.spec_document(item)?.content;
        return Ok(core::command::ShowOutcome::Spec { name: item.to_string(), content });
    }
    let Some(status) = status else {
        if item_type == Some("change") {
            bail!("Change '{item}' not found.");
        }
        bail!("Item '{item}' not found as a change or spec.");
    };
    // 成对规则由 server 套用：created 出现即代表 meta 的 schema+created 成对。
    let (schema, created) = match status.created {
        Some(created) => (Some(status.schema_name.clone()), Some(created)),
        None => (None, None),
    };
    let read_artifact = |artifact: &str| -> Result<Option<String>> {
        match ctx.client.get_artifact(item, artifact) {
            Ok(content) => Ok(Some(content.content)),
            Err(e) if e.status == Some(404) => Ok(None),
            Err(e) => Err(e.into()),
        }
    };
    // restaleFrom 走清单摘要（设计上 show 组合的「两份清单」之一）。
    let restale_from = ctx
        .client
        .list_changes()?
        .changes
        .into_iter()
        .find(|c| c.name == item)
        .map(|c| c.restale_from)
        .unwrap_or_default();
    Ok(core::command::ShowOutcome::Change(core::command::ShowChange {
        name: status.change_name,
        schema,
        created,
        proposal: read_artifact("proposal")?,
        design: read_artifact("design")?,
        tasks: read_artifact("tasks")?,
        delta_capabilities: status.delta_capabilities,
        from_discussions: status.from_discussions,
        restale_from,
        // A server that does not report these sends none of them: the keys
        // then stay out of `--json`, as for a change without the records.
        review: status.review.as_ref().and_then(specseal_remote::convert::station_status),
        verify: status.verify.as_ref().and_then(specseal_remote::convert::station_status),
        branch: status.branch,
        landed: core::command::LandedRecord::new(status.landed_commit, status.landed_at, status.landed_by),
        fields: status.fields,
    }))
}

/// show 的 remote 家族臂：wire → ShowOutcome → 与 fs 同一支输出函数。臂在族内
/// 具名，`remote_show_outcome` 因此不必离开本档。
pub(crate) fn remote_show(ctx: &RemoteCtx, a: ShowArgs) -> Result<()> {
    let show = remote_show_outcome(ctx, a.item.as_deref(), a.item_type.as_deref())?;
    emit(render::show(&show, render_options(a.json)));
    Ok(())
}
