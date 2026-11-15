//! 触摸板手势阶段的判读与送给前端的事件格式（desktop-swipe-back-finger-lift design D2）。
//! macOS 的 Tauri 壳以 NSEvent 本地监听读卷动事件的 phase／momentumPhase 比特，交给
//! [`classify_scroll_phase`] 判读后广播 [`TrackpadGestureEvent`]；壳端只做 AppKit 黏合。

use serde::Serialize;

/// 壳广播、前端 SwipeBack 订阅的 Tauri 事件名。
pub const TRACKPAD_GESTURE_EVENT: &str = "trackpad-gesture";

// NSEventPhase 的比特值（AppKit 定义；壳端以 `.bits()` 原样传入）。
const PHASE_BEGAN: u64 = 0x1;
const PHASE_ENDED: u64 = 0x8;
const PHASE_CANCELLED: u64 = 0x10;
const PHASE_MAY_BEGIN: u64 = 0x20;

/// 手指按下（began）或离开触摸板（ended）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TrackpadGesturePhase {
    Began,
    Ended,
}

/// `trackpad-gesture` 事件的 payload：`{"phase":"began"|"ended","swipeEnabled":bool}`。
/// swipe_enabled 为系统设置「在页面之间滑动」是否允许两指滑动，只在 began 有意义。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackpadGestureEvent {
    pub phase: TrackpadGesturePhase,
    pub swipe_enabled: bool,
}

/// 依卷动事件的 phase／momentumPhase 比特判读手指按下或离开。惯性事件（momentum 非 0）
/// 不是手指动作；MayBegin／Began 为按下、Ended／Cancelled 为离开；手指移动中（Changed）
/// 与一般鼠标滚轮（两者皆 0）回 None。
pub fn classify_scroll_phase(phase_bits: u64, momentum_bits: u64) -> Option<TrackpadGesturePhase> {
    if momentum_bits != 0 {
        None
    } else if phase_bits & (PHASE_MAY_BEGIN | PHASE_BEGAN) != 0 {
        Some(TrackpadGesturePhase::Began)
    } else if phase_bits & (PHASE_ENDED | PHASE_CANCELLED) != 0 {
        Some(TrackpadGesturePhase::Ended)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 判读不认的 NSEventPhase 比特（AppKit 定义）；认的沿用上方 PHASE_*。
    const NONE: u64 = 0;
    const CHANGED: u64 = 0x4;

    #[test]
    fn finger_down_phases_classify_as_began() {
        // MayBegin（手指触碰、尚未移动）也算按下：轻触不移动（MayBegin→Cancelled）因此是
        // began→ended，前端在 ended 遗失、卡在追踪中时也会先归零，不把轻触当成结算。
        assert_eq!(classify_scroll_phase(PHASE_MAY_BEGIN, NONE), Some(TrackpadGesturePhase::Began));
        assert_eq!(classify_scroll_phase(PHASE_BEGAN, NONE), Some(TrackpadGesturePhase::Began));
    }

    #[test]
    fn finger_up_phases_classify_as_ended() {
        assert_eq!(classify_scroll_phase(PHASE_ENDED, NONE), Some(TrackpadGesturePhase::Ended));
        assert_eq!(classify_scroll_phase(PHASE_CANCELLED, NONE), Some(TrackpadGesturePhase::Ended));
    }

    #[test]
    fn moves_momentum_and_plain_wheel_classify_as_none() {
        assert_eq!(classify_scroll_phase(CHANGED, NONE), None, "手指移动中");
        assert_eq!(classify_scroll_phase(NONE, CHANGED), None, "惯性卷动");
        assert_eq!(classify_scroll_phase(NONE, NONE), None, "一般鼠标滚轮");
    }

    #[test]
    fn unknown_and_stationary_bits_classify_as_none() {
        // 不认得的比特一律不送事件：宁可失去一次滑动，也不误开始或误结算。
        const STATIONARY: u64 = 0x2;
        assert_eq!(classify_scroll_phase(STATIONARY, NONE), None);
        assert_eq!(classify_scroll_phase(0x40, NONE), None);
    }

    #[test]
    fn momentum_wins_over_finger_bits() {
        // 惯性事件不得开始或结束一次滑动，即使 phase 比特同时带了按下／离开。
        assert_eq!(classify_scroll_phase(PHASE_BEGAN, PHASE_BEGAN), None);
        assert_eq!(classify_scroll_phase(PHASE_ENDED, PHASE_ENDED), None);
    }

    #[test]
    fn event_payload_serializes_to_the_frontend_contract() {
        let event = TrackpadGestureEvent {
            phase: TrackpadGesturePhase::Began,
            swipe_enabled: true,
        };
        assert_eq!(
            serde_json::to_string(&event).unwrap(),
            r#"{"phase":"began","swipeEnabled":true}"#
        );
        assert_eq!(TRACKPAD_GESTURE_EVENT, "trackpad-gesture");
    }
}
