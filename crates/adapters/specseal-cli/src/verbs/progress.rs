//! Work-progress verbs: task done/undone and the in-progress marker.
//!
//! Both are Dual and share the flip output (specseal-verbs' `render::progress`),
//! so the success line and the `--json` shape are written once and reused by
//! the remote arm.

use anyhow::{bail, Result};
use specseal_core as core;

use crate::common::{emit, engine_command, git_branch, open_project, plain_command, render_options, run};
use crate::remote_base::{remote_resolve_change, RemoteCtx};
use specseal_verbs::families::progress::{
    InProgressArgs, InProgressCommands, TaskArgs, TaskCommands,
};
use specseal_verbs::render::progress::{self as render, FlippedTask, TaskFlip};
use specseal_verbs::{ToCommand, VerbInputs};

pub(crate) fn cmd_task(a: TaskArgs) -> Result<()> {
    let (flip, json) = match a.command {
        TaskCommands::Done { json, .. } => (TaskFlip::Done, json),
        TaskCommands::Undone { json, .. } => (TaskFlip::Undone, json),
    };
    let (ws, store) = open_project()?;
    // fs mode gives no touched files: the engine probes this workspace itself.
    let cmd = plain_command(&a)?;
    let o: core::command::TaskFlipOutcome = run(&store, Some(&ws), cmd)?;
    // `already` 维持现行错误结束（引擎已保证零文件效果）：共用函数回传那一句错误。
    emit(render::task_flipped(flip, &o, render_options(json))?);
    Ok(())
}
/// remote 的任务翻转：remote 只有 argv 一种识别，拒绝消息与 stdout 都用它。
/// `already` 维持现行错误结束；其余印出共用的输出。
fn emit_remote_task_flip(
    flip: TaskFlip,
    change: &str,
    task: RemoteTask<'_>,
    already: bool,
    json: bool,
) -> Result<()> {
    if already {
        bail!("{}", render::already_message(flip, task.id));
    }
    emit(render::task_flip(
        flip,
        &FlippedTask { change, task_id: task.id, description: task.description },
        render_options(json),
    ));
    Ok(())
}
/// remote 回应里的一个任务：argv 给的识别与 server 回的描述，具名绑在一起——
/// 两个相邻同型 `&str` 写反不会被编译器挡，具名字段会。
struct RemoteTask<'a> {
    id: &'a str,
    description: &'a str,
}
pub(crate) fn cmd_in_progress(a: InProgressArgs) -> Result<()> {
    let (ws, store) = open_project()?;
    match a.command {
        InProgressCommands::Add { .. } => {
            // The branch this checkout is on goes with the marker; the engine reads no git.
            let inputs = VerbInputs { branch: git_branch(&ws.root), ..Default::default() };
            let cmd = engine_command(a.to_command(inputs))?;
            let _: core::command::InProgressOutcome = run(&store, Some(&ws), cmd)?;
        }
        InProgressCommands::Remove { .. } => {
            let cmd = plain_command(&a)?;
            let o: core::command::InProgressRemoveOutcome = run(&store, Some(&ws), cmd)?;
            emit(render::in_progress_remove(&o.name, o.removed, render_options(false)));
        }
    }
    Ok(())
}
fn remote_task_done(
    ctx: &RemoteCtx,
    task_id: &str,
    change: Option<&str>,
    json: bool,
) -> Result<()> {
    let Some(change) = remote_resolve_change(ctx, change, "Use --change to specify one:")? else {
        return Ok(());
    };
    // Attribution: same git-derived touched-file set the fs path records,
    // plus the HEAD they were observed on (the entry's headCommit — spec
    // verify-evidence). An empty set / absent commit is what git yielding
    // nothing looks like.
    let touched = core::tasks::git_changed_files(&ctx.ws);
    let head = core::tasks::head_commit(&ctx.ws.root);
    let resp = ctx.client.task_done(&change, task_id, &touched, head.as_deref())?;
    emit_remote_task_flip(
        TaskFlip::Done,
        &change,
        RemoteTask { id: task_id, description: &resp.task_desc },
        resp.already_done,
        json,
    )
}
fn remote_task_undone(
    ctx: &RemoteCtx,
    task_id: &str,
    change: Option<&str>,
    json: bool,
) -> Result<()> {
    let Some(change) = remote_resolve_change(ctx, change, "Use --change to specify one:")? else {
        return Ok(());
    };
    let resp = ctx.client.task_undone(&change, task_id)?;
    emit_remote_task_flip(
        TaskFlip::Undone,
        &change,
        RemoteTask { id: task_id, description: &resp.task_desc },
        resp.already_undone,
        json,
    )
}
/// task 的 remote 家族臂：子指令 enum 穷尽 match、无 catch-all。
pub(crate) fn remote_task(ctx: &RemoteCtx, a: TaskArgs) -> Result<()> {
    match a.command {
        TaskCommands::Done { task_id, change, json } => {
            remote_task_done(ctx, &task_id, change.as_deref(), json)
        }
        TaskCommands::Undone { task_id, change, json } => {
            remote_task_undone(ctx, &task_id, change.as_deref(), json)
        }
    }
}
/// in-progress 的 remote 家族臂：子指令 enum 穷尽 match、无 catch-all。
pub(crate) fn remote_in_progress(ctx: &RemoteCtx, a: InProgressArgs) -> Result<()> {
    match a.command {
        InProgressCommands::Add { name } => {
            // 路由至 server（started_by 由 server 认证身分盖章）；静默 exit 0
            // 的 parity 冻结形状两模式一致。
            ctx.client.in_progress_add(&name, git_branch(&ctx.ws.root).as_deref())?;
            Ok(())
        }
        InProgressCommands::Remove { name } => remote_in_progress_remove(ctx, &name),
    }
}
fn remote_in_progress_remove(ctx: &RemoteCtx, name: &str) -> Result<()> {
    // 回应的 removed 区分实际移除与未开工幂等,两者印不同的行(旧 server 的
    // 裸 Ack 读作已移除,即其原本的意思);守门 409 与 404 的 message 为引擎
    // 冻结文本,经 `?` 转发后 stderr 与 fs 模式逐比特一致。
    let removed = ctx.client.in_progress_remove(name)?.removed;
    emit(render::in_progress_remove(name, removed, render_options(false)));
    Ok(())
}
