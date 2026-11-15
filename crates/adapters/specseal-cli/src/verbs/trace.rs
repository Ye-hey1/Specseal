//! `trace` — 单一 capability 的溯源链（封存演进、来源讨论、evidence、
//! Requirement 归属）。组装在 core（`specseal_core::trace`），输出在
//! specseal-verbs（`render::trace`），这里只把两者接起来。Dual：本机臂对本机 store
//! 运行引擎命令；remote 臂向 server 取同一份报告、转回引擎类型，再交给同一个输出
//! 函数。

use crate::common::{emit, open_project, plain_command, render_options, run};
use crate::remote_base::RemoteCtx;
use anyhow::Result;
use core::trace::TraceReport;
use specseal_core as core;
use specseal_verbs::families::trace::TraceArgs;
use specseal_verbs::render::trace as render;

pub(crate) fn cmd_trace(a: TraceArgs) -> Result<()> {
    let (_ws, store) = open_project()?;
    let report: TraceReport =
        run(&store, None, plain_command(&a)?)?;
    emit(render::trace(&report, render_options(a.json)));
    Ok(())
}

/// Remote arm: the server assembles the chain with the same engine code; an
/// unknown capability arrives as a 404 carrying the engine's line and its
/// near names, which `?` prints exactly as fs mode does.
pub(crate) fn remote_trace(ctx: &RemoteCtx, a: &TraceArgs) -> Result<()> {
    let report = specseal_remote::convert::trace_report(ctx.client.trace(&a.capability)?);
    emit(render::trace(&report, render_options(a.json)));
    Ok(())
}
