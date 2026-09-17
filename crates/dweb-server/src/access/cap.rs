//! RelayCapV1 capability 令牌：canonical 编解码与 L1 密码学验证纯函数
//! （task 1.4，需求来源 2026-09-17；design §11.1 逐字节布局 / §8.2 验证链
//! C1..C7 / §8.5 缓存投影）。
//!
//! 字节布局（canonical 146B，全部大端 BE；签名输入 = 18B 域前缀 + canonical，
//! 域前缀不进 wire）：
//! ```text
//! version u8(0x01) || fabric_id[32] || server_id[32] || issuer[32]
//! || recipient[32] || caps u8 || issued_at u64BE || expires_at u64BE
//! ```
//! wire = canonical(146B) || sig(64B) = 210B；串 = "dwebr1." +
//! base64url-nopad(210B) = 7 + 280 = **287 字符**（编码测试冻结，design
//! §11.1 R2 P2 修正）。
//!
//! Server 不签发 capability（Owner 意志只能由 root key 表达，design §6.2）；
//! [`sign_and_encode`] 仅供测试与工具链（Phase 2 root 自签）。
//! [`verify_l1`] 是纯函数：执行点接线在 access::gate / relay.rs（task 1.5）。
//! 解析卫生：先长度门、后字符集白名单、再逐段形状（checked 切分，绝不 panic，
//! design §13 解析 DoS 面）。
//!
//! task 1.5 接线后，relay 面未消费的项（RDZ caps 位、TOKEN_LEN 冻结常量、
//! 测试签发器）仍预留 rendezvous ACL（task 1.6）与 SDK 面（Phase 2）使用，
//! 定点豁免 dead_code：
#![allow(dead_code)]

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use thiserror::Error;

/// 串前缀（design §11.1）
pub const TOKEN_PREFIX: &str = "dwebr1.";

/// 域分隔前缀（签名输入前 18B，不进 wire）
const DOMAIN: &[u8] = b"dweb/relay-cap/v1\0";

/// CapsV1 位图（design §7.2）：bit0 RELAY、bit1 RDZ_ANNOUNCE、bit2 RDZ_RESOLVE；
/// bit3..7 保留（验证时必须拒绝，C3）
pub const CAP_RELAY: u8 = 1 << 0;
pub const CAP_RDZ_ANNOUNCE: u8 = 1 << 1;
pub const CAP_RDZ_RESOLVE: u8 = 1 << 2;
/// 已知 caps 位掩码（0b0000_0111）；超出此掩码的位 = 未知保留位
pub const CAP_KNOWN_MASK: u8 = CAP_RELAY | CAP_RDZ_ANNOUNCE | CAP_RDZ_RESOLVE;

const VERSION: u8 = 0x01;
const KEY_LEN: usize = 32;
const SIG_LEN: usize = 64;
/// version(1) + 4×key(32) + caps(1) + 2×u64(8)
const CANONICAL_LEN: usize = 1 + 4 * KEY_LEN + 1 + 2 * 8;
/// canonical + signature
const WIRE_LEN: usize = CANONICAL_LEN + SIG_LEN;
/// base64url-nopad(210B) = 280 字符（210 恰为 3 的倍数，无 pad）
const ENCODED_LEN: usize = 280;
/// 串总长 = 前缀 7 + 280（冻结断言见 tests::token_shape_frozen）
pub const TOKEN_LEN: usize = TOKEN_PREFIX.len() + ENCODED_LEN;
/// C1 长度门：≤ 1KiB（design §8.2 C1）
const MAX_TOKEN_LEN: usize = 1024;

/// issued_at 容许的时钟偏移（design §11.1：CLOCK_SKEW 120s）
const CLOCK_SKEW_MS: u64 = 120_000;
/// TTL 验证侧统一上限 180d（design §11.1）
const MAX_TTL_MS: u64 = 180 * 24 * 60 * 60 * 1000;

/// 缓存投影定长（design §8.5 冻结：caps u8 || issued_at u64BE || expires_at
/// u64BE || fabric_id 32 || issuer 32 || recipient 32）
pub const HASH_INPUT_LEN: usize = 1 + 8 + 8 + 3 * KEY_LEN;

/// deny 原因枚举（design §8.2 各 C 系/B 系/L2 货币化 reason；reason() 为
/// iroh-relay 握手协议回传客户端的稳定 slug，SDK 透出为诊断事件）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum CapDeny {
    /// L2 static：无票（C0 无票路径）
    #[error("no capability presented")]
    NoCapability,
    /// C1/C2：长度门 / 前缀 / base64url 字符集 / 形状
    #[error("malformed capability")]
    MalformedCapability,
    /// C3：caps 含未知保留位
    #[error("caps contains unsupported reserved bits")]
    CapsUnsupported,
    /// C4：Ed25519 验签失败
    #[error("capability signature invalid")]
    BadSignature,
    /// C5：server_id 不匹配
    #[error("capability issued for another server")]
    WrongServer,
    /// C6：过期 / 未来签发 / 时间窗 / TTL 超限
    #[error("capability expired or outside validity window")]
    CapabilityExpired,
    /// C7：recipient 不符（E1 绑定）
    #[error("capability recipient mismatch")]
    NotRecipient,
}

impl CapDeny {
    /// 稳定 deny reason slug（回传客户端；语法见 design §8.5 reason 冻结）
    pub fn reason(&self) -> &'static str {
        match self {
            Self::NoCapability => "dweb/no-capability",
            Self::MalformedCapability => "dweb/malformed-capability",
            Self::CapsUnsupported => "dweb/caps-unsupported",
            Self::BadSignature => "dweb/bad-signature",
            Self::WrongServer => "dweb/wrong-server",
            Self::CapabilityExpired => "dweb/capability-expired",
            Self::NotRecipient => "dweb/not-recipient",
        }
    }
}

/// 已解析（未验证）的 RelayCapV1。字段均为原始字节视图；有效性由
/// [`verify_l1`] 判定。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RelayCap {
    pub fabric_id: [u8; KEY_LEN],
    pub server_id: [u8; KEY_LEN],
    pub issuer: [u8; KEY_LEN],
    pub recipient: [u8; KEY_LEN],
    pub caps: u8,
    pub issued_at: u64,
    pub expires_at: u64,
    pub signature: [u8; SIG_LEN],
}

impl RelayCap {
    /// canonical 编码（不含域前缀、不含签名）
    fn canonical_bytes(&self) -> [u8; CANONICAL_LEN] {
        let mut buf = [0u8; CANONICAL_LEN];
        buf[0] = VERSION;
        buf[1..33].copy_from_slice(&self.fabric_id);
        buf[33..65].copy_from_slice(&self.server_id);
        buf[65..97].copy_from_slice(&self.issuer);
        buf[97..129].copy_from_slice(&self.recipient);
        buf[129] = self.caps;
        buf[130..138].copy_from_slice(&self.issued_at.to_be_bytes());
        buf[138..146].copy_from_slice(&self.expires_at.to_be_bytes());
        buf
    }

    /// 是否持有指定位（L1b B2 op 所需 caps 位检查用，下一棒接线）
    pub fn has_cap(&self, cap: u8) -> bool {
        self.caps & cap == cap
    }
}

/// 签发并编码（测试/工具用；issuer 由 signer 公钥派生，Server 运行时不调用）
pub fn sign_and_encode(
    signer: &SigningKey,
    fabric_id: &[u8; KEY_LEN],
    server_id: &[u8; KEY_LEN],
    recipient: &[u8; KEY_LEN],
    caps: u8,
    issued_at: u64,
    expires_at: u64,
) -> String {
    let cap = RelayCap {
        fabric_id: *fabric_id,
        server_id: *server_id,
        issuer: signer.verifying_key().to_bytes(),
        recipient: *recipient,
        caps,
        issued_at,
        expires_at,
        signature: [0u8; SIG_LEN],
    };
    let canonical = cap.canonical_bytes();
    let sig = signer.sign(&[DOMAIN, &canonical].concat());
    let mut wire = [0u8; WIRE_LEN];
    wire[..CANONICAL_LEN].copy_from_slice(&canonical);
    wire[CANONICAL_LEN..].copy_from_slice(&sig.to_bytes());
    format!("{TOKEN_PREFIX}{}", URL_SAFE_NO_PAD.encode(wire))
}

fn is_base64url_ascii(b: u8) -> bool {
    matches!(b, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_')
}

/// 解析 `dwebr1.` 串 → [`RelayCap`]（不做密码学验证；C1/C2 形态门在此）。
/// 防解析 DoS 顺序（design §8.2 C1→C2）：长度门 → 前缀 → 字符集白名单 →
/// base64 解码（定长输出缓冲）→ 逐段形状（split_at 链，无 panic 路径）。
pub fn decode(token: &str) -> Result<RelayCap, CapDeny> {
    // C1 长度门（1KiB）
    if token.len() > MAX_TOKEN_LEN {
        return Err(CapDeny::MalformedCapability);
    }
    // C2 前缀
    let payload = token
        .strip_prefix(TOKEN_PREFIX)
        .ok_or(CapDeny::MalformedCapability)?;
    // 形状：定长 280 且纯 base64url 字符集（白名单先行，拒绝 '=' pad 与
    // 标准 alphabet 的 '+'/'/'）
    if payload.len() != ENCODED_LEN || !payload.bytes().all(is_base64url_ascii) {
        return Err(CapDeny::MalformedCapability);
    }
    let mut wire = [0u8; WIRE_LEN];
    let decoded = URL_SAFE_NO_PAD
        .decode_slice(payload, &mut wire)
        .map_err(|_| CapDeny::MalformedCapability)?;
    if decoded != WIRE_LEN {
        return Err(CapDeny::MalformedCapability);
    }
    // 逐段形状：先定长切分再逐字段取值（index 由常量算术保证在界内）
    let (canonical, sig) = wire.split_at(CANONICAL_LEN);
    if canonical[0] != VERSION {
        return Err(CapDeny::MalformedCapability);
    }
    let fields = &canonical[1..];
    let (fabric_id, rest) = fields.split_at(KEY_LEN);
    let (server_id, rest) = rest.split_at(KEY_LEN);
    let (issuer, rest) = rest.split_at(KEY_LEN);
    let (recipient, rest) = rest.split_at(KEY_LEN);
    let (caps, times) = rest.split_at(1);
    let (issued_at, expires_at) = times.split_at(8);
    Ok(RelayCap {
        fabric_id: fabric_id.try_into().expect("split_at 定长"),
        server_id: server_id.try_into().expect("split_at 定长"),
        issuer: issuer.try_into().expect("split_at 定长"),
        recipient: recipient.try_into().expect("split_at 定长"),
        caps: caps[0],
        issued_at: u64::from_be_bytes(issued_at.try_into().expect("split_at 定长")),
        expires_at: u64::from_be_bytes(expires_at.try_into().expect("split_at 定长")),
        signature: sig.try_into().expect("split_at 定长"),
    })
}

/// L1 密码学验证（design §8.2 C3..C7；纯函数，无 I/O）。C1/C2 由 [`decode`]
/// 承担；L1b（registry 二元组 + op caps 位）与 L2 策略在执行点组合（下一棒）。
///
/// - `expected_server_id`：本 Server 的 ServerId（C5）
/// - `authenticated_endpoint_id`：iroh-relay 握手认证身份（E1；C7 recipient 绑定）
/// - `now_ms`：接入判定时刻
pub fn verify_l1(
    cap: &RelayCap,
    expected_server_id: &[u8; KEY_LEN],
    authenticated_endpoint_id: &[u8; KEY_LEN],
    now_ms: u64,
) -> Result<(), CapDeny> {
    // C3：未知保留位一律拒绝（前向兼容由版本号承担，不由静默忽略承担）
    if cap.caps & !CAP_KNOWN_MASK != 0 {
        return Err(CapDeny::CapsUnsupported);
    }
    // C4：issuer Ed25519 验签（域分隔输入 = DOMAIN || canonical）
    // issuer 字节不是合法曲线点时直接 BadSignature（不可能存在有效签名）
    let verifying = VerifyingKey::from_bytes(&cap.issuer).map_err(|_| CapDeny::BadSignature)?;
    let canonical = cap.canonical_bytes();
    let message = [DOMAIN, &canonical].concat();
    verifying
        .verify(&message, &Signature::from_bytes(&cap.signature))
        .map_err(|_| CapDeny::BadSignature)?;
    // C5：跨 Server 重放防护
    if cap.server_id != *expected_server_id {
        return Err(CapDeny::WrongServer);
    }
    // C6：时间三重校验（语义同 protocol.rs invite 兑换：等值即拒、无滑窗）
    if now_ms >= cap.expires_at {
        return Err(CapDeny::CapabilityExpired);
    }
    if cap.issued_at > now_ms.saturating_add(CLOCK_SKEW_MS) {
        return Err(CapDeny::CapabilityExpired);
    }
    if cap.issued_at > cap.expires_at {
        return Err(CapDeny::CapabilityExpired);
    }
    // 前置条款已保证 issued_at <= expires_at，减法无下溢
    if cap.expires_at - cap.issued_at > MAX_TTL_MS {
        return Err(CapDeny::CapabilityExpired);
    }
    // C7：recipient == 握手认证 id（E1）
    if cap.recipient != *authenticated_endpoint_id {
        return Err(CapDeny::NotRecipient);
    }
    Ok(())
}

/// CallbackProvider 决策缓存的固定二进制投影（design §8.5 R4 P1-4 冻结）：
/// `caps u8 || issued_at u64BE || expires_at u64BE || fabric_id 32B ||
/// issuer 32B || recipient 32B`（113B 定长）。不含 server_id/签名。
pub fn hash_input(cap: &RelayCap) -> [u8; HASH_INPUT_LEN] {
    let mut out = [0u8; HASH_INPUT_LEN];
    out[0] = cap.caps;
    out[1..9].copy_from_slice(&cap.issued_at.to_be_bytes());
    out[9..17].copy_from_slice(&cap.expires_at.to_be_bytes());
    out[17..49].copy_from_slice(&cap.fabric_id);
    out[49..81].copy_from_slice(&cap.issuer);
    out[81..113].copy_from_slice(&cap.recipient);
    out
}

/// 无票 sentinel 投影（design §8.5）：caps=0 || issued=0 || expires=0 ||
/// zero×96——与任何真实票投影无碰撞（caps=0 的票无法通过 L1b B2）。
pub fn hash_input_none() -> [u8; HASH_INPUT_LEN] {
    [0u8; HASH_INPUT_LEN]
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_800_000_000_000; // 固定时钟基准（2026-09 量级）
    const TTL: u64 = 3_600_000; // 1h，远小于 180d

    struct Fixture {
        issuer: SigningKey,
        server_id: [u8; 32],
        fabric_id: [u8; 32],
        recipient: [u8; 32],
    }

    impl Fixture {
        fn new() -> Self {
            Self {
                issuer: SigningKey::from_bytes(&[1u8; 32]),
                server_id: [2u8; 32],
                fabric_id: [3u8; 32],
                recipient: [4u8; 32],
            }
        }

        fn token(&self, caps: u8, issued: u64, expires: u64) -> String {
            sign_and_encode(
                &self.issuer,
                &self.fabric_id,
                &self.server_id,
                &self.recipient,
                caps,
                issued,
                expires,
            )
        }

        fn valid_token(&self) -> String {
            self.token(CAP_KNOWN_MASK, NOW, NOW + TTL)
        }

        fn verify(&self, token: &str) -> Result<(), CapDeny> {
            let cap = decode(token)?;
            verify_l1(&cap, &self.server_id, &self.recipient, NOW)
        }
    }

    #[test]
    fn roundtrip_encode_decode() {
        let f = Fixture::new();
        let token = f.valid_token();
        let cap = decode(&token).unwrap();
        assert_eq!(cap.fabric_id, f.fabric_id);
        assert_eq!(cap.server_id, f.server_id);
        assert_eq!(cap.issuer, f.issuer.verifying_key().to_bytes());
        assert_eq!(cap.recipient, f.recipient);
        assert_eq!(cap.caps, CAP_KNOWN_MASK);
        assert_eq!(cap.issued_at, NOW);
        assert_eq!(cap.expires_at, NOW + TTL);
    }

    /// 长度冻结（design §11.1）：串 287 字符 = "dwebr1."(7) + base64url(280)；
    /// wire 210B = canonical 146B + sig 64B；域前缀 18B 不进 wire。
    #[test]
    fn token_shape_frozen() {
        let f = Fixture::new();
        let token = f.valid_token();
        assert_eq!(token.len(), 287);
        assert_eq!(TOKEN_LEN, 287);
        let payload = token.strip_prefix("dwebr1.").unwrap();
        assert_eq!(payload.len(), 280);
        assert_eq!(DOMAIN.len(), 18);
        assert_eq!(CANONICAL_LEN, 146);
        assert_eq!(WIRE_LEN, 210);
    }

    #[test]
    fn verify_ok_and_cap_bits() {
        let f = Fixture::new();
        assert_eq!(f.verify(&f.valid_token()), Ok(()));
        // 各已知位组合均通过 C3（含仅 RELAY——Visitor 默认 caps，design §7.2）
        for caps in [CAP_RELAY, CAP_RDZ_ANNOUNCE, CAP_RDZ_RESOLVE, CAP_KNOWN_MASK] {
            assert_eq!(
                f.verify(&f.token(caps, NOW, NOW + TTL)),
                Ok(()),
                "caps={caps:08b}"
            );
        }
        let cap = decode(&f.token(CAP_RELAY, NOW, NOW + TTL)).unwrap();
        assert!(cap.has_cap(CAP_RELAY));
        assert!(!cap.has_cap(CAP_RDZ_RESOLVE));
    }

    /// C3：bit3..7 保留位（含最高位）签名合法也必须拒绝
    #[test]
    fn deny_caps_unsupported() {
        let f = Fixture::new();
        for caps in [0x08, 0x10, 0x80, 0xFF, CAP_RELAY | 0x40] {
            let token = f.token(caps, NOW, NOW + TTL); // 签名有效
            assert_eq!(
                f.verify(&token),
                Err(CapDeny::CapsUnsupported),
                "caps={caps:08b}"
            );
        }
    }

    /// C4：篡改任一字段（不重签）→ BadSignature
    #[test]
    fn deny_bad_signature_on_tampered_fields() {
        /// 字段篡改点（caps 篡改选 XOR 1：0b111→0b110 仍是已知位，保证到达 C4）
        #[derive(Debug, Clone, Copy)]
        enum Tamper {
            Caps,
            IssuedAt,
            ExpiresAt,
            FabricId,
            ServerId,
            Recipient,
            Signature,
        }
        fn apply(c: &mut RelayCap, t: Tamper) {
            match t {
                Tamper::Caps => c.caps ^= 1,
                Tamper::IssuedAt => c.issued_at += 1,
                Tamper::ExpiresAt => c.expires_at += 1,
                Tamper::FabricId => c.fabric_id[0] ^= 1,
                Tamper::ServerId => c.server_id[0] ^= 1,
                Tamper::Recipient => c.recipient[0] ^= 1,
                Tamper::Signature => c.signature[0] ^= 1,
            }
        }
        let f = Fixture::new();
        let mut cap = decode(&f.valid_token()).unwrap();
        let cases = [
            Tamper::Caps,
            Tamper::IssuedAt,
            Tamper::ExpiresAt,
            Tamper::FabricId,
            Tamper::ServerId,
            Tamper::Recipient,
            Tamper::Signature,
        ];
        for t in cases {
            let mut c = cap.clone();
            apply(&mut c, t);
            assert_eq!(
                verify_l1(&c, &f.server_id, &f.recipient, NOW),
                Err(CapDeny::BadSignature),
                "篡改 {t:?} 后签名不再成立"
            );
        }
        // 换 issuer 公钥（非法曲线点字节）也归 BadSignature
        cap.issuer = [0xEE; 32];
        assert_eq!(
            verify_l1(&cap, &f.server_id, &f.recipient, NOW),
            Err(CapDeny::BadSignature)
        );
    }

    /// C4 交叉签名：另一把 key 对同 canonical 的签名无效
    #[test]
    fn deny_cross_key_signature() {
        let f = Fixture::new();
        let other = SigningKey::from_bytes(&[9u8; 32]);
        let token = sign_and_encode(
            &other,
            &f.fabric_id,
            &f.server_id,
            &f.recipient,
            CAP_RELAY,
            NOW,
            NOW + TTL,
        );
        // issuer 是 other 的公钥、签名是 other 的——但对 f 的语义无关；
        // 此票密码学上自洽，应通过 C4 并在后续条款放行（不同 issuer 合法）
        assert_eq!(f.verify(&token), Ok(()));
        // 真正的坏签名：f.issuer 的票换 other 签
        let mut cap = decode(&f.valid_token()).unwrap();
        let canonical = cap.canonical_bytes();
        cap.signature = other.sign(&[DOMAIN, &canonical].concat()).to_bytes();
        assert_eq!(
            verify_l1(&cap, &f.server_id, &f.recipient, NOW),
            Err(CapDeny::BadSignature)
        );
    }

    /// C5：server_id 不匹配（合法签名、指向别的 Server）
    #[test]
    fn deny_wrong_server() {
        let f = Fixture::new();
        let other_server = [0xAA; 32];
        let token = sign_and_encode(
            &f.issuer,
            &f.fabric_id,
            &other_server,
            &f.recipient,
            CAP_RELAY,
            NOW,
            NOW + TTL,
        );
        assert_eq!(f.verify(&token), Err(CapDeny::WrongServer));
    }

    /// C6a：now >= expires_at 等值即拒；expires_at-1 放行
    #[test]
    fn deny_expired_with_equal_boundary() {
        let f = Fixture::new();
        let token = f.token(CAP_RELAY, NOW, NOW + TTL);
        let cap = decode(&token).unwrap();
        assert_eq!(
            verify_l1(&cap, &f.server_id, &f.recipient, NOW + TTL),
            Err(CapDeny::CapabilityExpired),
            "now == expires_at 等值即拒"
        );
        assert_eq!(
            verify_l1(&cap, &f.server_id, &f.recipient, NOW + TTL - 1),
            Ok(())
        );
    }

    /// C6b：issued_at 超过 now+120s 拒；恰好 +120_000ms 放行（边界）
    #[test]
    fn deny_future_issued_at_with_skew_boundary() {
        let f = Fixture::new();
        let token = f.token(CAP_RELAY, NOW + 120_001, NOW + 120_001 + TTL);
        assert_eq!(f.verify(&token), Err(CapDeny::CapabilityExpired));
        let boundary = f.token(CAP_RELAY, NOW + 120_000, NOW + 120_000 + TTL);
        assert_eq!(f.verify(&boundary), Ok(()));
    }

    /// C6c：issued_at > expires_at
    #[test]
    fn deny_issued_after_expires() {
        let f = Fixture::new();
        let token = f.token(CAP_RELAY, NOW + 10_000, NOW);
        assert_eq!(f.verify(&token), Err(CapDeny::CapabilityExpired));
    }

    /// C6d：TTL 超 180d 拒；恰 180d 放行（边界）
    #[test]
    fn deny_ttl_over_180d_with_boundary() {
        let f = Fixture::new();
        let over = f.token(CAP_RELAY, NOW, NOW + 180 * 24 * 3600 * 1000 + 1);
        assert_eq!(f.verify(&over), Err(CapDeny::CapabilityExpired));
        let exact = f.token(CAP_RELAY, NOW, NOW + 180 * 24 * 3600 * 1000);
        assert_eq!(f.verify(&exact), Ok(()));
    }

    /// C7：recipient != 握手认证 id（E1）
    #[test]
    fn deny_not_recipient() {
        let f = Fixture::new();
        let cap = decode(&f.valid_token()).unwrap();
        let other_endpoint = [0xBB; 32];
        assert_eq!(
            verify_l1(&cap, &f.server_id, &other_endpoint, NOW),
            Err(CapDeny::NotRecipient)
        );
    }

    /// C1/C2：非法定长形态（截断/超长/非法字符/标准 alphabet/pad/坏前缀/坏版本）
    #[test]
    fn deny_malformed_shapes() {
        fn with_byte(s: &str, idx: usize, b: u8) -> String {
            let mut v = s.as_bytes().to_vec();
            v[idx] = b;
            String::from_utf8(v).unwrap()
        }
        let f = Fixture::new();
        let token = f.valid_token();
        // 坏前缀 / 空串
        assert_eq!(decode("dwebr2.aaaa"), Err(CapDeny::MalformedCapability));
        assert_eq!(decode(""), Err(CapDeny::MalformedCapability));
        // 截断（长度门 1KiB 之内但 payload 形状非 280）
        assert_eq!(
            decode(&token[..token.len() - 1]),
            Err(CapDeny::MalformedCapability)
        );
        assert_eq!(decode(&token[..100]), Err(CapDeny::MalformedCapability));
        // 超长（> 1KiB）
        let long = format!("{TOKEN_PREFIX}{}", "A".repeat(2048));
        assert_eq!(decode(&long), Err(CapDeny::MalformedCapability));
        // 长度恰 287 但含非 base64url 字符（标准 alphabet '+'/'/'、'='、'!'）
        assert_eq!(
            decode(&with_byte(&token, 100, b'+')),
            Err(CapDeny::MalformedCapability)
        );
        assert_eq!(
            decode(&with_byte(&token, 100, b'/')),
            Err(CapDeny::MalformedCapability)
        );
        assert_eq!(
            decode(&with_byte(&token, 100, b'=')),
            Err(CapDeny::MalformedCapability)
        );
        assert_eq!(
            decode(&with_byte(&token, 100, b'!')),
            Err(CapDeny::MalformedCapability)
        );
        // 非 ASCII 多字节字符（长度门按字节计，字符集白名单拦截）
        let weird = format!("{TOKEN_PREFIX}{}", "中".repeat(280));
        assert_eq!(decode(&weird), Err(CapDeny::MalformedCapability));
        // pad 形态：280+'='（payload 长度 281 ≠ 280）
        let padded = format!("{token}=");
        assert_eq!(decode(&padded), Err(CapDeny::MalformedCapability));
        // 坏版本字节（0x02）：改 wire 首字节后重编码（签名意义不重要，仅形态门）
        let payload = token.strip_prefix(TOKEN_PREFIX).unwrap();
        let mut wire = [0u8; WIRE_LEN];
        URL_SAFE_NO_PAD.decode_slice(payload, &mut wire).unwrap();
        wire[0] = 0x02;
        let bad_version = format!("{TOKEN_PREFIX}{}", URL_SAFE_NO_PAD.encode(wire));
        assert_eq!(decode(&bad_version), Err(CapDeny::MalformedCapability));
    }

    /// 缓存投影布局冻结（design §8.5 R4 P1-4）：113B = caps(1)+issued(8)+
    /// expires(8)+fabric(32)+issuer(32)+recipient(32)；无票 sentinel 全零。
    #[test]
    fn hash_input_projection_frozen() {
        assert_eq!(HASH_INPUT_LEN, 113);
        let f = Fixture::new();
        let cap = decode(&f.token(0b101, NOW, NOW + TTL)).unwrap();
        let h = hash_input(&cap);
        assert_eq!(h[0], 0b101);
        assert_eq!(&h[1..9], NOW.to_be_bytes());
        assert_eq!(&h[9..17], (NOW + TTL).to_be_bytes());
        assert_eq!(&h[17..49], &f.fabric_id);
        assert_eq!(&h[49..81], &cap.issuer);
        assert_eq!(&h[81..113], &f.recipient);
        // 无票 sentinel：caps=0||0||0||zero×96（与有票投影必不同）
        let none = hash_input_none();
        assert_eq!(none, [0u8; 113]);
        assert_ne!(none, h);
    }

    #[test]
    fn deny_reason_slugs() {
        assert_eq!(CapDeny::NoCapability.reason(), "dweb/no-capability");
        assert_eq!(
            CapDeny::MalformedCapability.reason(),
            "dweb/malformed-capability"
        );
        assert_eq!(CapDeny::CapsUnsupported.reason(), "dweb/caps-unsupported");
        assert_eq!(CapDeny::BadSignature.reason(), "dweb/bad-signature");
        assert_eq!(CapDeny::WrongServer.reason(), "dweb/wrong-server");
        assert_eq!(
            CapDeny::CapabilityExpired.reason(),
            "dweb/capability-expired"
        );
        assert_eq!(CapDeny::NotRecipient.reason(), "dweb/not-recipient");
    }

    /// 跨 crate 冻结向量（server-access-policy Phase 2，task 2.3）：
    /// 同一输入在 dweb-server（本处，dalek SigningKey）与 dweb-fabric
    /// （iroh SecretKey 同种子）两条**独立实现**上必须产出逐字节相等的
    /// `dwebr1.` 串。fabric 侧 `protocol::tests::relay_cap_cross_crate_vector`
    /// 硬编码同一串——任一侧 canonical 布局/域前缀/编码漂移都会在各自
    /// 测试中爆红（Ed25519 确定性签名下两侧输出必然一致）。
    /// 固定输入：issuer=SigningKey([1;32])、server_id=[2;32]、fabric_id=[3;32]、
    /// recipient=SigningKey([4;32]) 的公钥（跨 crate 向量取两端类型都能表示
    /// 的值——fabric 侧 recipient 是 EndpointId 真实曲线点，非任意 32B）、
    /// caps=CAP_KNOWN_MASK、issued=NOW、expires=NOW+TTL。
    #[test]
    fn cross_crate_vector_frozen() {
        let f = Fixture::new();
        let recipient: [u8; 32] = SigningKey::from_bytes(&[4u8; 32])
            .verifying_key()
            .to_bytes();
        let token = sign_and_encode(
            &f.issuer,
            &f.fabric_id,
            &f.server_id,
            &recipient,
            CAP_KNOWN_MASK,
            NOW,
            NOW + TTL,
        );
        assert_eq!(token, "dwebr1.AQMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgKKiOPddAnxlf1S2y08ul1yymcJvx2UEhvzdIgBtA9vXMqTrBcFGHBx1nuDx_8O_oEI6OxFMFdddyaHkzPb2r58BwAAAaMYXFAAAAABoxiTPoDKl8Nfr0zIfv5h5qDsMVtPs9G5afdFkgIsPxzjf50TA8kUtCXBkblcrYsEAzRO7TUzDx5Mm2kAOM7aVZ6FaV8J");
    }
}
