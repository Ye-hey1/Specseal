// Windows release build 不开 console 窗口。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    specseal_desktop_lib::run()
}
