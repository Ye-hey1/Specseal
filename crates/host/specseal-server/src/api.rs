//! HTTP 对外面（本档只声明子模块，无自身代码）：转交宿主套件 HTTP 入口的处理
//! 函数、留在 server 的导入与 SSE 事件路由，以及 wire 错误信封。子模块以
//! `lib.rs` 的根层 `pub use` 挂回旧名，`specseal_server::routes` 这类路径不变。

pub mod error;
pub mod events;
pub mod forward;
pub mod routes;
