//! 访问控制（server-access-policy Phase 1，需求来源 2026-09-17）。
//! 第一棒（316a839）交付数据层：identity/registry/cap/config；第二棒
//! （tasks 1.5/1.5b/1.7/1.8）交付执行点接线：
//! - [`identity`]：server.key load-or-create（task 1.1，design §6/§11.2）
//! - [`registry`]：owners.jsonl append-only + 活跃集合快照 + generation +
//!   reload 热重载（task 1.2 + task 1.5 接线，design §8.5）
//! - [`cap`]：RelayCapV1 逐字节编解码与 L1 验证纯函数（task 1.4，design
//!   §8.2/§11.1）
//! - [`config`]：配置面 flag > env > default 与 fail-fast 校验（task 1.3，design §11.2）
//! - [`gate`]：AccessGate 验证链聚合（C0/L1/L1b/L2）+ registry 热重载看护
//!   （task 1.5，design §8.2）
//! - [`callback`]：CallbackProvider webhook 决策器（协议卫生/SSRF/缓存/
//!   并发防护/disconnect 通知，task 1.5b，design §8.5）
//!
//! rendezvous ACL（task 1.6）与真 relay e2e（task 1.9）是下一棒。

pub mod callback;
pub mod cap;
pub mod config;
pub mod gate;
pub mod identity;
pub mod registry;
