//! specseal-core: spec-driven development engine.

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

// 三个文件夹模块本身是私有的：分组只是给读者看的，不是公开 API。底下的模块一律
// 由本档的 `pub use` 挂回 crate 根，`specseal_core::<模块>` 的既有路径一字不改。
mod lifecycle;
mod quality;
// `workspace/` 文件夹里有一个同名的 `workspace.rs` 子模块，文件夹模块不能也叫
// `workspace`（同一层两个同名模块是 E0255），所以给它一个私有别名。
#[path = "workspace/mod.rs"]
mod workspace_group;

pub mod command;
pub mod demo;
pub mod keylines;
pub mod store;
/// Test-support helpers for this workspace's test suites — compiled only for
/// this crate's own tests or when a sibling crate's dev-dependency opts in via
/// the `testkit` feature; never part of a production build.
#[cfg(any(test, feature = "testkit"))]
#[doc(hidden)]
pub mod testkit;
#[cfg(test)]
pub(crate) mod teststore;
pub mod util;

pub use lifecycle::{
    archive, capname, cost, discard, discuss, fields, inprogress, listing, model, newcmd, plan, preflight,
    rank, status, tasks, trace,
};
pub use quality::{analyzer, drift, station, validate};
pub use workspace_group::{config, init, instructions, migrate, schema, skills, workspace};
