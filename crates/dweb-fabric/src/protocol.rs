//! Canonical formats for membership facts, invite tokens and redemption
//! proof-of-possession material (fabric spec: roster / codex review §2-3).
//!
//! Everything that gets signed is encoded as **domain-separated canonical
//! bytes** with explicit lengths — never JSON, never map-order dependent.
//! Fact ids are content addresses: `BLAKE3(canonical bytes)`, so there are no
//! client-generated random ids and "same id ⇒ same content" holds by
//! construction. All signatures are Ed25519 via the iroh key types
//! (`iroh_base::SecretKey`/`Signature`), the same keys as the transport
//! endpoint — no second signature stack.
//!
//! # Canonical byte layout of [`Fact`] (v1)
//!
//! All integers are big-endian. Fixed-width fields come first, optional
//! fields afterwards in a fixed order, each announced by a tag byte, so
//! encoding is a pure function of the field values.
//!
//! ```text
//! offset  size  field
//! 0       13    domain          b"dweb/fact/v1\0"
//! 13      1     kind            1=Genesis 2=Grant 3=Join 4=Revoke
//! 14      32    fabric_id       raw
//! 46      32    issuer          EndpointId (raw Ed25519 public key)
//! 78      32    subject         EndpointId (raw)
//! 110     8     issued_at_ms    u64 BE, unix epoch milliseconds
//! 118     1     flags           bit0: display_name present
//!                                 bit1: expires_at_ms present
//!                                 bit2: target_fact_id present (Revoke)
//!                                 (all other bits must be 0)
//! 119     ..    if bit0: u16 BE name_len || name_len bytes UTF-8 (≤ 512 B)
//! ..      ..    if bit1: u64 BE expires_at_ms
//! ..      ..    if bit2: 32 B target_fact_id
//! ```
//!
//! `fact_id = BLAKE3(canonical bytes)` — the id is *not* part of the canonical
//! bytes (it is derived from them). [`Fact::decode_strict`] rejects bad
//! domain, unknown kinds, reserved flag bits, truncation, lying length
//! prefixes, non-UTF-8 names, oversized names and trailing bytes; such
//! failures surface as [`ProtocolError::Quarantine`].
//!
//! # Canonical byte layout of [`InviteV1`] (v1)
//!
//! ```text
//! offset  size  field
//! 0       15    domain          b"dweb/invite/v1\0"
//! 15      1     version         0x01
//! 16      32    fabric_id       raw
//! 48      16    invite_id       raw random
//! 64      32    issuer          EndpointId (raw)
//! 96      2+n   relay_url       u16 BE len || UTF-8 (≤ 2048 B)
//! ..      1     n_addrs         direct address count (0..=4)
//! ..      Σ     per addr: u8 len (≤ 64) || UTF-8 bytes
//! ..      8     expires_at_ms   u64 BE
//! ..      1     flags           bit0: recipient present
//! ..      32?   recipient       EndpointId (raw), if bit0
//! ..      1     max_uses        must be 1
//! ```
//!
//! The invite token string is `dweb1.` + base64url-nopad of
//! `InviteV1 canonical bytes || 64 B issuer signature`. Decoding verifies the
//! version header, all lengths and the signature.
//!
//! # Canonical byte layout of [`InviteV2`] (v2, server-access-policy 附录 A)
//!
//! v2 与 v1 物理隔离：不同域前缀、不同版本字节、不同串前缀（`dweb2.`），
//! 不改 v1 的任何字节语义。布局（附录 A 唯一 wire 权威，全部大端 BE）：
//!
//! ```text
//! offset  size  field
//! 0       15    domain          b"dweb/invite/v2\0"
//! 15      1     version         0x02
//! 16      32    fabric_id       raw
//! 48      16    invite_id       raw random（单次兑换）
//! 64      32    issuer          EndpointId (raw, root)
//! 96      8     expires_at_ms   u64 BE
//! 104     32    recipient       EndpointId (raw)——v2 恒必填（编解码层强制）
//! 136     1     relay_count     0..=8
//! ..      Σ     per relay: u16 BE url_len || url UTF-8 (≤2048B)
//!                 || u16 BE cap_len || capability 串原始字节（≤512B；
//!                 cap_len == 0 表示该 relay 无凭证）
//! ..      1     addr_count      0..=4
//! ..      Σ     per addr: SocketAddr 二进制编码——u8 family（4=IPv4 / 6=IPv6）
//!                 || addr bytes（4B / 16B）|| u16 BE port
//! ```
//!
//! 解码一致性（附录 A）：每条带凭证的 relay 其 capability 解析后
//! recipient == 令牌 recipient 且 expires_at ≤ 令牌 expires_at_ms，违者
//! Quarantine。`dweb2.` 令牌交给仅支持 v1 的解码路径报
//! [`ProtocolError::UnsupportedInviteVersion`]（附录 A2 第九码的协议层来源）。
//!
//! # RelayCapV1 capability 令牌（design §11.1）
//!
//! fabric 侧的 RelayCapV1 同构实现（dweb-server 是 bin-only crate，不可直接
//! 依赖）：canonical 146B + Ed25519 64B = wire 210B，串 = `dwebr1.` +
//! base64url-nopad = 287 字符。两处实现的漂移由双侧硬编码冻结向量测试拦截
//!（dweb-server cap.rs `cross_crate_vector_frozen` 与本模块
//! `relay_cap_cross_crate_vector` 锚定同一串）。
//!
//! # Proof of possession (redeem PoP)
//!
//! The invitee B signs [`redeem_challenge_bytes`] over
//! `b"dweb/redeem-pop/v1\0" || fabric_id || invite_id || challenge[32]` with
//! B's iroh secret key; the issuer verifies with the claimed redeemer's
//! `EndpointId`. A stolen token without B's private key cannot answer the
//! challenge.

use std::fmt;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use iroh_base::{SecretKey, Signature};
use thiserror::Error;

use crate::identity::{EndpointId, NodeIdentity};

/// Domain-separation prefix of canonical fact bytes (trailing NUL included).
pub const FACT_DOMAIN: &[u8; 13] = b"dweb/fact/v1\0";
/// Domain-separation prefix of canonical invite bytes (trailing NUL included).
pub const INVITE_DOMAIN: &[u8; 15] = b"dweb/invite/v1\0";
/// Domain-separation prefix of redemption PoP material (trailing NUL included).
pub const POP_DOMAIN: &[u8; 19] = b"dweb/redeem-pop/v1\0";

/// Version byte inside InviteV1 canonical bytes.
pub const INVITE_VERSION: u8 = 0x01;

/// Version prefix of invite token strings.
pub const TOKEN_PREFIX: &str = "dweb1.";

// ==== server-access-policy 附录 A / §11.1（Phase 2，tasks 2.1/2.3） ============

/// Domain-separation prefix of canonical InviteV2 bytes（附录 A；与 v1 域
/// 不同——两代令牌在签名输入层即互不兼容）。
pub const INVITE2_DOMAIN: &[u8; 15] = b"dweb/invite/v2\0";
/// Version byte inside InviteV2 canonical bytes.
pub const INVITE2_VERSION: u8 = 0x02;
/// Version prefix of InviteV2 token strings.
pub const TOKEN2_PREFIX: &str = "dweb2.";
/// InviteV2 relay 列表上限（附录 A：0..=8）。
pub const MAX_RELAYS_V2: usize = 8;
/// InviteV2 单条 relay 内嵌 capability 串上限（与附录 A2 OK2 条目同值）。
pub const MAX_RELAY_CAP_BYTES: usize = 512;

/// RelayCapV1 域分隔前缀（design §11.1：18B，签名输入前缀，不进 wire；
/// 与 dweb-server access/cap.rs 逐字节一致）。
pub const RELAY_CAP_DOMAIN: &[u8; 18] = b"dweb/relay-cap/v1\0";
/// RelayCapV1 串前缀（design §11.1）。
pub const RELAY_CAP_TOKEN_PREFIX: &str = "dwebr1.";
/// CapsV1 位图（design §7.2）：bit0 RELAY / bit1 RDZ_ANNOUNCE / bit2 RDZ_RESOLVE；
/// bit3..7 保留（fabric 签发侧拒绝，server 验证链 C3 拒绝）。
pub const CAP_RELAY: u8 = 1 << 0;
pub const CAP_RDZ_ANNOUNCE: u8 = 1 << 1;
pub const CAP_RDZ_RESOLVE: u8 = 1 << 2;
pub const CAP_KNOWN_MASK: u8 = CAP_RELAY | CAP_RDZ_ANNOUNCE | CAP_RDZ_RESOLVE;
/// capability TTL 验证侧统一上限：180d（design §11.1；dweb-server C6d 同值）。
pub const RELAY_CAP_MAX_TTL_MS: u64 = 180 * 24 * 60 * 60 * 1000;
/// root 自签 own capability 的 TTL：180d - 1ms（在上限内，永不触等值边界）。
pub const ROOT_CAP_TTL_MS: u64 = RELAY_CAP_MAX_TTL_MS - 1;
/// REDEEM_OK2 附发 member capability 的 TTL 建议上限：90d（design §7.3）。
pub const MEMBER_CAP_TTL_MS: u64 = 90 * 24 * 60 * 60 * 1000;
/// root 自签 own capability 的 caps 位（design §7.2 签发最小化：root 全位）。
pub const ROOT_CAPS: u8 = CAP_KNOWN_MASK;
/// invite v2 内嵌 bootstrap / OK2 附发 member capability 的默认 caps 位
/// （design §7.2 签发最小化：默认仅 RELAY，RDZ_* 由 Owner 显式勾选）。
pub const MEMBER_CAPS: u8 = CAP_RELAY;

/// Maximum size of a fact's display_name payload in bytes.
pub const MAX_NAME_BYTES: usize = 512;
/// Maximum size of an invite's relay URL in bytes.
pub const MAX_RELAY_URL_BYTES: usize = 2048;
/// Maximum number of direct addresses inside an invite.
pub const MAX_DIRECT_ADDRS: usize = 4;
/// Maximum size of a single direct address string in bytes.
pub const MAX_DIRECT_ADDR_BYTES: usize = 64;

/// Length of the fixed (pre-optional) part of the fact layout.
const FACT_FIXED_LEN: usize = FACT_DOMAIN.len() + 1 + 32 + 32 + 32 + 8 + 1; // 119
/// Length of the fixed (pre-optional) part of the invite layout.
const INVITE_FIXED_LEN: usize = INVITE_DOMAIN.len() + 1 + 32 + 16 + 32; // through `issuer` = 96
const INVITE_MIN_LEN: usize = INVITE_FIXED_LEN + 2 + 1 + 8 + 1 + 1; // + empty relay len, n_addrs, expiry, flags, max_uses

const KIND_GENESIS: u8 = 1;
const KIND_GRANT: u8 = 2;
const KIND_JOIN: u8 = 3;
const KIND_REVOKE: u8 = 4;

const FLAG_HAS_NAME: u8 = 0b001;
const FLAG_HAS_EXPIRY: u8 = 0b010;
const FLAG_HAS_TARGET: u8 = 0b100;

/// Errors from canonical encoding/decoding, signatures and tokens.
#[derive(Debug, Error)]
pub enum ProtocolError {
    /// A field cannot be represented in the canonical layout (local
    /// construction error — e.g. an oversized display_name or relay URL).
    #[error("canonical encoding error: {0}")]
    Encoding(String),
    /// The bytes are not a valid canonical structure, or a signature failed
    /// verification. Such input is untrusted: quarantine it, do not store.
    #[error("quarantine: {reason}")]
    Quarantine { reason: String },
    /// 令牌版本超出当前解码路径的支持范围（附录 A2：`dweb2.` 令牌交给仅
    /// 支持 v1 的路径）。与 Quarantine 的区别：输入本身没有损坏，是版本
    /// 协商失败——join 侧映射为第九码 `unsupported-invite-version`（含
    /// 升级指引），不与"令牌被伪造/篡改"混同。
    #[error("unsupported invite version: {0}")]
    UnsupportedInviteVersion(String),
    /// Debug JSON (de)serialization failed. JSON is *not* canonical.
    #[error("debug JSON error: {0}")]
    Json(#[from] serde_json::Error),
}

fn quarantine(reason: impl Into<String>) -> ProtocolError {
    ProtocolError::Quarantine {
        reason: reason.into(),
    }
}

/// Content address of a [`Fact`]: the BLAKE3 hash of its canonical bytes.
pub type FactId = [u8; 32];

/// Identity of one fabric (network). 32 bytes per spec; produced by
/// `FabricId::random()` at creation time or `FabricId::from_name` for
/// deterministic derivation from a human-chosen name.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct FabricId(pub [u8; 32]);

impl FabricId {
    /// Deterministically derives a fabric id from a name (BLAKE3 of the
    /// UTF-8 bytes). Same name ⇒ same fabric id on every device.
    pub fn from_name(name: &str) -> Self {
        Self(*blake3::hash(name.as_bytes()).as_bytes())
    }

    /// Generates a fresh random fabric id.
    pub fn random() -> Self {
        Self(random_bytes::<32>())
    }

    /// Raw bytes.
    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

impl fmt::Display for FabricId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&hex_str(&self.0))
    }
}

/// OS entropy via iroh's key generation, squeezed through BLAKE3 so any
/// length ≤ 32 is available. (Avoids a direct rand/getrandom dependency.)
pub fn random_bytes<const N: usize>() -> [u8; N] {
    debug_assert!(N <= 32);
    let seed = SecretKey::generate().to_bytes();
    let hash = blake3::hash(&seed);
    let mut out = [0u8; N];
    let n = N.min(32);
    out[..n].copy_from_slice(&hash.as_bytes()[..n]);
    out
}

/// What a fact asserts about its subject.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum FactKind {
    /// The fabric's immutable trust root: issuer == subject == root.
    /// Exactly one per fabric; establishes the root EndpointId.
    Genesis = KIND_GENESIS,
    /// Membership grant (v0.1: only meaningful when issued by the root).
    Grant = KIND_GRANT,
    /// A member's self-description (display name). Not an admission edge.
    Join = KIND_JOIN,
    /// Revocation of a specific grant or of a subject's live grants.
    Revoke = KIND_REVOKE,
}

impl FactKind {
    /// Canonical discriminant used on the wire.
    pub const fn as_u8(self) -> u8 {
        self as u8
    }

    /// Parses the wire discriminant.
    pub const fn from_u8(v: u8) -> Option<Self> {
        match v {
            KIND_GENESIS => Some(Self::Genesis),
            KIND_GRANT => Some(Self::Grant),
            KIND_JOIN => Some(Self::Join),
            KIND_REVOKE => Some(Self::Revoke),
            _ => None,
        }
    }

    /// Stable name for the debug JSON projection.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Genesis => "genesis",
            Self::Grant => "grant",
            Self::Join => "join",
            Self::Revoke => "revoke",
        }
    }
}

impl fmt::Display for FactKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// An immutable membership fact. The id is *not* stored: it is the BLAKE3
/// content address of the canonical bytes ([`Fact::fact_id`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fact {
    /// What this fact asserts.
    pub kind: FactKind,
    /// The fabric this fact belongs to (cross-fabric facts are rejected).
    pub fabric_id: FabricId,
    /// Signer's identity (== iroh endpoint id of the signer).
    pub issuer: EndpointId,
    /// Who the fact is about.
    pub subject: EndpointId,
    /// Optional human-readable label (≤ 512 bytes UTF-8).
    pub display_name: Option<String>,
    /// Unix epoch milliseconds when the fact was issued.
    pub issued_at_ms: u64,
    /// Unix epoch milliseconds after which the fact is inert.
    /// Valid at `now` iff absent or `now < expires_at_ms` (fail-closed).
    pub expires_at_ms: Option<u64>,
    /// Revoke only: the targeted grant's fact id. `None` on a Revoke means
    /// "all live grants of `subject`".
    pub target_fact_id: Option<FactId>,
}

impl Fact {
    /// Whether this fact still has effect at `now_ms`.
    pub fn is_valid_at(&self, now_ms: u64) -> bool {
        self.expires_at_ms.is_none_or(|e| now_ms < e)
    }

    /// The content address of this fact: BLAKE3 over the canonical bytes.
    /// Deterministic — the same field values always yield the same id.
    ///
    /// For an *unrepresentable* fact (oversized display_name) the canonical
    /// encoding fails; such facts can never be signed, verified or stored,
    /// and all share a constant sentinel id.
    pub fn fact_id(&self) -> FactId {
        match self.canonical_bytes() {
            Ok(bytes) => *blake3::hash(&bytes).as_bytes(),
            Err(_) => *blake3::hash(b"dweb/fact-unrepresentable/v1\0").as_bytes(),
        }
    }

    /// Deterministic canonical byte serialization (see module docs). This
    /// byte string — and only this byte string — is what gets signed.
    pub fn canonical_bytes(&self) -> Result<Vec<u8>, ProtocolError> {
        if let Some(name) = &self.display_name
            && name.len() > MAX_NAME_BYTES
        {
            return Err(ProtocolError::Encoding(format!(
                "display_name of {} bytes exceeds the {} byte limit",
                name.len(),
                MAX_NAME_BYTES
            )));
        }
        let name_len = self.display_name.as_ref().map_or(0, String::len);
        let mut buf = Vec::with_capacity(
            FACT_FIXED_LEN
                + if name_len > 0 { 2 + name_len } else { 0 }
                + self.expires_at_ms.map_or(0, |_| 8)
                + self.target_fact_id.map_or(0, |_| 32),
        );
        buf.extend_from_slice(FACT_DOMAIN);
        buf.push(self.kind.as_u8());
        buf.extend_from_slice(self.fabric_id.as_bytes());
        buf.extend_from_slice(self.issuer.as_bytes());
        buf.extend_from_slice(self.subject.as_bytes());
        buf.extend_from_slice(&self.issued_at_ms.to_be_bytes());
        let mut flags = 0u8;
        if self.display_name.is_some() {
            flags |= FLAG_HAS_NAME;
        }
        if self.expires_at_ms.is_some() {
            flags |= FLAG_HAS_EXPIRY;
        }
        if self.target_fact_id.is_some() {
            flags |= FLAG_HAS_TARGET;
        }
        buf.push(flags);
        if let Some(name) = &self.display_name {
            buf.extend_from_slice(&(name.len() as u16).to_be_bytes());
            buf.extend_from_slice(name.as_bytes());
        }
        if let Some(exp) = self.expires_at_ms {
            buf.extend_from_slice(&exp.to_be_bytes());
        }
        if let Some(target) = self.target_fact_id {
            buf.extend_from_slice(&target);
        }
        Ok(buf)
    }

    /// Strict parse: the input must be exactly one canonical fact (no
    /// trailing bytes). Any violation is a [`ProtocolError::Quarantine`].
    pub fn decode_strict(bytes: &[u8]) -> Result<Fact, ProtocolError> {
        let (fact, consumed) = parse_fact_prefix(bytes)?;
        if consumed != bytes.len() {
            return Err(quarantine(format!(
                "{} trailing byte(s) after canonical fact",
                bytes.len() - consumed
            )));
        }
        Ok(fact)
    }
}

/// Parses a canonical fact from the front of `bytes`, returning the fact and
/// the number of bytes consumed.
fn parse_fact_prefix(bytes: &[u8]) -> Result<(Fact, usize), ProtocolError> {
    let trunc = |what: &str| quarantine(format!("truncated canonical fact: {what}"));
    if bytes.len() < FACT_FIXED_LEN {
        return Err(trunc("shorter than the fixed 119-byte prefix"));
    }
    if &bytes[..FACT_DOMAIN.len()] != FACT_DOMAIN {
        return Err(quarantine(format!(
            "bad fact domain {bytes:?} (expected {FACT_DOMAIN:?})"
        )));
    }
    let kind = FactKind::from_u8(bytes[13])
        .ok_or_else(|| quarantine(format!("unknown fact kind 0x{:02x}", bytes[13])))?;
    let fabric_id = FabricId(bytes[14..46].try_into().expect("slice len 32"));
    let issuer = key_from_bytes(&bytes[46..78])?;
    let subject = key_from_bytes(&bytes[78..110])?;
    let issued_at_ms = u64::from_be_bytes(bytes[110..118].try_into().expect("slice len 8"));
    let flags = bytes[118];
    if flags & !(FLAG_HAS_NAME | FLAG_HAS_EXPIRY | FLAG_HAS_TARGET) != 0 {
        return Err(quarantine(format!("reserved flag bits set: 0x{flags:02x}")));
    }

    let mut off = FACT_FIXED_LEN;
    let display_name = if flags & FLAG_HAS_NAME != 0 {
        if bytes.len() < off + 2 {
            return Err(trunc("display_name length prefix"));
        }
        let name_len = u16::from_be_bytes([bytes[off], bytes[off + 1]]) as usize;
        off += 2;
        if name_len > MAX_NAME_BYTES {
            return Err(quarantine(format!(
                "display_name of {name_len} bytes exceeds the {MAX_NAME_BYTES} byte limit"
            )));
        }
        if bytes.len() < off + name_len {
            return Err(trunc("display_name bytes"));
        }
        let name = std::str::from_utf8(&bytes[off..off + name_len])
            .map_err(|_| quarantine("display_name is not valid UTF-8"))?
            .to_owned();
        off += name_len;
        Some(name)
    } else {
        None
    };
    let expires_at_ms = if flags & FLAG_HAS_EXPIRY != 0 {
        if bytes.len() < off + 8 {
            return Err(trunc("expires_at_ms"));
        }
        let exp = u64::from_be_bytes(bytes[off..off + 8].try_into().expect("slice len 8"));
        off += 8;
        Some(exp)
    } else {
        None
    };
    let target_fact_id = if flags & FLAG_HAS_TARGET != 0 {
        if bytes.len() < off + 32 {
            return Err(trunc("target_fact_id"));
        }
        let t = bytes[off..off + 32].try_into().expect("slice len 32");
        off += 32;
        Some(t)
    } else {
        None
    };

    Ok((
        Fact {
            kind,
            fabric_id,
            issuer,
            subject,
            display_name,
            issued_at_ms,
            expires_at_ms,
            target_fact_id,
        },
        off,
    ))
}

/// A fact plus its Ed25519 signature (by the fact's issuer, over the fact's
/// canonical bytes). The wire frame is self-delimiting:
/// `u32 BE fact_len || canonical fact bytes || 64 B signature`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignedFact {
    /// The signed fact.
    pub fact: Fact,
    /// Signature over `fact.canonical_bytes()` by `fact.issuer`.
    pub signature: Signature,
}

impl SignedFact {
    /// Signs `fact` with `secret` (expected: the issuer's key) and wraps the
    /// result.
    pub fn sign(fact: Fact, secret: &SecretKey) -> Result<Self, ProtocolError> {
        let signature = secret.sign(&fact.canonical_bytes()?);
        Ok(Self { fact, signature })
    }

    /// The content address of the carried fact.
    pub fn fact_id(&self) -> FactId {
        self.fact.fact_id()
    }

    /// Verifies the embedded signature against the embedded issuer id. This
    /// proves possession of the issuer's private key — *not* that the issuer
    /// is trusted; trust is computed by the roster projection.
    pub fn verify(&self) -> Result<(), ProtocolError> {
        let bytes = self.fact.canonical_bytes()?;
        self.fact
            .issuer
            .verify(&bytes, &self.signature)
            .map_err(|_| quarantine("fact signature verification failed".to_owned()))
    }

    /// Wire encoding: `u32 BE fact_len || canonical fact bytes || signature`.
    pub fn encode(&self) -> Result<Vec<u8>, ProtocolError> {
        let fact_bytes = self.fact.canonical_bytes()?;
        let mut out = Vec::with_capacity(4 + fact_bytes.len() + Signature::LENGTH);
        out.extend_from_slice(&(fact_bytes.len() as u32).to_be_bytes());
        out.extend_from_slice(&fact_bytes);
        out.extend_from_slice(&self.signature.to_bytes());
        Ok(out)
    }

    /// Strict inverse of [`SignedFact::encode`].
    pub fn decode(bytes: &[u8]) -> Result<Self, ProtocolError> {
        let min = 4 + Signature::LENGTH;
        if bytes.len() < min {
            return Err(quarantine(format!(
                "signed fact wire frame of {} bytes shorter than the minimum {min}",
                bytes.len()
            )));
        }
        let fact_len = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
        let end = 4usize
            .checked_add(fact_len)
            .and_then(|v| v.checked_add(Signature::LENGTH))
            .ok_or_else(|| quarantine("signed fact length overflow"))?;
        if bytes.len() != end {
            return Err(quarantine(format!(
                "signed fact wire frame length mismatch: header says {end}, got {}",
                bytes.len()
            )));
        }
        let fact = Fact::decode_strict(&bytes[4..4 + fact_len])?;
        let signature =
            Signature::from_bytes(bytes[4 + fact_len..end].try_into().expect("slice len 64"));
        Ok(Self { fact, signature })
    }

    /// Encodes many signed facts: `u32 BE count || frames`. Used for roster
    /// dumps (HELLO full-dump stand-in) and the persisted fact store.
    pub fn encode_all<'a>(
        items: impl IntoIterator<Item = &'a SignedFact>,
    ) -> Result<Vec<u8>, ProtocolError> {
        let frames: Vec<Vec<u8>> = items
            .into_iter()
            .map(Self::encode)
            .collect::<Result<_, _>>()?;
        let mut out = Vec::with_capacity(4 + frames.iter().map(Vec::len).sum::<usize>());
        out.extend_from_slice(&(frames.len() as u32).to_be_bytes());
        for frame in frames {
            out.extend_from_slice(&frame);
        }
        Ok(out)
    }

    /// Strict inverse of [`SignedFact::encode_all`].
    pub fn decode_all(bytes: &[u8]) -> Result<Vec<SignedFact>, ProtocolError> {
        let (facts, consumed) = Self::decode_all_prefix(bytes)?;
        if consumed != bytes.len() {
            return Err(quarantine(format!(
                "{} trailing byte(s) after fact list",
                bytes.len() - consumed
            )));
        }
        Ok(facts)
    }

    /// [`decode_all`] 的前缀形态（附录 A2）：解析开头的完整事实列表，返回
    /// (事实, 消费字节数)。REDEEM_OK2 的 payload = 名册 dump 后接 capability
    /// 附发段——事实段必须可独立定界，剩余字节交给 OK2 段解析器。
    pub fn decode_all_prefix(bytes: &[u8]) -> Result<(Vec<SignedFact>, usize), ProtocolError> {
        if bytes.len() < 4 {
            return Err(quarantine(
                "fact list shorter than the u32 count prefix".to_owned(),
            ));
        }
        let count = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
        // Never pre-allocate by an attacker-controlled count.
        let mut out = Vec::new();
        let mut off = 4usize;
        for i in 0..count {
            if bytes.len() < off + 4 {
                return Err(quarantine(format!(
                    "fact list truncated at item {i}'s length prefix"
                )));
            }
            let frame_len =
                u32::from_be_bytes([bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]])
                    as usize;
            let frame_end = off
                .checked_add(4)
                .and_then(|v| v.checked_add(frame_len))
                .and_then(|v| v.checked_add(Signature::LENGTH))
                .ok_or_else(|| quarantine("fact list length overflow".to_owned()))?;
            if bytes.len() < frame_end {
                return Err(quarantine(format!("fact list truncated inside item {i}")));
            }
            out.push(Self::decode(&bytes[off..frame_end])?);
            off = frame_end;
        }
        Ok((out, off))
    }

    /// Human-readable JSON projection for debugging and inspection.
    /// **Not** a canonical format.
    pub fn to_json_string(&self) -> Result<String, ProtocolError> {
        let v = serde_json::json!({
            "fact_id": hex_str(&self.fact_id()),
            "kind": self.fact.kind.as_str(),
            "fabric_id": self.fact.fabric_id.to_string(),
            "issuer": self.fact.issuer.to_z32(),
            "subject": self.fact.subject.to_z32(),
            "display_name": self.fact.display_name,
            "issued_at_ms": self.fact.issued_at_ms,
            "expires_at_ms": self.fact.expires_at_ms,
            "target_fact_id": self.fact.target_fact_id.map(|t| hex_str(&t)),
            "signature": hex_str(&self.signature.to_bytes()),
        });
        serde_json::to_string(&v).map_err(ProtocolError::Json)
    }
}

/// Builds the fabric's Genesis fact: kind=Genesis, issuer=subject=root,
/// signed by the root identity. This is the single trust root of the fabric.
pub fn genesis(
    identity: &NodeIdentity,
    fabric_id: FabricId,
    now_ms: u64,
) -> Result<SignedFact, ProtocolError> {
    let fact = Fact {
        kind: FactKind::Genesis,
        fabric_id,
        issuer: identity.endpoint_id(),
        subject: identity.endpoint_id(),
        display_name: None,
        issued_at_ms: now_ms,
        expires_at_ms: None,
        target_fact_id: None,
    };
    SignedFact::sign(fact, identity.secret_key())
}

/// The self-contained invite payload (see module docs for the layout).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InviteV1 {
    /// The fabric this invite admits into.
    pub fabric_id: FabricId,
    /// Random 16-byte one-time capability id (CAS-consumed at redemption).
    pub invite_id: [u8; 16],
    /// The inviter (v0.1: must be the fabric root).
    pub issuer: EndpointId,
    /// The issuer's relay URL (how to reach the issuer for redemption).
    pub issuer_relay_url: String,
    /// Optional direct addresses of the issuer (≤ 4, each ≤ 64 bytes).
    pub issuer_direct_addrs: Vec<String>,
    /// Unix epoch milliseconds after which the token is dead.
    pub expires_at_ms: u64,
    /// Optional pre-bound recipient (redeem PoP must come from exactly this
    /// EndpointId).
    pub recipient: Option<EndpointId>,
}

impl InviteV1 {
    /// Canonical bytes (domain-separated, explicit lengths; see module docs).
    pub fn canonical_bytes(&self) -> Result<Vec<u8>, ProtocolError> {
        if self.issuer_relay_url.len() > MAX_RELAY_URL_BYTES {
            return Err(ProtocolError::Encoding(format!(
                "relay URL of {} bytes exceeds the {} byte limit",
                self.issuer_relay_url.len(),
                MAX_RELAY_URL_BYTES
            )));
        }
        if self.issuer_direct_addrs.len() > MAX_DIRECT_ADDRS {
            return Err(ProtocolError::Encoding(format!(
                "{} direct addrs exceeds the limit of {MAX_DIRECT_ADDRS}",
                self.issuer_direct_addrs.len()
            )));
        }
        for addr in &self.issuer_direct_addrs {
            if addr.len() > MAX_DIRECT_ADDR_BYTES {
                return Err(ProtocolError::Encoding(format!(
                    "direct addr of {} bytes exceeds the {MAX_DIRECT_ADDR_BYTES} byte limit",
                    addr.len()
                )));
            }
        }
        let mut buf = Vec::with_capacity(INVITE_MIN_LEN + self.issuer_relay_url.len());
        buf.extend_from_slice(INVITE_DOMAIN);
        buf.push(INVITE_VERSION);
        buf.extend_from_slice(self.fabric_id.as_bytes());
        buf.extend_from_slice(&self.invite_id);
        buf.extend_from_slice(self.issuer.as_bytes());
        buf.extend_from_slice(&(self.issuer_relay_url.len() as u16).to_be_bytes());
        buf.extend_from_slice(self.issuer_relay_url.as_bytes());
        buf.push(self.issuer_direct_addrs.len() as u8);
        for addr in &self.issuer_direct_addrs {
            buf.push(addr.len() as u8);
            buf.extend_from_slice(addr.as_bytes());
        }
        buf.extend_from_slice(&self.expires_at_ms.to_be_bytes());
        buf.push(if self.recipient.is_some() { 1 } else { 0 });
        if let Some(recipient) = self.recipient {
            buf.extend_from_slice(recipient.as_bytes());
        }
        buf.push(1); // max_uses, fixed at 1
        Ok(buf)
    }

    /// Strict parse of exactly one canonical invite.
    pub fn decode_strict(bytes: &[u8]) -> Result<Self, ProtocolError> {
        let trunc = |what: &str| quarantine(format!("truncated canonical invite: {what}"));
        if bytes.len() < INVITE_MIN_LEN {
            return Err(trunc("shorter than the fixed prefix"));
        }
        if &bytes[..INVITE_DOMAIN.len()] != INVITE_DOMAIN {
            return Err(quarantine(format!(
                "bad invite domain {bytes:?} (expected {INVITE_DOMAIN:?})"
            )));
        }
        if bytes[15] != INVITE_VERSION {
            return Err(quarantine(format!(
                "unsupported invite version 0x{:02x}",
                bytes[15]
            )));
        }
        let fabric_id = FabricId(bytes[16..48].try_into().expect("slice len 32"));
        let invite_id = bytes[48..64].try_into().expect("slice len 16");
        let issuer = key_from_bytes(&bytes[64..96])?;
        let mut off = INVITE_FIXED_LEN;
        if bytes.len() < off + 2 {
            return Err(trunc("relay URL length prefix"));
        }
        let relay_len = u16::from_be_bytes([bytes[off], bytes[off + 1]]) as usize;
        off += 2;
        if relay_len > MAX_RELAY_URL_BYTES {
            return Err(quarantine(format!(
                "relay URL of {relay_len} bytes exceeds the {MAX_RELAY_URL_BYTES} byte limit"
            )));
        }
        if bytes.len() < off + relay_len {
            return Err(trunc("relay URL bytes"));
        }
        let issuer_relay_url = std::str::from_utf8(&bytes[off..off + relay_len])
            .map_err(|_| quarantine("relay URL is not valid UTF-8"))?
            .to_owned();
        off += relay_len;
        if bytes.len() < off + 1 {
            return Err(trunc("direct addr count"));
        }
        let n_addrs = bytes[off] as usize;
        off += 1;
        if n_addrs > MAX_DIRECT_ADDRS {
            return Err(quarantine(format!(
                "{n_addrs} direct addrs exceeds the limit of {MAX_DIRECT_ADDRS}"
            )));
        }
        let mut issuer_direct_addrs = Vec::with_capacity(n_addrs);
        for _ in 0..n_addrs {
            if bytes.len() < off + 1 {
                return Err(trunc("direct addr length prefix"));
            }
            let addr_len = bytes[off] as usize;
            off += 1;
            if addr_len > MAX_DIRECT_ADDR_BYTES {
                return Err(quarantine(format!(
                    "direct addr of {addr_len} bytes exceeds the {MAX_DIRECT_ADDR_BYTES} byte limit"
                )));
            }
            if bytes.len() < off + addr_len {
                return Err(trunc("direct addr bytes"));
            }
            let addr = std::str::from_utf8(&bytes[off..off + addr_len])
                .map_err(|_| quarantine("direct addr is not valid UTF-8"))?
                .to_owned();
            off += addr_len;
            issuer_direct_addrs.push(addr);
        }
        if bytes.len() < off + 8 + 1 {
            return Err(trunc("expires_at_ms / flags"));
        }
        let expires_at_ms =
            u64::from_be_bytes(bytes[off..off + 8].try_into().expect("slice len 8"));
        off += 8;
        let flags = bytes[off];
        off += 1;
        if flags > 1 {
            return Err(quarantine(format!(
                "reserved invite flag bits: 0x{flags:02x}"
            )));
        }
        let recipient = if flags == 1 {
            if bytes.len() < off + 32 {
                return Err(trunc("recipient"));
            }
            let r = key_from_bytes(&bytes[off..off + 32])?;
            off += 32;
            Some(r)
        } else {
            None
        };
        if bytes.len() != off + 1 {
            return Err(quarantine(format!(
                "invite length mismatch: expected {} bytes, got {}",
                off + 1,
                bytes.len()
            )));
        }
        let max_uses = bytes[off];
        if max_uses != 1 {
            return Err(quarantine(format!(
                "invite max_uses must be 1, got {max_uses}"
            )));
        }
        Ok(Self {
            fabric_id,
            invite_id,
            issuer,
            issuer_relay_url,
            issuer_direct_addrs,
            expires_at_ms,
            recipient,
        })
    }

    /// Whether the invite is expired at `now_ms` (expired at the exact
    /// instant of its expiry).
    pub fn is_expired(&self, now_ms: u64) -> bool {
        now_ms >= self.expires_at_ms
    }
}

/// An [`InviteV1`] plus the issuer's signature, rendered as the
/// `dweb1.<base64url-nopad>` token string.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InviteToken {
    /// The invite payload.
    pub invite: InviteV1,
    /// The issuer's signature over the invite's canonical bytes.
    pub signature: Signature,
}

impl InviteToken {
    /// Signs `invite` with `secret` (the issuer's key).
    pub fn sign(invite: InviteV1, secret: &SecretKey) -> Result<Self, ProtocolError> {
        let signature = secret.sign(&invite.canonical_bytes()?);
        Ok(Self { invite, signature })
    }

    /// Renders the token string: `dweb1.` + base64url-nopad of
    /// `InviteV1 canonical bytes || signature`.
    pub fn encode(&self) -> Result<String, ProtocolError> {
        let mut payload = self.invite.canonical_bytes()?;
        payload.extend_from_slice(&self.signature.to_bytes());
        Ok(format!(
            "{TOKEN_PREFIX}{}",
            URL_SAFE_NO_PAD.encode(&payload)
        ))
    }

    /// Parses a token string and validates the version header, all lengths
    /// and the issuer signature (anything malformed is
    /// [`ProtocolError::Quarantine`]).
    ///
    /// 本解码器只接受 v1（附录 A2 兼容矩阵"v1 joiner"列）：`dweb2.` 令牌
    /// 报 [`ProtocolError::UnsupportedInviteVersion`]（第九码来源），不做
    /// 降级尝试。v2 令牌走 [`InviteV2Token::decode`]。
    pub fn decode(s: &str) -> Result<Self, ProtocolError> {
        if s.starts_with(TOKEN2_PREFIX) {
            return Err(ProtocolError::UnsupportedInviteVersion(
                "invite token is v2 (dweb2.) but this decoder supports v1 only; upgrade the \
                 SDK to redeem v2 invites"
                    .to_owned(),
            ));
        }
        let b64 = s
            .strip_prefix(TOKEN_PREFIX)
            .ok_or_else(|| quarantine(format!("token does not start with {TOKEN_PREFIX:?}")))?;
        let payload = URL_SAFE_NO_PAD
            .decode(b64)
            .map_err(|e| quarantine(format!("token base64 decoding failed: {e}")))?;
        if payload.len() < Signature::LENGTH {
            return Err(quarantine(
                "token payload shorter than a signature".to_owned(),
            ));
        }
        let split = payload.len() - Signature::LENGTH;
        let invite = InviteV1::decode_strict(&payload[..split])?;
        let signature = Signature::from_bytes(payload[split..].try_into().expect("slice len 64"));
        let token = Self { invite, signature };
        token
            .verify()
            .map_err(|_| quarantine("invite token signature verification failed".to_owned()))?;
        Ok(token)
    }

    /// Verifies the embedded signature against the embedded issuer id.
    pub fn verify(&self) -> Result<(), ProtocolError> {
        let bytes = self.invite.canonical_bytes()?;
        self.invite
            .issuer
            .verify(&bytes, &self.signature)
            .map_err(|_| quarantine("invite signature verification failed".to_owned()))
    }

    /// Whether the invite is expired at `now_ms`.
    pub fn is_expired(&self, now_ms: u64) -> bool {
        self.invite.is_expired(now_ms)
    }
}

// ==== RelayCapV1（server-access-policy design §11.1；task 2.3） ================

/// RelayCapV1 的已解析形态（fabric 侧同构实现；签发/嵌入用，策略验证在
/// dweb-server 验证链）。字段布局与 dweb-server `access::cap::RelayCap`
/// 逐字节一致——两处漂移由双侧冻结向量测试拦截（见模块文档）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayCapV1 {
    /// 归属 fabric（与 issuer 二元组查 registry）。
    pub fabric_id: FabricId,
    /// 绑定 ServerId（防跨 Server 重放）。
    pub server_id: [u8; 32],
    /// root EndpointId（须 ∈ server 侧 owner registry）。
    pub issuer: EndpointId,
    /// 使用者 EndpointId（== iroh relay 握手认证 id，E1）。
    pub recipient: EndpointId,
    /// CapsV1 位图（仅已知位——decode 拒绝保留位，encode 同样拒绝）。
    pub caps: u8,
    pub issued_at: u64,
    pub expires_at: u64,
}

/// canonical 146B = version(1) + 4×32 + caps(1) + 2×u64（§11.1 冻结）。
const RELAY_CAP_CANONICAL_LEN: usize = 1 + 4 * 32 + 1 + 2 * 8;
/// wire 210B = canonical + 签名 64B。
const RELAY_CAP_WIRE_LEN: usize = RELAY_CAP_CANONICAL_LEN + 64;
/// base64url-nopad(210B) = 280 字符（210 恰为 3 的倍数，无 pad）。
const RELAY_CAP_ENCODED_LEN: usize = 280;
/// 串总长 = 前缀 7 + 280 = 287（与 dweb-server cap.rs TOKEN_LEN 同值冻结）。
pub const RELAY_CAP_TOKEN_LEN: usize = RELAY_CAP_TOKEN_PREFIX.len() + RELAY_CAP_ENCODED_LEN;
/// C1 长度门：≤ 1KiB（dweb-server 同值；fabric 侧 decode 用）。
const RELAY_CAP_MAX_TOKEN_LEN: usize = 1024;
const RELAY_CAP_VERSION: u8 = 0x01;

impl RelayCapV1 {
    /// canonical 字节（不含域前缀、不含签名——签名输入 = 域前缀 || canonical）。
    fn canonical_bytes(&self) -> [u8; RELAY_CAP_CANONICAL_LEN] {
        let mut buf = [0u8; RELAY_CAP_CANONICAL_LEN];
        buf[0] = RELAY_CAP_VERSION;
        buf[1..33].copy_from_slice(self.fabric_id.as_bytes());
        buf[33..65].copy_from_slice(&self.server_id);
        buf[65..97].copy_from_slice(self.issuer.as_bytes());
        buf[97..129].copy_from_slice(self.recipient.as_bytes());
        buf[129] = self.caps;
        buf[130..138].copy_from_slice(&self.issued_at.to_be_bytes());
        buf[138..146].copy_from_slice(&self.expires_at.to_be_bytes());
        buf
    }

    /// 签发并编码为 `dwebr1.` 串（root 自签 / bootstrap / member 附发共用；
    /// 签名者为 root，issuer 由签名公钥派生）。
    ///
    /// 编码期即拒绝越界输入（签发侧 fail-fast，杜绝产出 server 验证链必拒
    /// 的令牌）：caps 保留位、TTL > 180d、issued_at > expires_at。
    pub fn sign_and_encode(
        secret: &SecretKey,
        fabric_id: &FabricId,
        server_id: &[u8; 32],
        recipient: &EndpointId,
        caps: u8,
        issued_at: u64,
        expires_at: u64,
    ) -> Result<String, ProtocolError> {
        if caps & !CAP_KNOWN_MASK != 0 {
            return Err(ProtocolError::Encoding(format!(
                "caps 0x{caps:02x} contains reserved bits (known mask 0x{CAP_KNOWN_MASK:02x})"
            )));
        }
        if issued_at > expires_at {
            return Err(ProtocolError::Encoding(
                "issued_at must not exceed expires_at".to_owned(),
            ));
        }
        if expires_at - issued_at > RELAY_CAP_MAX_TTL_MS {
            return Err(ProtocolError::Encoding(format!(
                "capability TTL over the {RELAY_CAP_MAX_TTL_MS}ms ceiling (design §11.1)"
            )));
        }
        let cap = Self {
            fabric_id: *fabric_id,
            server_id: *server_id,
            issuer: secret.public(),
            recipient: *recipient,
            caps,
            issued_at,
            expires_at,
        };
        let canonical = cap.canonical_bytes();
        // 签名输入 = 18B 域前缀 + 146B canonical（域前缀不进 wire，§11.1）
        let mut message = Vec::with_capacity(RELAY_CAP_DOMAIN.len() + canonical.len());
        message.extend_from_slice(RELAY_CAP_DOMAIN);
        message.extend_from_slice(&canonical);
        let signature = secret.sign(&message);
        let mut wire = [0u8; RELAY_CAP_WIRE_LEN];
        wire[..RELAY_CAP_CANONICAL_LEN].copy_from_slice(&canonical);
        wire[RELAY_CAP_CANONICAL_LEN..].copy_from_slice(&signature.to_bytes());
        Ok(format!(
            "{RELAY_CAP_TOKEN_PREFIX}{}",
            URL_SAFE_NO_PAD.encode(wire)
        ))
    }

    /// 解析 `dwebr1.` 串 → 字段形态（长度门/前缀/定长 base64url 白名单/
    /// 版本/逐段切分；全部违规 → Quarantine）。不做 L1 策略校验（registry/
    /// server_id/recipient/时间窗由 server 侧验证链裁定；invite v2 解码期的
    /// 一致性检查只消费 recipient 与 expires_at 两个字段）。
    pub fn decode(s: &str) -> Result<Self, ProtocolError> {
        let bad = || quarantine("not a well-formed dwebr1. capability token".to_owned());
        if s.len() > RELAY_CAP_MAX_TOKEN_LEN {
            return Err(bad());
        }
        let payload = s.strip_prefix(RELAY_CAP_TOKEN_PREFIX).ok_or_else(bad)?;
        if payload.len() != RELAY_CAP_ENCODED_LEN
            || !payload
                .bytes()
                .all(|b| matches!(b, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_'))
        {
            return Err(bad());
        }
        let mut wire = [0u8; RELAY_CAP_WIRE_LEN];
        let decoded = URL_SAFE_NO_PAD
            .decode_slice(payload, &mut wire)
            .map_err(|_| bad())?;
        if decoded != RELAY_CAP_WIRE_LEN || wire[0] != RELAY_CAP_VERSION {
            return Err(bad());
        }
        if wire[129] & !CAP_KNOWN_MASK != 0 {
            return Err(quarantine(format!(
                "capability caps 0x{:02x} contains reserved bits",
                wire[129]
            )));
        }
        Ok(Self {
            fabric_id: FabricId(wire[1..33].try_into().expect("slice len 32")),
            server_id: wire[33..65].try_into().expect("slice len 32"),
            issuer: key_from_bytes(&wire[65..97])?,
            recipient: key_from_bytes(&wire[97..129])?,
            caps: wire[129],
            issued_at: u64::from_be_bytes(wire[130..138].try_into().expect("slice len 8")),
            expires_at: u64::from_be_bytes(wire[138..146].try_into().expect("slice len 8")),
        })
    }
}

// ==== InviteV2（server-access-policy 附录 A；task 2.1） ========================

/// InviteV2 的单条 relay 条目（附录 A：url + 可选 capability 串）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InviteRelayV2 {
    /// relay URL（UTF-8，≤ 2048B；与 v1 同限）。
    pub url: String,
    /// 内嵌的 RelayCapV1 串（`dwebr1.…`；None = 该 relay 无凭证——
    /// decode 期一致性：recipient == 令牌 recipient 且
    /// expires_at ≤ 令牌 expires_at_ms，违者整令牌 Quarantine）。
    pub capability: Option<String>,
}

/// The self-contained v2 invite payload（附录 A 唯一 wire 权威）。
/// 与 v1 的关键差异：recipient 恒必填（编解码层强制）；relay 升级为
/// 有序列表（≤8 条，每条可带 bootstrap capability）；直连地址为二进制
/// SocketAddr 编码。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InviteV2 {
    pub fabric_id: FabricId,
    /// Random 16-byte one-time capability id（CAS-consumed at redemption）。
    pub invite_id: [u8; 16],
    /// The inviter (must be the fabric root).
    pub issuer: EndpointId,
    /// Unix epoch milliseconds after which the token is dead.
    pub expires_at_ms: u64,
    /// ★ v2 恒必填（与 server 模式无关，附录 A P0-4）。
    pub recipient: EndpointId,
    /// 有序 relay 列表（0..=8；签发时活跃 relay 优先，其余按配置序）。
    pub relays: Vec<InviteRelayV2>,
    /// 直连地址（0..=4）。
    pub direct_addrs: Vec<std::net::SocketAddr>,
}

/// 直连地址二进制 family tag（附录 A "SocketAddr 编码"的实现裁定：
/// u8 4=IPv4(4B addr) / 6=IPv6(16B addr) + u16 BE port；v1 的字符串形态
/// 在 v2 中不沿用——二进制定长无歧义且天然拒绝非规范字符串）。
const ADDR_FAMILY_V4: u8 = 4;
const ADDR_FAMILY_V6: u8 = 6;

/// 定长前缀：域(15) + version(1) + fabric(32) + invite_id(16) + issuer(32)
/// + expires(8) + recipient(32)。
const INVITE2_FIXED_LEN: usize = INVITE2_DOMAIN.len() + 1 + 32 + 16 + 32 + 8 + 32; // 136
const INVITE2_MIN_LEN: usize = INVITE2_FIXED_LEN + 1 + 1; // + relay_count + addr_count

impl InviteV2 {
    /// Canonical bytes（域分隔，显式长度；模块文档布局）。编码期即做全部
    /// 上限校验（relay/addr 计数、url/cap 长度、cap 保留位与一致性——
    /// 与 decode 期同规：不产出自家解码器必拒的令牌）。
    pub fn canonical_bytes(&self) -> Result<Vec<u8>, ProtocolError> {
        if self.relays.len() > MAX_RELAYS_V2 {
            return Err(ProtocolError::Encoding(format!(
                "{} relays exceeds the limit of {MAX_RELAYS_V2}",
                self.relays.len()
            )));
        }
        if self.direct_addrs.len() > MAX_DIRECT_ADDRS {
            return Err(ProtocolError::Encoding(format!(
                "{} direct addrs exceeds the limit of {MAX_DIRECT_ADDRS}",
                self.direct_addrs.len()
            )));
        }
        let mut buf = Vec::with_capacity(INVITE2_MIN_LEN);
        buf.extend_from_slice(INVITE2_DOMAIN);
        buf.push(INVITE2_VERSION);
        buf.extend_from_slice(self.fabric_id.as_bytes());
        buf.extend_from_slice(&self.invite_id);
        buf.extend_from_slice(self.issuer.as_bytes());
        buf.extend_from_slice(&self.expires_at_ms.to_be_bytes());
        buf.extend_from_slice(self.recipient.as_bytes());
        buf.push(self.relays.len() as u8);
        for relay in &self.relays {
            if relay.url.len() > MAX_RELAY_URL_BYTES {
                return Err(ProtocolError::Encoding(format!(
                    "relay URL of {} bytes exceeds the {} byte limit",
                    relay.url.len(),
                    MAX_RELAY_URL_BYTES
                )));
            }
            match &relay.capability {
                Some(cap) => {
                    if cap.len() > MAX_RELAY_CAP_BYTES {
                        return Err(ProtocolError::Encoding(format!(
                            "relay capability of {} bytes exceeds the {MAX_RELAY_CAP_BYTES} byte limit",
                            cap.len()
                        )));
                    }
                    // 编码期一致性（附录 A；与 decode 同规，fail-fast）
                    let parsed = RelayCapV1::decode(cap).map_err(|e| {
                        ProtocolError::Encoding(format!("relay capability invalid: {e}"))
                    })?;
                    if parsed.recipient != self.recipient {
                        return Err(ProtocolError::Encoding(
                            "relay capability recipient does not match the invite recipient"
                                .to_owned(),
                        ));
                    }
                    if parsed.expires_at > self.expires_at_ms {
                        return Err(ProtocolError::Encoding(
                            "relay capability expires after the invite expires".to_owned(),
                        ));
                    }
                    buf.extend_from_slice(&(relay.url.len() as u16).to_be_bytes());
                    buf.extend_from_slice(relay.url.as_bytes());
                    buf.extend_from_slice(&(cap.len() as u16).to_be_bytes());
                    buf.extend_from_slice(cap.as_bytes());
                }
                None => {
                    buf.extend_from_slice(&(relay.url.len() as u16).to_be_bytes());
                    buf.extend_from_slice(relay.url.as_bytes());
                    buf.extend_from_slice(&0u16.to_be_bytes());
                }
            }
        }
        buf.push(self.direct_addrs.len() as u8);
        for addr in &self.direct_addrs {
            match addr {
                std::net::SocketAddr::V4(v4) => {
                    buf.push(ADDR_FAMILY_V4);
                    buf.extend_from_slice(&v4.ip().octets());
                    buf.extend_from_slice(&v4.port().to_be_bytes());
                }
                std::net::SocketAddr::V6(v6) => {
                    buf.push(ADDR_FAMILY_V6);
                    buf.extend_from_slice(&v6.ip().octets());
                    buf.extend_from_slice(&v6.port().to_be_bytes());
                }
            }
        }
        Ok(buf)
    }

    /// 严格解析 canonical v2 invite（附录 A 全部约束 + 内嵌 capability
    /// 一致性校验；任何违规 Quarantine——与 v1 decode_strict 同一卫生等级）。
    pub fn decode_strict(bytes: &[u8]) -> Result<Self, ProtocolError> {
        let trunc = |what: &str| quarantine(format!("truncated canonical invite v2: {what}"));
        if bytes.len() < INVITE2_MIN_LEN {
            return Err(trunc("shorter than the fixed prefix"));
        }
        if &bytes[..INVITE2_DOMAIN.len()] != INVITE2_DOMAIN {
            return Err(quarantine(format!(
                "bad invite v2 domain {bytes:?} (expected {INVITE2_DOMAIN:?})"
            )));
        }
        if bytes[15] != INVITE2_VERSION {
            return Err(quarantine(format!(
                "unsupported invite v2 version 0x{:02x}",
                bytes[15]
            )));
        }
        let fabric_id = FabricId(bytes[16..48].try_into().expect("slice len 32"));
        let invite_id = bytes[48..64].try_into().expect("slice len 16");
        let issuer = key_from_bytes(&bytes[64..96])?;
        let expires_at_ms = u64::from_be_bytes(bytes[96..104].try_into().expect("slice len 8"));
        let recipient = key_from_bytes(&bytes[104..136])?;
        let mut off = INVITE2_FIXED_LEN;
        let relay_count = bytes[off] as usize;
        off += 1;
        if relay_count > MAX_RELAYS_V2 {
            return Err(quarantine(format!(
                "{relay_count} relays exceeds the limit of {MAX_RELAYS_V2}"
            )));
        }
        let mut relays = Vec::with_capacity(relay_count);
        for i in 0..relay_count {
            if bytes.len() < off + 2 {
                return Err(trunc(&format!("relay {i} url length prefix")));
            }
            let url_len = u16::from_be_bytes([bytes[off], bytes[off + 1]]) as usize;
            off += 2;
            if url_len > MAX_RELAY_URL_BYTES {
                return Err(quarantine(format!(
                    "relay URL of {url_len} bytes exceeds the {MAX_RELAY_URL_BYTES} byte limit"
                )));
            }
            if bytes.len() < off + url_len {
                return Err(trunc(&format!("relay {i} url bytes")));
            }
            let url = std::str::from_utf8(&bytes[off..off + url_len])
                .map_err(|_| quarantine("relay URL is not valid UTF-8"))?
                .to_owned();
            off += url_len;
            if bytes.len() < off + 2 {
                return Err(trunc(&format!("relay {i} capability length prefix")));
            }
            let cap_len = u16::from_be_bytes([bytes[off], bytes[off + 1]]) as usize;
            off += 2;
            if cap_len > MAX_RELAY_CAP_BYTES {
                return Err(quarantine(format!(
                    "relay capability of {cap_len} bytes exceeds the {MAX_RELAY_CAP_BYTES} byte limit"
                )));
            }
            if bytes.len() < off + cap_len {
                return Err(trunc(&format!("relay {i} capability bytes")));
            }
            let capability = if cap_len == 0 {
                None
            } else {
                let cap = std::str::from_utf8(&bytes[off..off + cap_len])
                    .map_err(|_| quarantine("relay capability is not valid UTF-8"))?
                    .to_owned();
                off += cap_len;
                // 附录 A decode 期一致性：recipient 绑定 + TTL ≤ invite expires
                let parsed = RelayCapV1::decode(&cap)?;
                if parsed.recipient != recipient {
                    return Err(quarantine(
                        "relay capability recipient does not match the invite recipient".to_owned(),
                    ));
                }
                if parsed.expires_at > expires_at_ms {
                    return Err(quarantine(
                        "relay capability expires after the invite expires".to_owned(),
                    ));
                }
                Some(cap)
            };
            relays.push(InviteRelayV2 { url, capability });
        }
        if bytes.len() < off + 1 {
            return Err(trunc("direct addr count"));
        }
        let addr_count = bytes[off] as usize;
        off += 1;
        if addr_count > MAX_DIRECT_ADDRS {
            return Err(quarantine(format!(
                "{addr_count} direct addrs exceeds the limit of {MAX_DIRECT_ADDRS}"
            )));
        }
        let mut direct_addrs = Vec::with_capacity(addr_count);
        for i in 0..addr_count {
            if bytes.len() < off + 1 {
                return Err(trunc(&format!("direct addr {i} family tag")));
            }
            let family = bytes[off];
            off += 1;
            let addr = match family {
                ADDR_FAMILY_V4 => {
                    if bytes.len() < off + 4 + 2 {
                        return Err(trunc(&format!("direct addr {i} v4 bytes")));
                    }
                    let ip = std::net::Ipv4Addr::new(
                        bytes[off],
                        bytes[off + 1],
                        bytes[off + 2],
                        bytes[off + 3],
                    );
                    off += 4;
                    let port = u16::from_be_bytes([bytes[off], bytes[off + 1]]);
                    off += 2;
                    std::net::SocketAddr::new(ip.into(), port)
                }
                ADDR_FAMILY_V6 => {
                    if bytes.len() < off + 16 + 2 {
                        return Err(trunc(&format!("direct addr {i} v6 bytes")));
                    }
                    let octets: [u8; 16] = bytes[off..off + 16].try_into().expect("slice len 16");
                    off += 16;
                    let port = u16::from_be_bytes([bytes[off], bytes[off + 1]]);
                    off += 2;
                    std::net::SocketAddr::new(std::net::Ipv6Addr::from(octets).into(), port)
                }
                other => {
                    return Err(quarantine(format!(
                        "direct addr {i} has unknown family tag 0x{other:02x}"
                    )));
                }
            };
            direct_addrs.push(addr);
        }
        if bytes.len() != off {
            return Err(quarantine(format!(
                "invite v2 length mismatch: expected {off} bytes, got {}",
                bytes.len()
            )));
        }
        Ok(Self {
            fabric_id,
            invite_id,
            issuer,
            expires_at_ms,
            recipient,
            relays,
            direct_addrs,
        })
    }

    /// Whether the invite is expired at `now_ms`（与 v1 同语义：等值即过期）。
    pub fn is_expired(&self, now_ms: u64) -> bool {
        now_ms >= self.expires_at_ms
    }
}

/// An [`InviteV2`] plus the issuer's signature, rendered as the
/// `dweb2.<base64url-nopad>` token string（与 v1 令牌物理隔离）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InviteV2Token {
    pub invite: InviteV2,
    /// The issuer's signature over the invite's canonical bytes.
    pub signature: Signature,
}

impl InviteV2Token {
    /// Signs `invite` with `secret` (the issuer's key).
    pub fn sign(invite: InviteV2, secret: &SecretKey) -> Result<Self, ProtocolError> {
        let signature = secret.sign(&invite.canonical_bytes()?);
        Ok(Self { invite, signature })
    }

    /// Renders the token string: `dweb2.` + base64url-nopad of
    /// `InviteV2 canonical bytes || signature`。
    pub fn encode(&self) -> Result<String, ProtocolError> {
        let mut payload = self.invite.canonical_bytes()?;
        payload.extend_from_slice(&self.signature.to_bytes());
        Ok(format!(
            "{TOKEN2_PREFIX}{}",
            URL_SAFE_NO_PAD.encode(&payload)
        ))
    }

    /// Parses a `dweb2.` token string（域/版本/长度/签名/capability 一致性
    /// 全验；v1 串交由 [`InviteToken::decode`]，本函数对 `dweb1.` 前缀报
    /// Quarantine）。
    pub fn decode(s: &str) -> Result<Self, ProtocolError> {
        let b64 = s
            .strip_prefix(TOKEN2_PREFIX)
            .ok_or_else(|| quarantine(format!("token does not start with {TOKEN2_PREFIX:?}")))?;
        let payload = URL_SAFE_NO_PAD
            .decode(b64)
            .map_err(|e| quarantine(format!("token base64 decoding failed: {e}")))?;
        if payload.len() < Signature::LENGTH {
            return Err(quarantine(
                "token payload shorter than a signature".to_owned(),
            ));
        }
        let split = payload.len() - Signature::LENGTH;
        let invite = InviteV2::decode_strict(&payload[..split])?;
        let signature = Signature::from_bytes(payload[split..].try_into().expect("slice len 64"));
        let token = Self { invite, signature };
        token
            .verify()
            .map_err(|_| quarantine("invite v2 token signature verification failed".to_owned()))?;
        Ok(token)
    }

    /// Verifies the embedded signature against the embedded issuer id.
    pub fn verify(&self) -> Result<(), ProtocolError> {
        let bytes = self.invite.canonical_bytes()?;
        self.invite
            .issuer
            .verify(&bytes, &self.signature)
            .map_err(|_| quarantine("invite v2 signature verification failed".to_owned()))
    }

    /// Whether the invite is expired at `now_ms`.
    pub fn is_expired(&self, now_ms: u64) -> bool {
        self.invite.is_expired(now_ms)
    }
}

/// 按串前缀分派的版本化邀请令牌（附录 A2 兼容矩阵的实现载体）：
/// `dweb1.` → V1，`dweb2.` → V2；其余前缀 Quarantine。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InviteVersion {
    V1(InviteToken),
    V2(InviteV2Token),
}

impl InviteVersion {
    /// 前缀分派解码（两边各自完成全部校验）。
    pub fn decode(s: &str) -> Result<Self, ProtocolError> {
        if s.starts_with(TOKEN2_PREFIX) {
            Ok(Self::V2(InviteV2Token::decode(s)?))
        } else {
            Ok(Self::V1(InviteToken::decode(s)?))
        }
    }
}

/// The exact bytes the invitee must sign to prove possession of their
/// EndpointId's private key during redemption:
/// `b"dweb/redeem-pop/v1\0" || fabric_id || invite_id || challenge`.
pub fn redeem_challenge_bytes(
    fabric_id: &FabricId,
    invite_id: &[u8; 16],
    challenge: &[u8; 32],
) -> Vec<u8> {
    let mut out = Vec::with_capacity(POP_DOMAIN.len() + 32 + 16 + 32);
    out.extend_from_slice(POP_DOMAIN);
    out.extend_from_slice(fabric_id.as_bytes());
    out.extend_from_slice(invite_id);
    out.extend_from_slice(challenge);
    out
}

/// Parses 32 raw bytes into an `EndpointId`, rejecting non-key bytes.
fn key_from_bytes(bytes: &[u8]) -> Result<EndpointId, ProtocolError> {
    EndpointId::from_bytes(
        bytes
            .try_into()
            .map_err(|_| quarantine("key field is not 32 bytes".to_owned()))?,
    )
    .map_err(|_| quarantine("key field is not a valid Ed25519 public key".to_owned()))
}

fn hex_str(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

#[cfg(test)]
mod round3_regress {
    use super::*;

    fn mk_invite_bytes(tail_len: usize) -> Vec<u8> {
        // 域前缀 + 版本 + fabric/invite/issuer 定长段，尾部截到 tail_len
        let mut v = Vec::new();
        v.extend_from_slice(b"dweb/invite/v1\0");
        v.push(1);
        v.extend_from_slice(&[3u8; 32]);
        v.extend_from_slice(&[4u8; 16]);
        v.extend_from_slice(&[5u8; 32]);
        v.truncate(16 + 1 + tail_len.min(v.len() - 17));
        v
    }

    #[test]
    fn malformed_invite_never_panics_only_quarantine() {
        // 在固定头之后逐字节截断：任何前缀都必须 Err，绝不 panic
        let base = mk_invite_bytes(usize::MAX);
        for cut in 0..base.len() {
            let sliced = &base[..cut];
            let r = std::panic::catch_unwind(|| InviteV1::decode_strict(sliced));
            assert!(r.is_ok(), "panic at cut={cut}");
            assert!(r.unwrap().is_err(), "must error at cut={cut}");
        }
        // relay 长度前缀边界：截到刚好缺 2 字节
        let mut b = base.clone();
        b.truncate(INVITE_FIXED_LEN);
        assert!(InviteV1::decode_strict(&b).is_err());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::endpoint_id_display;

    fn idty(seed: u8) -> NodeIdentity {
        NodeIdentity::from_seed([seed; 32])
    }

    fn sample_fact(display_name: Option<String>, expires_at_ms: Option<u64>) -> Fact {
        let issuer = idty(1);
        let subject = idty(2);
        Fact {
            kind: FactKind::Grant,
            fabric_id: FabricId::from_name("test-fabric"),
            issuer: issuer.endpoint_id(),
            subject: subject.endpoint_id(),
            display_name,
            issued_at_ms: 1_700_000_000_123,
            expires_at_ms,
            target_fact_id: None,
        }
    }

    #[test]
    fn canonical_bytes_are_deterministic_across_construction_paths() {
        // Path 1: literal struct with a &str-derived name.
        let f1 = sample_fact(Some("卡罗尔".to_owned()), Some(999));
        // Path 2: same field values, different String allocation.
        let f2 = {
            let mut f = f1.clone();
            f.display_name = Some(format!("卡{}", "罗尔"));
            f.expires_at_ms = Some(900 + 99);
            f
        };
        // Path 3: decode(encode(f1)) then re-encode.
        let f3 = Fact::decode_strict(&f1.canonical_bytes().unwrap()).unwrap();

        let b1 = f1.canonical_bytes().unwrap();
        assert_eq!(b1, f2.canonical_bytes().unwrap());
        assert_eq!(b1, f3.canonical_bytes().unwrap());
    }

    #[test]
    fn canonical_layout_offsets_match_documentation() {
        let f = sample_fact(Some("ab".to_owned()), None);
        let b = f.canonical_bytes().unwrap();
        assert_eq!(&b[0..13], b"dweb/fact/v1\0");
        assert_eq!(b[13], KIND_GRANT);
        assert_eq!(&b[14..46], f.fabric_id.as_bytes());
        assert_eq!(&b[46..78], f.issuer.as_bytes());
        assert_eq!(&b[78..110], f.subject.as_bytes());
        assert_eq!(
            u64::from_be_bytes(b[110..118].try_into().unwrap()),
            f.issued_at_ms
        );
        assert_eq!(b[118], FLAG_HAS_NAME);
        assert_eq!(u16::from_be_bytes(b[119..121].try_into().unwrap()), 2);
        assert_eq!(&b[121..123], b"ab");
        assert_eq!(b.len(), FACT_FIXED_LEN + 2 + 2);

        // No optionals at all.
        let bare = sample_fact(None, None).canonical_bytes().unwrap();
        assert_eq!(bare.len(), FACT_FIXED_LEN);
        assert_eq!(bare[118], 0);
        // Only expiry.
        let exp_only = sample_fact(None, Some(7)).canonical_bytes().unwrap();
        assert_eq!(exp_only.len(), FACT_FIXED_LEN + 8);
        assert_eq!(exp_only[118], FLAG_HAS_EXPIRY);
        // Only target (Revoke shape).
        let mut target_only = sample_fact(None, None);
        target_only.kind = FactKind::Revoke;
        target_only.target_fact_id = Some([9u8; 32]);
        let t = target_only.canonical_bytes().unwrap();
        assert_eq!(t.len(), FACT_FIXED_LEN + 32);
        assert_eq!(t[118], FLAG_HAS_TARGET);
        assert_eq!(&t[FACT_FIXED_LEN..FACT_FIXED_LEN + 32], &[9u8; 32]);
    }

    #[test]
    fn fact_id_is_content_addressed_and_idempotent() {
        let f = sample_fact(Some("n".to_owned()), None);
        let g = sample_fact(Some("n".to_owned()), None);
        // Same content -> same id, any number of times (idempotent).
        assert_eq!(f.fact_id(), g.fact_id());
        assert_eq!(f.fact_id(), f.fact_id());
        // Any field change -> different id.
        for mutated in [
            Fact {
                issued_at_ms: f.issued_at_ms + 1,
                ..f.clone()
            },
            Fact {
                display_name: Some("m".to_owned()),
                ..f.clone()
            },
            Fact {
                kind: FactKind::Join,
                ..f.clone()
            },
            Fact {
                fabric_id: FabricId::from_name("other"),
                ..f.clone()
            },
        ] {
            assert_ne!(f.fact_id(), mutated.fact_id());
        }
        // Id equals BLAKE3 of the canonical bytes.
        assert_eq!(
            f.fact_id(),
            *blake3::hash(&f.canonical_bytes().unwrap()).as_bytes()
        );
    }

    #[test]
    fn canonical_roundtrip_all_option_combinations() {
        for name in [None, Some("名字".to_owned()), Some(String::new())] {
            for exp in [None, Some(u64::MAX), Some(0)] {
                for target in [None, Some([5u8; 32]), Some([0u8; 32])] {
                    let f = Fact {
                        display_name: name.clone(),
                        expires_at_ms: exp,
                        target_fact_id: target,
                        ..sample_fact(None, None)
                    };
                    let b = f.canonical_bytes().unwrap();
                    let back = Fact::decode_strict(&b).unwrap();
                    assert_eq!(back, f, "roundtrip failed for {f:?}");
                }
            }
        }
    }

    #[test]
    fn decode_rejects_non_canonical_and_corrupt_bytes() {
        let good = sample_fact(Some("name".to_owned()), Some(5))
            .canonical_bytes()
            .unwrap();

        // Truncation at every length.
        for len in 0..good.len() {
            assert!(
                Fact::decode_strict(&good[..len]).is_err(),
                "decoding {len} bytes should fail"
            );
        }

        // Trailing garbage.
        let mut trailing = good.clone();
        trailing.push(0);
        assert!(Fact::decode_strict(&trailing).is_err());

        // Bad domain / kind / flags.
        for (pos, bad) in [
            (0, b"XWEB/FACT/V1".to_vec()),
            (13, vec![0x00]),
            (13, vec![0x05]),
            (13, vec![0xff]),
            (118, vec![0b1000_0000]),
            (118, vec![0xff]),
        ] {
            let mut m = good.clone();
            m[pos..pos + bad.len()].copy_from_slice(&bad);
            let err = Fact::decode_strict(&m).unwrap_err();
            assert!(
                matches!(err, ProtocolError::Quarantine { .. }),
                "pos {pos} bad {bad:?} gave {err:?}"
            );
        }

        // Name length lying about the actual content length.
        let mut liar = good.clone();
        liar[119] = 0xff;
        liar[120] = 0xff;
        assert!(Fact::decode_strict(&liar).is_err());

        // Non-UTF-8 name bytes.
        let mut bad_utf8 = good.clone();
        bad_utf8[121] = 0xff;
        bad_utf8[122] = 0xfe;
        assert!(Fact::decode_strict(&bad_utf8).is_err());
    }

    #[test]
    fn oversized_name_is_rejected() {
        let mut f = sample_fact(None, None);
        f.display_name = Some("x".repeat(MAX_NAME_BYTES + 1));
        assert!(matches!(
            f.canonical_bytes(),
            Err(ProtocolError::Encoding(_))
        ));
        // The decode side also enforces the cap.
        let mut ok = sample_fact(Some("y".repeat(MAX_NAME_BYTES)), None)
            .canonical_bytes()
            .unwrap();
        // Rewrite the length prefix to claim MAX+1 with truncated body.
        let n = MAX_NAME_BYTES + 1;
        ok[119..121].copy_from_slice(&(n as u16).to_be_bytes());
        ok.truncate(119 + 2 + MAX_NAME_BYTES);
        assert!(matches!(
            Fact::decode_strict(&ok),
            Err(ProtocolError::Quarantine { .. })
        ));
    }

    #[test]
    fn sign_and_verify_roundtrip() {
        let issuer = idty(1);
        let f = sample_fact(None, None);
        let sf = SignedFact::sign(f.clone(), issuer.secret_key()).unwrap();
        sf.verify().unwrap();

        // Any other key fails.
        let other = idty(3);
        let mut forged = sf.clone();
        forged.signature = other.secret_key().sign(&f.canonical_bytes().unwrap());
        assert!(forged.verify().is_err());
    }

    #[test]
    fn tampered_fact_or_signature_fails_verification() {
        let issuer = idty(1);
        let base = sample_fact(Some("n".to_owned()), Some(10));
        let sf = SignedFact::sign(base.clone(), issuer.secret_key()).unwrap();

        // Tamper with each field of the fact: the signature must stop matching.
        for mutated in [
            Fact {
                kind: FactKind::Revoke,
                ..base.clone()
            },
            Fact {
                fabric_id: FabricId::from_name("evil"),
                ..base.clone()
            },
            Fact {
                issuer: idty(4).endpoint_id(),
                ..base.clone()
            },
            Fact {
                subject: idty(5).endpoint_id(),
                ..base.clone()
            },
            Fact {
                display_name: Some("evil".to_owned()),
                ..base.clone()
            },
            Fact {
                issued_at_ms: base.issued_at_ms + 1,
                ..base.clone()
            },
            Fact {
                expires_at_ms: Some(11),
                ..base.clone()
            },
            Fact {
                target_fact_id: Some([1u8; 32]),
                ..base.clone()
            },
        ] {
            let t = SignedFact {
                fact: mutated,
                signature: sf.signature,
            };
            let err = t.verify().unwrap_err();
            assert!(
                matches!(err, ProtocolError::Quarantine { .. }),
                "tampered fact must quarantine, got {err:?}"
            );
        }

        // Tampered signature bytes.
        let mut bad_sig = sf.signature.to_bytes();
        bad_sig[0] ^= 1;
        let t = SignedFact {
            fact: base,
            signature: Signature::from_bytes(&bad_sig),
        };
        assert!(t.verify().is_err());
    }

    #[test]
    fn signed_fact_wire_roundtrip_and_strictness() {
        let issuer = idty(1);
        let f = sample_fact(Some("w".to_owned()), None);
        let sf = SignedFact::sign(f, issuer.secret_key()).unwrap();
        let wire = sf.encode().unwrap();
        let back = SignedFact::decode(&wire).unwrap();
        assert_eq!(back, sf);
        assert!(back.verify().is_ok());

        // Truncated / trailing.
        assert!(SignedFact::decode(&wire[..wire.len() - 1]).is_err());
        let mut trailing = wire.clone();
        trailing.push(0);
        assert!(SignedFact::decode(&trailing).is_err());
        // Lying length prefix (overshoot and undershoot).
        let mut liar = wire.clone();
        liar[3] += 10;
        assert!(SignedFact::decode(&liar).is_err());
        let mut liar2 = wire;
        liar2[3] -= 1;
        assert!(SignedFact::decode(&liar2).is_err());
    }

    #[test]
    fn signed_fact_list_roundtrip() {
        let issuer = idty(1);
        let facts: Vec<SignedFact> = (0..5)
            .map(|i| {
                let f = Fact {
                    display_name: Some(format!("m{i}")),
                    issued_at_ms: i,
                    expires_at_ms: Some(i),
                    ..sample_fact(None, None)
                };
                SignedFact::sign(f, issuer.secret_key()).unwrap()
            })
            .collect();
        let bytes = SignedFact::encode_all(&facts).unwrap();
        let back = SignedFact::decode_all(&bytes).unwrap();
        assert_eq!(back, facts);
        // Trailing garbage rejected.
        let mut bad = bytes.clone();
        bad.push(1);
        assert!(SignedFact::decode_all(&bad).is_err());
        // Count lying.
        let mut liar = bytes;
        liar[3] += 10;
        assert!(SignedFact::decode_all(&liar).is_err());
    }

    #[test]
    fn genesis_helper_builds_self_signed_root_fact() {
        let root = idty(1);
        let fid = FabricId::from_name("genesis-test");
        let g = genesis(&root, fid, 42).unwrap();
        assert_eq!(g.fact.kind, FactKind::Genesis);
        assert_eq!(g.fact.issuer, root.endpoint_id());
        assert_eq!(g.fact.subject, root.endpoint_id());
        assert_eq!(g.fact.fabric_id, fid);
        assert_eq!(g.fact.issued_at_ms, 42);
        assert!(g.fact.expires_at_ms.is_none());
        g.verify().unwrap();
    }

    #[test]
    fn fabric_id_derivation() {
        assert_eq!(FabricId::from_name("home"), FabricId::from_name("home"));
        assert_ne!(FabricId::from_name("home"), FabricId::from_name("away"));
        assert_ne!(FabricId::random(), FabricId::random());
    }

    fn sample_invite(recipient: Option<EndpointId>) -> InviteV1 {
        InviteV1 {
            fabric_id: FabricId::from_name("invite-test"),
            invite_id: [7u8; 16],
            issuer: idty(1).endpoint_id(),
            issuer_relay_url: "https://relay.example.com".to_owned(),
            issuer_direct_addrs: vec!["192.168.1.4:1234".to_owned()],
            expires_at_ms: 60_000,
            recipient,
        }
    }

    #[test]
    fn invite_token_roundtrip() {
        let issuer = idty(1);
        let invite = sample_invite(Some(idty(2).endpoint_id()));
        let token = InviteToken::sign(invite.clone(), issuer.secret_key()).unwrap();

        let s = token.encode().unwrap();
        assert!(s.starts_with("dweb1."));
        assert!(
            !s.contains('+') && !s.contains('/') && !s.contains('='),
            "base64url-nopad only"
        );
        let back = InviteToken::decode(&s).unwrap();
        assert_eq!(back, token);
        assert!(back.verify().is_ok());
        assert_eq!(back.invite, invite);
        assert!(!back.is_expired(59_999));
        assert!(back.is_expired(60_000), "expired at the exact instant");
    }

    #[test]
    fn invite_decode_rejects_malformed_strings_and_bad_signatures() {
        let issuer = idty(1);
        let token = InviteToken::sign(sample_invite(None), issuer.secret_key()).unwrap();
        let good = token.encode().unwrap();

        // Wrong / missing prefix, non-base64, truncation.
        assert!(InviteToken::decode(&good[1..]).is_err());
        assert!(InviteToken::decode(&good.replace("dweb1.", "dweb2.")).is_err());
        assert!(InviteToken::decode(&format!("{TOKEN_PREFIX}!!!!")).is_err());
        assert!(InviteToken::decode(&good[..good.len() - 8]).is_err());

        let raw = URL_SAFE_NO_PAD
            .decode(good.strip_prefix(TOKEN_PREFIX).unwrap())
            .unwrap();
        // Structural corruption: flip a byte inside the domain header.
        let mut evil = raw.clone();
        evil[0] = b'X';
        assert!(
            InviteToken::decode(&format!("{TOKEN_PREFIX}{}", URL_SAFE_NO_PAD.encode(evil)))
                .is_err()
        );
        // Tampered payload byte: structure still parses, signature must fail.
        let mut evil = raw;
        let body_len = evil.len() - Signature::LENGTH;
        evil[body_len - 1] ^= 1;
        assert!(
            InviteToken::decode(&format!("{TOKEN_PREFIX}{}", URL_SAFE_NO_PAD.encode(evil)))
                .is_err(),
            "tampered invite must fail signature check at decode"
        );
        // A second valid key signing over the same bytes must not verify
        // against the embedded issuer.
        let mut other_signed = token.clone();
        other_signed.signature = idty(9)
            .secret_key()
            .sign(&token.invite.canonical_bytes().unwrap());
        assert!(other_signed.verify().is_err());
    }

    #[test]
    fn invite_limits_are_enforced() {
        // Too many direct addrs.
        let mut inv = sample_invite(None);
        inv.issuer_direct_addrs = (0..=MAX_DIRECT_ADDRS)
            .map(|i| format!("10.0.0.1:{i}"))
            .collect();
        assert!(matches!(
            inv.canonical_bytes(),
            Err(ProtocolError::Encoding(_))
        ));
        // One addr too long.
        let mut inv = sample_invite(None);
        inv.issuer_direct_addrs = vec!["x".repeat(MAX_DIRECT_ADDR_BYTES + 1)];
        assert!(matches!(
            inv.canonical_bytes(),
            Err(ProtocolError::Encoding(_))
        ));
        // Relay URL too long.
        let mut inv = sample_invite(None);
        inv.issuer_relay_url = "x".repeat(MAX_RELAY_URL_BYTES + 1);
        assert!(matches!(
            inv.canonical_bytes(),
            Err(ProtocolError::Encoding(_))
        ));
        // max_uses tampering on the wire is rejected by decode.
        let issuer = idty(1);
        let token = InviteToken::sign(sample_invite(None), issuer.secret_key()).unwrap();
        let raw = URL_SAFE_NO_PAD
            .decode(token.encode().unwrap().strip_prefix(TOKEN_PREFIX).unwrap())
            .unwrap();
        let mut evil = raw;
        let last = evil.len() - Signature::LENGTH - 1; // max_uses byte
        evil[last] = 2;
        assert!(
            InviteToken::decode(&format!("{TOKEN_PREFIX}{}", URL_SAFE_NO_PAD.encode(evil)))
                .is_err()
        );
    }

    #[test]
    fn pop_challenge_material_is_domain_separated() {
        let fid = FabricId::from_name("pop-test");
        let iid = [3u8; 16];
        let challenge = [4u8; 32];
        let bytes = redeem_challenge_bytes(&fid, &iid, &challenge);
        assert_eq!(&bytes[..POP_DOMAIN.len()], POP_DOMAIN);
        let after_domain = POP_DOMAIN.len();
        assert_eq!(
            &bytes[after_domain..after_domain + 32],
            fid.as_bytes(),
            "fabric_id follows the domain"
        );
        assert_eq!(
            &bytes[after_domain + 32..after_domain + 48],
            iid,
            "invite_id follows the fabric_id"
        );
        assert_eq!(
            &bytes[after_domain + 48..],
            challenge,
            "challenge is the tail"
        );
        assert_eq!(bytes.len(), POP_DOMAIN.len() + 32 + 16 + 32);
        // Different fabric or invite or challenge -> different bytes.
        assert_ne!(
            bytes,
            redeem_challenge_bytes(&FabricId::from_name("other"), &iid, &challenge)
        );
        assert_ne!(bytes, redeem_challenge_bytes(&fid, &[0u8; 16], &challenge));
        assert_ne!(bytes, redeem_challenge_bytes(&fid, &iid, &[0u8; 32]));

        // B signs the material; anyone with B's public key verifies.
        let b = idty(2);
        let sig = b.secret_key().sign(&bytes);
        b.endpoint_id().verify(&bytes, &sig).unwrap();
        assert!(idty(3).endpoint_id().verify(&bytes, &sig).is_err());
    }

    #[test]
    fn debug_json_projection_mentions_content_address() {
        let issuer = idty(1);
        let sf = SignedFact::sign(
            sample_fact(Some("名字".to_owned()), Some(42)),
            issuer.secret_key(),
        )
        .unwrap();
        let json = sf.to_json_string().unwrap();
        assert!(json.contains(&hex_str(&sf.fact_id())));
        assert!(json.contains(&endpoint_id_display(&sf.fact.issuer)));
    }

    // ==== server-access-policy Phase 2：RelayCapV1 / InviteV2（tasks 2.1/2.3） ====

    /// 与 dweb-server cap.rs 跨 crate 冻结向量共用的一组固定输入
    ///（两侧字面量逐字节一致；任一侧布局/域分隔/编码漂移即红）。
    fn cross_crate_inputs() -> (FabricId, [u8; 32], EndpointId, u8, u64, u64) {
        let fabric_id = FabricId([3u8; 32]);
        let server_id = [2u8; 32];
        // recipient：dalek SigningKey::from_bytes(&[4u8;32]) 的公钥——
        // 由 iroh SecretKey::from_bytes 同种子派生，两栈逐字节一致。
        let recipient = SecretKey::from_bytes(&[4u8; 32]).public();
        (
            fabric_id,
            server_id,
            recipient,
            CAP_KNOWN_MASK,
            1_800_000_000_000,
            1_800_003_600_000,
        )
    }

    #[test]
    fn relay_cap_roundtrip_and_frozen_shape() {
        let signer = SecretKey::from_bytes(&[1u8; 32]);
        let (fabric_id, server_id, recipient, caps, issued, expires) = cross_crate_inputs();
        let token = RelayCapV1::sign_and_encode(
            &signer, &fabric_id, &server_id, &recipient, caps, issued, expires,
        )
        .unwrap();
        // 形状冻结（design §11.1）：287 字符 = "dwebr1."(7) + base64url(280)
        assert_eq!(token.len(), RELAY_CAP_TOKEN_LEN);
        assert_eq!(RELAY_CAP_TOKEN_LEN, 287);
        let parsed = RelayCapV1::decode(&token).unwrap();
        assert_eq!(parsed.fabric_id, fabric_id);
        assert_eq!(parsed.server_id, server_id);
        assert_eq!(parsed.issuer, signer.public());
        assert_eq!(parsed.recipient, recipient);
        assert_eq!(parsed.caps, caps);
        assert_eq!(parsed.issued_at, issued);
        assert_eq!(parsed.expires_at, expires);
    }

    #[test]
    fn relay_cap_cross_crate_vector() {
        // 向量由 dweb-server access::cap::sign_and_encode（dalek SigningKey）
        // 生成并双侧硬编码：fabric 侧（iroh SecretKey 同种子）必须产出逐字节
        // 相等的串——Ed25519 确定性签名 + 同 canonical/域前缀下二者必然一致。
        let signer = SecretKey::from_bytes(&[1u8; 32]);
        let (fabric_id, server_id, recipient, caps, issued, expires) = cross_crate_inputs();
        let token = RelayCapV1::sign_and_encode(
            &signer, &fabric_id, &server_id, &recipient, caps, issued, expires,
        )
        .unwrap();
        assert_eq!(token, crate::CROSS_CRATE_CAP_VECTOR);
    }

    #[test]
    fn relay_cap_encode_rejects_out_of_policy_inputs() {
        let signer = SecretKey::from_bytes(&[1u8; 32]);
        let (fabric_id, server_id, recipient, caps, issued, expires) = cross_crate_inputs();
        // 保留位
        assert!(
            RelayCapV1::sign_and_encode(
                &signer,
                &fabric_id,
                &server_id,
                &recipient,
                caps | 0x40,
                issued,
                expires
            )
            .is_err()
        );
        // TTL 超 180d（恰 180d+1ms；180d 整在 token_shape 语义内合法）
        assert!(
            RelayCapV1::sign_and_encode(
                &signer,
                &fabric_id,
                &server_id,
                &recipient,
                caps,
                issued,
                issued + RELAY_CAP_MAX_TTL_MS + 1,
            )
            .is_err()
        );
        // issued_at > expires_at
        assert!(
            RelayCapV1::sign_and_encode(
                &signer, &fabric_id, &server_id, &recipient, caps, expires, issued
            )
            .is_err()
        );
    }

    #[test]
    fn relay_cap_decode_rejects_malformed() {
        let signer = SecretKey::from_bytes(&[1u8; 32]);
        let (fabric_id, server_id, recipient, caps, issued, expires) = cross_crate_inputs();
        let token = RelayCapV1::sign_and_encode(
            &signer, &fabric_id, &server_id, &recipient, caps, issued, expires,
        )
        .unwrap();
        // 坏前缀 / 空串 / 截断 / 加 pad / 超长
        assert!(RelayCapV1::decode("dwebr2.aaaa").is_err());
        assert!(RelayCapV1::decode("").is_err());
        assert!(RelayCapV1::decode(&token[..token.len() - 1]).is_err());
        assert!(RelayCapV1::decode(&format!("{token}=")).is_err());
        assert!(
            RelayCapV1::decode(&format!("{RELAY_CAP_TOKEN_PREFIX}{}", "A".repeat(2048))).is_err()
        );
        // 篡改 caps 保留位（改 wire 129 字节后重编码——非 dwebr1. 字符集仍合法，
        // 但 decode 的保留位门拒绝）
        let payload = token.strip_prefix(RELAY_CAP_TOKEN_PREFIX).unwrap();
        let mut wire = [0u8; 210];
        URL_SAFE_NO_PAD.decode_slice(payload, &mut wire).unwrap();
        wire[129] = 0xFF;
        let tampered = format!("{RELAY_CAP_TOKEN_PREFIX}{}", URL_SAFE_NO_PAD.encode(wire));
        assert!(RelayCapV1::decode(&tampered).is_err());
    }

    fn invite_v2_sample() -> (InviteV2, NodeIdentity) {
        let issuer = idty(7);
        let recipient = idty(8);
        let cap = RelayCapV1::sign_and_encode(
            issuer.secret_key(),
            &FabricId::from_name("v2-fabric"),
            &[2u8; 32],
            &recipient.endpoint_id(),
            MEMBER_CAPS,
            1_700_000_000_000,
            1_700_000_000_000 + 60_000,
        )
        .unwrap();
        let invite = InviteV2 {
            fabric_id: FabricId::from_name("v2-fabric"),
            invite_id: [0xAB; 16],
            issuer: issuer.endpoint_id(),
            expires_at_ms: 1_700_000_000_000 + 120_000,
            recipient: recipient.endpoint_id(),
            relays: vec![
                InviteRelayV2 {
                    url: "https://relay-a.example".to_owned(),
                    capability: Some(cap),
                },
                InviteRelayV2 {
                    url: "https://relay-b.example".to_owned(),
                    capability: None,
                },
            ],
            direct_addrs: vec![
                "192.168.1.10:53210".parse().unwrap(),
                "[fd00::1]:443".parse().unwrap(),
            ],
        };
        (invite, issuer)
    }

    #[test]
    fn invite_v2_token_roundtrip() {
        let (invite, issuer) = invite_v2_sample();
        let token = InviteV2Token::sign(invite.clone(), issuer.secret_key()).unwrap();
        let s = token.encode().unwrap();
        assert!(s.starts_with("dweb2."));
        let back = InviteV2Token::decode(&s).unwrap();
        assert_eq!(back, token);
        assert_eq!(back.invite, invite);
        // 篡改任一字段 → 签名验证失败
        let mut bad = token.clone();
        bad.invite.expires_at_ms += 1;
        assert!(bad.verify().is_err());
        assert!(InviteV2Token::decode(&bad.encode().unwrap()).is_err());
    }

    /// 附录 A 布局逐字节核对（域/版本/定长段偏移/relay 条目/二进制 SocketAddr）。
    #[test]
    fn invite_v2_layout_offsets_match_appendix_a() {
        let (invite, issuer) = invite_v2_sample();
        let b = invite.canonical_bytes().unwrap();
        assert_eq!(&b[0..15], b"dweb/invite/v2\0");
        assert_eq!(b[15], 0x02);
        assert_eq!(&b[16..48], invite.fabric_id.as_bytes());
        assert_eq!(&b[48..64], &invite.invite_id);
        assert_eq!(&b[64..96], invite.issuer.as_bytes());
        assert_eq!(
            u64::from_be_bytes(b[96..104].try_into().unwrap()),
            invite.expires_at_ms
        );
        assert_eq!(&b[104..136], invite.recipient.as_bytes());
        assert_eq!(b[136], 2, "relay_count");
        // relay[0]：u16 url_len + url + u16 cap_len + cap 串原始字节
        let mut off = 137usize;
        let url_len = u16::from_be_bytes(b[off..off + 2].try_into().unwrap()) as usize;
        assert_eq!(url_len, "https://relay-a.example".len());
        assert_eq!(&b[off + 2..off + 2 + url_len], b"https://relay-a.example");
        off += 2 + url_len;
        let cap = invite.relays[0].capability.as_ref().unwrap();
        let cap_len = u16::from_be_bytes(b[off..off + 2].try_into().unwrap()) as usize;
        assert_eq!(cap_len, cap.len());
        assert_eq!(&b[off + 2..off + 2 + cap_len], cap.as_bytes());
        off += 2 + cap_len;
        // relay[1]：无凭证（cap_len == 0）
        let url_len_b = u16::from_be_bytes(b[off..off + 2].try_into().unwrap()) as usize;
        off += 2 + url_len_b;
        assert_eq!(
            u16::from_be_bytes(b[off..off + 2].try_into().unwrap()),
            0,
            "cap_len == 0 for capability-less relay"
        );
        off += 2;
        // direct addrs：family(4/6) + addr + u16 port BE
        assert_eq!(b[off], 2, "addr_count");
        off += 1;
        assert_eq!(b[off], 4, "IPv4 family tag");
        assert_eq!(&b[off + 1..off + 5], &[192, 168, 1, 10]);
        assert_eq!(
            u16::from_be_bytes(b[off + 5..off + 7].try_into().unwrap()),
            53210
        );
        off += 7;
        assert_eq!(b[off], 6, "IPv6 family tag");
        assert_eq!(
            &b[off + 1..off + 17],
            &[0xfd, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]
        );
        assert_eq!(
            u16::from_be_bytes(b[off + 17..off + 19].try_into().unwrap()),
            443
        );
        assert_eq!(b.len(), off + 19);
        // issuer 签名可验证（域分隔输入 = canonical bytes）
        assert!(
            invite
                .issuer
                .verify(&b, &issuer.secret_key().sign(&b))
                .is_ok()
        );
    }

    /// decode 期一致性负例：capability recipient ≠ 令牌 recipient / capability
    /// expires 晚于令牌 expires → 整令牌 Quarantine（canonical_bytes 在编码期
    /// 同规拒绝，此处以手工拼装字节直击解码路径）。
    #[test]
    fn invite_v2_decode_rejects_inconsistent_capabilities() {
        let (invite, issuer) = invite_v2_sample();
        let base = invite.canonical_bytes().unwrap();
        let fabric_id = invite.fabric_id;
        let server_id = [2u8; 32];
        // victim：recipient 错绑（发给 idty(9) 的 cap 嵌进发给 idty(8) 的令牌）
        let wrong_recipient_cap = RelayCapV1::sign_and_encode(
            issuer.secret_key(),
            &fabric_id,
            &server_id,
            &idty(9).endpoint_id(),
            MEMBER_CAPS,
            1_700_000_000_000,
            invite.expires_at_ms,
        )
        .unwrap();
        // victim：expires 晚于 invite
        let late_cap = RelayCapV1::sign_and_encode(
            issuer.secret_key(),
            &fabric_id,
            &server_id,
            &invite.recipient,
            MEMBER_CAPS,
            1_700_000_000_000,
            invite.expires_at_ms + 1,
        )
        .unwrap();
        for (name, cap) in [
            ("wrong-recipient", wrong_recipient_cap),
            ("late-expiry", late_cap),
        ] {
            // 重拼 relay[0] 条目（其余字节与合法 base 一致）
            let mut bytes = Vec::new();
            bytes.extend_from_slice(&base[..137]);
            let url = "https://relay-a.example";
            bytes.extend_from_slice(&(url.len() as u16).to_be_bytes());
            bytes.extend_from_slice(url.as_bytes());
            bytes.extend_from_slice(&(cap.len() as u16).to_be_bytes());
            bytes.extend_from_slice(cap.as_bytes());
            bytes.extend_from_slice(&base[137 + 2 + url.len() + 2 + 287..]);
            assert!(
                InviteV2::decode_strict(&bytes).is_err(),
                "{name}: decode must quarantine"
            );
            // 编码期同规：把同一 cap 塞回结构体也要在 canonical_bytes 拒绝
            let mut bad_invite = invite.clone();
            bad_invite.relays[0].capability = Some(cap);
            assert!(
                bad_invite.canonical_bytes().is_err(),
                "{name}: encode must fail fast"
            );
        }
    }

    #[test]
    fn invite_v2_limits_enforced() {
        let (invite, issuer) = invite_v2_sample();
        // relay_count > 8
        let mut many = invite.clone();
        many.relays = (0..9)
            .map(|i| InviteRelayV2 {
                url: format!("https://r{i}.example"),
                capability: None,
            })
            .collect();
        assert!(many.canonical_bytes().is_err());
        assert!(InviteV2Token::sign(many.clone(), issuer.secret_key()).is_err());
        // 手工拼装 9 条同样在 decode 被拒（编码门之外的防线）
        let mut bytes = invite.canonical_bytes().unwrap();
        bytes[136] = 9;
        assert!(InviteV2::decode_strict(&bytes).is_err());
        // addr_count > 4
        let mut addrs = invite.clone();
        addrs.direct_addrs = (0..5)
            .map(|i| format!("10.0.0.{i}:80").parse().unwrap())
            .collect();
        assert!(addrs.canonical_bytes().is_err());
        // url 超 2048B
        let mut long_url = invite.clone();
        long_url.relays[0].url = "x".repeat(2049);
        assert!(long_url.canonical_bytes().is_err());
    }

    /// v1/v2 前缀分派矩阵（附录 A2）：v1 解码器对 dweb2. 报
    /// UnsupportedInviteVersion（第九码来源）；v2 解码器对 dweb1. 报
    /// Quarantine；InviteVersion 按前缀分派。
    #[test]
    fn invite_prefix_dispatch_and_v1_isolation() {
        let (invite, issuer) = invite_v2_sample();
        let v2_str = InviteV2Token::sign(invite, issuer.secret_key())
            .unwrap()
            .encode()
            .unwrap();
        // v1 路径拒绝 v2 令牌：UnsupportedInviteVersion（非 Quarantine）
        match InviteToken::decode(&v2_str) {
            Err(ProtocolError::UnsupportedInviteVersion(msg)) => {
                assert!(msg.contains("upgrade"), "错误信息含升级指引: {msg}");
            }
            other => panic!("expected UnsupportedInviteVersion, got {other:?}"),
        }
        // v2 解码器拒绝 v1 令牌（Quarantine——前缀不是 v2）
        let v1 = sample_v1_token();
        let v1_str = v1.encode().unwrap();
        assert!(matches!(
            InviteV2Token::decode(&v1_str),
            Err(ProtocolError::Quarantine { .. })
        ));
        // InviteVersion 分派：dweb1. → V1，dweb2. → V2
        match InviteVersion::decode(&v1_str) {
            Ok(InviteVersion::V1(t)) => assert_eq!(t, v1),
            other => panic!("expected V1, got {other:?}"),
        }
        match InviteVersion::decode(&v2_str) {
            Ok(InviteVersion::V2(_)) => {}
            other => panic!("expected V2, got {other:?}"),
        }
    }

    /// decode_all_prefix：事实段定界 + 尾部交给 OK2 段（附录 A2）。
    #[test]
    fn decode_all_prefix_returns_consumed_offset() {
        let issuer = idty(1);
        let facts: Vec<SignedFact> = (0..2)
            .map(|_| {
                SignedFact::sign(sample_fact(Some("n".to_owned()), None), issuer.secret_key())
                    .unwrap()
            })
            .collect();
        let mut payload = SignedFact::encode_all(&facts).unwrap();
        let payload_len = payload.len();
        payload.extend_from_slice(&[0, 0, 0, 0]); // 模拟 OK2 cap 段（count=0）
        let (parsed, consumed) = SignedFact::decode_all_prefix(&payload).unwrap();
        assert_eq!(parsed.len(), 2);
        assert_eq!(consumed, payload_len, "facts end exactly before the tail");
        // decode_all 对同一输入仍拒绝尾随字节（v1 回归不变）
        assert!(SignedFact::decode_all(&payload).is_err());
    }

    fn sample_v1_token() -> InviteToken {
        let issuer = idty(5);
        let invite = InviteV1 {
            fabric_id: FabricId::from_name("v1-fabric"),
            invite_id: [0xCD; 16],
            issuer: issuer.endpoint_id(),
            issuer_relay_url: "https://relay.example".to_owned(),
            issuer_direct_addrs: vec![],
            expires_at_ms: 1_700_000_000_000 + 60_000,
            recipient: None,
        };
        InviteToken::sign(invite, issuer.secret_key()).unwrap()
    }
}
