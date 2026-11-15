//! Tray recovery action 的封闭 IPC／focus policy。
//!
//! 前端 Zustand store 仍是 snapshot 与动作的单一真相；本模块只钉住跨 surface
//! 的 action 名称与「哪些显式动作可以聚焦主窗口」，避免未知 payload 误降阶。

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TrayRecoveryAction {
    Retry,
    OpenRecovery,
    OpenSettings,
    Reauthenticate,
}

impl TrayRecoveryAction {
    /// 直接 retry 必须留在 Tray；只有用户明确要求详情／设置／登录才聚焦主窗口。
    pub const fn focuses_main_window(self) -> bool {
        !matches!(self, Self::Retry)
    }
}
