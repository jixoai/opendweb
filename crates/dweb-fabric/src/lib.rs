pub mod continuity;
pub mod fabric;
pub mod identity;
// 有界 known_addrs 存储（HB 3.1 内部实现细节）
mod known_addrs;
pub mod protocol;
pub mod roster;
pub mod secret;
pub mod session;

pub use fabric::{
    Fabric, FabricConfig, FabricError, FabricEvent, HttpProxyConfig, InviteOptions,
    JOIN_TIMEOUT_MS_DEFAULT, JOIN_TIMEOUT_MS_MAX, JOIN_TIMEOUT_MS_MIN, JoinErrorCode, MemberInfo,
    RelayConfig, RelayEntry, RelayProbeFn, RelayStatusSnapshot, RelayStatusView, RelayTlsTrust,
    SecretInjection, inject_relay_tokens, normalize_advertise_addrs, precheck_join_token,
    precheck_join_token_v2, set_relay_probe_for_tests,
};
pub use session::{LinkStatus, RedeemError, SessionError};

/// 跨 crate 冻结向量（server-access-policy task 2.3）：dweb-server
/// `access::cap::sign_and_encode` 的输出串，固定输入为
/// `SigningKey::from_bytes(&[1u8;32])`、fabric_id=`[3u8;32]`、
/// server_id=`[2u8;32]`、recipient=`SigningKey::from_bytes(&[4u8;32])` 公钥、
/// caps=`0b111`、issued_at=`1_800_000_000_000`、expires_at=`1_800_003_600_000`。
/// dweb-server 侧 cap.rs `cross_crate_vector_frozen` 与本 crate
/// protocol.rs `relay_cap_cross_crate_vector` 锚定同一串——fabric（iroh
/// SecretKey）与 server（dalek SigningKey）两条独立实现的任一漂移都会在
/// 各自测试爆红（Ed25519 确定性签名下两侧输出必须逐字节相等）。
pub const CROSS_CRATE_CAP_VECTOR: &str = "dwebr1.AQMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgKKiOPddAnxlf1S2y08ul1yymcJvx2UEhvzdIgBtA9vXMqTrBcFGHBx1nuDx_8O_oEI6OxFMFdddyaHkzPb2r58BwAAAaMYXFAAAAABoxiTPoDKl8Nfr0zIfv5h5qDsMVtPs9G5afdFkgIsPxzjf50TA8kUtCXBkblcrYsEAzRO7TUzDx5Mm2kAOM7aVZ6FaV8J";
