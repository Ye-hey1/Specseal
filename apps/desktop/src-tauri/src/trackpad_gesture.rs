//! macOS 触摸板手势阶段的原生监听（desktop-swipe-back-finger-lift design D1、D3）：以 NSEvent
//! 本地监听读卷动事件的 phase／momentumPhase，手指按下与离开时各广播一次 `trackpad-gesture`
//! 给前端 SwipeBack。判读与事件格式在 specseal-desktop-core 的 trackpad_gesture，此处只做
//! AppKit 黏合。

use std::ptr::NonNull;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2_app_kit::{NSEvent, NSEventMask};
use specseal_desktop_core::trackpad_gesture::{
    classify_scroll_phase, TrackpadGestureEvent, TrackpadGesturePhase, TRACKPAD_GESTURE_EVENT,
};
use tauri::{AppHandle, Emitter, Manager};

/// 监听对象：放进 app 管理的状态持有到 app 结束，不提供移除。
struct ScrollMonitor(#[allow(dead_code)] Retained<AnyObject>);

// SAFETY: 监听对象创建后只被持有，不读取、不调用任何方法；唯一的操作是 app 结束时的
// release，而 objc 的 retain／release 可跨线程。
unsafe impl Send for ScrollMonitor {}
unsafe impl Sync for ScrollMonitor {}

/// 挂上卷动事件的本地监听。handler 原样回传事件，WKWebView 与页面卷动不受影响；
/// 安装失败只记录，app 照常（失去触摸板滑动返回）。
pub fn install(app: &AppHandle) {
    let emitter = app.clone();
    let handler = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
        // SAFETY: AppKit 交给 handler 的事件在调用期间有效。
        let ns_event = unsafe { event.as_ref() };
        let phase = classify_scroll_phase(
            ns_event.phase().bits() as u64,
            ns_event.momentumPhase().bits() as u64,
        );
        if let Some(phase) = phase {
            // 系统设置「在页面之间滑动」每次按下都重读，运行中改设置也会生效。
            let swipe_enabled = phase == TrackpadGesturePhase::Began
                && NSEvent::isSwipeTrackingFromScrollEventsEnabled();
            let _ = emitter.emit(
                TRACKPAD_GESTURE_EVENT,
                TrackpadGestureEvent { phase, swipe_enabled },
            );
        }
        event.as_ptr()
    });
    // SAFETY: handler 回传的是 AppKit 交进来的同一个有效事件指针。
    let monitor = unsafe {
        NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::ScrollWheel, &handler)
    };
    match monitor {
        Some(monitor) => {
            app.manage(ScrollMonitor(monitor));
        }
        None => eprintln!("specseal-desktop: trackpad gesture monitor unavailable"),
    }
}
