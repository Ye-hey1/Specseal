//! Tray 复原 action 的原生 fallback 边界：直接 retry 不取得主窗口焦点；
//! 显式详情、设置与重新登录才允许唤起主窗口。未知 action 必须 fail-closed。

use specseal_desktop_lib::tray::TrayRecoveryAction;

#[test]
fn recovery_action_focus_policy_is_explicit_and_fail_closed() {
    assert!(!TrayRecoveryAction::Retry.focuses_main_window());
    assert!(TrayRecoveryAction::OpenRecovery.focuses_main_window());
    assert!(TrayRecoveryAction::OpenSettings.focuses_main_window());
    assert!(TrayRecoveryAction::Reauthenticate.focuses_main_window());

    let unknown = serde_json::from_str::<TrayRecoveryAction>(r#""future-action""#);
    assert!(unknown.is_err(), "未知 tray action 不得降阶成会运行的既有动作");
}

#[test]
fn recovery_action_serialization_uses_closed_kebab_case_names() {
    assert_eq!(
        serde_json::to_string(&TrayRecoveryAction::Retry).unwrap(),
        r#""retry""#,
    );
    assert_eq!(
        serde_json::to_string(&TrayRecoveryAction::OpenRecovery).unwrap(),
        r#""open-recovery""#,
    );
    assert_eq!(
        serde_json::to_string(&TrayRecoveryAction::OpenSettings).unwrap(),
        r#""open-settings""#,
    );
    assert_eq!(
        serde_json::to_string(&TrayRecoveryAction::Reauthenticate).unwrap(),
        r#""reauthenticate""#,
    );
}
