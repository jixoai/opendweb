//! 访问控制（server-access-policy Phase 1 + server-access-roles Phase 1a，
//! 需求来源 2026-09-17 / 2026-09-22）。
//! 第一棒（316a839）交付数据层：identity/registry/cap/config；第二棒
//! （tasks 1.5/1.5b/1.7/1.8）交付执行点接线；第三棒（tasks 1.6/1.9）
//! 交付 rendezvous ACL 与 e2e 矩阵；Phase 3 第一棒（tasks 3.1/3.2 前半）
//! 交付 admin API 与 per-owner 连接配额；server-access-roles Phase 1a
//! 交付三角色内核（名册与门）：
//! - [`identity`]：server.key load-or-create（task 1.1，design §6/§11.2）
//! - [`registry`]：owners.jsonl append-only + 活跃集合快照 + generation +
//!   reload 热重载 + 条目元数据 expires_at/alias/note 与时间维度活跃判定
//!   （task 1.2 + task 1.5 + SAR 1a，design §8.5/§1.3）
//! - [`ledger`]：append-only jsonl 台账共享基座（SAR 1a r1-P1-5 四台账
//!   统一矩阵的 IO/generation 内核）
//! - [`visitor`]：visitors.jsonl 访客名册（R1/R8 无票准入的名册半边，
//!   SAR 1a design §1.1）
//! - [`blocklist`]：blocklist.jsonl 黑名单双维（R8 拒绝半边，design §1.5）
//! - [`knock`]：KnockLog 敲门台账（R3 敲门台内核；relay E1 身份红线，
//!   design §1.2）
//! - [`cap`]：RelayCapV1 逐字节编解码与 L1 验证纯函数（task 1.4，design
//!   §8.2/§11.1）
//! - [`config`]：配置面 flag > env > default 与 fail-fast 校验（task 1.3，design §11.2）
//! - [`gate`]：AccessGate 验证链聚合（C0/L1/L1b/L2 + 无票访客裁决次序/
//!   黑名单双维挂点/L1b 时间维度）与台账热重载看护、rendezvous Op
//!   （task 1.5/1.6 + SAR 1a）、per-owner 在线表与连接配额（task 3.2 前半）
//!   + 访客两级配额与在线投影（SAR 1a）
//! - [`callback`]：CallbackProvider webhook 决策器（协议卫生/SSRF/缓存/
//!   并发防护/disconnect 通知 + 复合 generation 缓存键，task 1.5b + SAR 1a）
//! - [`admin`]：gateway 受保护管理面（Bearer DWEB_ADMIN_TOKEN；owners CRUD
//!   + 注册回执签名 + status 运行态投影 + 访客增量投影，task 3.1 + SAR 1a）
//!
//! e2e 集成矩阵（task 1.9 + SAR 1a）在 tests/（黑盒二进制 + 真 iroh
//! relay/客户端）。

pub mod admin;
pub mod blocklist;
pub mod callback;
pub mod cap;
pub mod config;
pub mod gate;
pub mod identity;
pub mod knock;
pub mod ledger;
pub mod registry;
pub mod visitor;
