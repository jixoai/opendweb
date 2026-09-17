//! 访问控制数据层（server-access-policy Phase 1 第一棒，需求来源 2026-09-17）。
//! 四份子模块只做数据层，不含执行点接线（on_connect / rendezvous ACL /
//! PolicyProvider 是下一棒，tasks 1.5/1.5b/1.6）：
//! - [`identity`]：server.key load-or-create（task 1.1，design §6/§11.2）
//! - [`registry`]：owners.jsonl append-only + 活跃集合快照 + generation（task 1.2，design §8.5）
//! - [`cap`]：RelayCapV1 逐字节编解码与 L1 验证纯函数（task 1.4，design §8.2/§11.1）
//! - [`config`]：配置面 flag > env > default 与 fail-fast 校验（task 1.3，design §11.2）

pub mod cap;
pub mod config;
pub mod identity;
pub mod registry;
