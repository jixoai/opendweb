//! continuity wire 帧编解码（app-protocol-layer Phase 0 task 1.1）。
//!
//! 契约来源：openspec/changes/app-protocol-layer/design.md §2.2（48B 公共头）。
//! 冻结决定（本模块引入，fixture 一致性的单一权威）：
//! - 大端序；`magic = b"DWS1"`；`wire_version = 1`；`header_len 恒 48`；
//!   `reserved 必须为 0`。
//! - 单帧 payload 上限 `MAX_FRAME = 1 MiB`（超限按连接级协议违规处理）。
//! - `stream_id == 0` 仅允许控制帧（握手/PING 族/SESSION 族）；业务帧
//!   （OPEN 族/DATA/ACK/FIN/RESET）必须非零。
//! - 未知 frame_type / 未知 flags 位：**严格拒绝**（解码错误）——升级用新
//!   wire_version 表达，不留静默跳过路径。
//! - 控制帧不携带 byte_offset 语义（字段置 0）；DATA/ACK 的 byte_offset 由
//!   模型层（model.rs）赋予含义，编解码层只做透传与基本域校验。

use bytes::{Buf, BufMut, Bytes, BytesMut};

/// 单帧 payload 上限（design §2.1：最大单帧 1 MiB）。
pub const MAX_FRAME: usize = 1024 * 1024;
/// 公共头长度（冻结值）。
pub const HEADER_LEN: usize = 48;
/// wire magic（ASCII "DWS1"）。
pub const MAGIC: [u8; 4] = *b"DWS1";
/// wire version。
pub const WIRE_VERSION: u8 = 1;

/// 帧类型（design §2.3 帧类型表 + §2.3.0 SESSION_INIT 族）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum FrameType {
    SessionInit = 0x00,
    ResumeInit = 0x01,
    ResumeOk = 0x02,
    ResumeReject = 0x03,
    Ping = 0x04,
    Pong = 0x05,
    SessionFin = 0x06,
    SessionReset = 0x07,
    SessionInitOk = 0x0A,
    SessionInitReject = 0x0B,
    Open = 0x10,
    OpenOk = 0x11,
    OpenReject = 0x12,
    Data = 0x20,
    Ack = 0x21,
    Fin = 0x22,
    Reset = 0x23,
}

impl FrameType {
    fn from_u8(v: u8) -> Option<Self> {
        Some(match v {
            0x00 => Self::SessionInit,
            0x01 => Self::ResumeInit,
            0x02 => Self::ResumeOk,
            0x03 => Self::ResumeReject,
            0x04 => Self::Ping,
            0x05 => Self::Pong,
            0x06 => Self::SessionFin,
            0x07 => Self::SessionReset,
            0x0A => Self::SessionInitOk,
            0x0B => Self::SessionInitReject,
            0x10 => Self::Open,
            0x11 => Self::OpenOk,
            0x12 => Self::OpenReject,
            0x20 => Self::Data,
            0x21 => Self::Ack,
            0x22 => Self::Fin,
            0x23 => Self::Reset,
            _ => return None,
        })
    }

    /// 控制帧（stream_id 必须为 0）。
    pub fn is_control(self) -> bool {
        matches!(
            self,
            Self::SessionInit
                | Self::SessionInitOk
                | Self::SessionInitReject
                | Self::ResumeInit
                | Self::ResumeOk
                | Self::ResumeReject
                | Self::Ping
                | Self::Pong
                | Self::SessionFin
                | Self::SessionReset
        )
    }
}

/// 公共 flags 位（design §2.2）。
pub mod flags {
    pub const START: u16 = 0x0001;
    pub const END: u16 = 0x0002;
    pub const RESET: u16 = 0x0004;
    pub const ACK_REQUEST: u16 = 0x0008;
    pub const REPLAY: u16 = 0x0010;
    pub const FIN: u16 = 0x0020;
    pub const HAS_SACK: u16 = 0x0040;
    /// 已定义位掩码（未知位严格拒绝）。
    pub const KNOWN_MASK: u16 = START | END | RESET | ACK_REQUEST | REPLAY | FIN | HAS_SACK;
}

/// 数据方向（0 = client->provider，1 = provider->client）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Direction {
    ClientToProvider = 0,
    ProviderToClient = 1,
}

impl Direction {
    fn from_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(Self::ClientToProvider),
            1 => Some(Self::ProviderToClient),
            _ => None,
        }
    }
}

/// 解码后的公共头 + payload 视图。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub frame_type: FrameType,
    pub flags: u16,
    pub session_id: [u8; 16],
    pub stream_id: u64,
    pub direction: Direction,
    pub byte_offset: u64,
    pub payload: Bytes,
}

/// 编解码错误（连接级协议违规一律终结连接，不含对端信息泄露面）。
#[derive(Debug, thiserror::Error)]
pub enum FrameError {
    #[error("frame too short for header: {0}B")]
    TooShort(usize),
    #[error("bad magic")]
    BadMagic,
    #[error("unsupported wire version: {0}")]
    BadVersion(u8),
    #[error("header_len must be 48, got {0}")]
    BadHeaderLen(u16),
    #[error("reserved must be zero")]
    BadReserved,
    #[error("unknown frame type: 0x{0:02x}")]
    UnknownFrameType(u8),
    #[error("unknown flag bits: 0x{0:04x}")]
    UnknownFlags(u16),
    #[error("payload exceeds MAX_FRAME: {0} > {1}")]
    PayloadTooLarge(usize, usize),
    #[error("declared length {declared} != available {available}")]
    LengthMismatch { declared: usize, available: usize },
    #[error("control frame with nonzero stream_id: {0}")]
    ControlWithStreamId(u64),
    #[error("business frame with zero stream_id")]
    BusinessWithZeroStreamId,
    #[error("invalid direction byte: {0}")]
    BadDirection(u8),
}

impl Frame {
    /// 编码：48B 头 + payload（调用方保证 payload ≤ MAX_FRAME；防御断言）。
    pub fn encode(&self, dst: &mut BytesMut) -> Result<(), FrameError> {
        if self.payload.len() > MAX_FRAME {
            return Err(FrameError::PayloadTooLarge(self.payload.len(), MAX_FRAME));
        }
        if self.frame_type.is_control() && self.stream_id != 0 {
            return Err(FrameError::ControlWithStreamId(self.stream_id));
        }
        if !self.frame_type.is_control() && self.stream_id == 0 {
            return Err(FrameError::BusinessWithZeroStreamId);
        }
        if self.flags & !flags::KNOWN_MASK != 0 {
            return Err(FrameError::UnknownFlags(self.flags & !flags::KNOWN_MASK));
        }
        dst.reserve(HEADER_LEN + self.payload.len());
        dst.put_slice(&MAGIC);
        dst.put_u8(WIRE_VERSION);
        dst.put_u8(self.frame_type as u8);
        dst.put_u16(self.flags);
        dst.put_slice(&self.session_id);
        dst.put_u64(self.stream_id);
        dst.put_u8(self.direction as u8);
        dst.put_u8(0); // reserved
        dst.put_u16(HEADER_LEN as u16);
        dst.put_u64(self.byte_offset);
        dst.put_u32(self.payload.len() as u32);
        dst.put_slice(&self.payload);
        Ok(())
    }

    /// 便捷编码到新缓冲。
    pub fn encode_to_vec(&self) -> Result<Vec<u8>, FrameError> {
        let mut buf = BytesMut::with_capacity(HEADER_LEN + self.payload.len());
        self.encode(&mut buf)?;
        Ok(buf.to_vec())
    }

    /// 解码：从 `src` 起始读取一帧；返回 (帧, 消费字节数)。
    /// 长度不足（头或 payload 未齐）按协议违规报错——帧边界由承载层
    /// （length-prefixed stream 或整帧信封）负责，本层不做部分读缓存。
    pub fn decode(src: &[u8]) -> Result<(Frame, usize), FrameError> {
        if src.len() < HEADER_LEN {
            return Err(FrameError::TooShort(src.len()));
        }
        let mut cur = &src[..];
        let magic = [cur.get_u8(), cur.get_u8(), cur.get_u8(), cur.get_u8()];
        if magic != MAGIC {
            return Err(FrameError::BadMagic);
        }
        let version = cur.get_u8();
        if version != WIRE_VERSION {
            return Err(FrameError::BadVersion(version));
        }
        let ft_raw = cur.get_u8();
        let frame_type = FrameType::from_u8(ft_raw).ok_or(FrameError::UnknownFrameType(ft_raw))?;
        let f = cur.get_u16();
        if f & !flags::KNOWN_MASK != 0 {
            return Err(FrameError::UnknownFlags(f & !flags::KNOWN_MASK));
        }
        let mut session_id = [0u8; 16];
        cur.copy_to_slice(&mut session_id);
        let stream_id = cur.get_u64();
        let dir_raw = cur.get_u8();
        let direction =
            Direction::from_u8(dir_raw).ok_or(FrameError::BadDirection(dir_raw))?;
        let reserved = cur.get_u8();
        if reserved != 0 {
            return Err(FrameError::BadReserved);
        }
        let header_len = cur.get_u16();
        if header_len as usize != HEADER_LEN {
            return Err(FrameError::BadHeaderLen(header_len));
        }
        let byte_offset = cur.get_u64();
        let payload_len = cur.get_u32() as usize;
        if payload_len > MAX_FRAME {
            return Err(FrameError::PayloadTooLarge(payload_len, MAX_FRAME));
        }
        if frame_type.is_control() && stream_id != 0 {
            return Err(FrameError::ControlWithStreamId(stream_id));
        }
        if !frame_type.is_control() && stream_id == 0 {
            return Err(FrameError::BusinessWithZeroStreamId);
        }
        let rest = &src[HEADER_LEN..];
        if rest.len() < payload_len {
            return Err(FrameError::LengthMismatch {
                declared: payload_len,
                available: rest.len(),
            });
        }
        let payload = Bytes::copy_from_slice(&rest[..payload_len]);
        Ok((
            Frame {
                frame_type,
                flags: f,
                session_id,
                stream_id,
                direction,
                byte_offset,
                payload,
            },
            HEADER_LEN + payload_len,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(ft: FrameType, stream_id: u64, payload: &[u8]) -> Frame {
        Frame {
            frame_type: ft,
            flags: if ft == FrameType::Data { flags::START } else { 0 },
            session_id: [9u8; 16],
            stream_id,
            direction: Direction::ClientToProvider,
            byte_offset: if ft == FrameType::Data { 42 } else { 0 },
            payload: Bytes::copy_from_slice(payload),
        }
    }

    /// 全帧类型 round-trip（合法 fixture 面：控制帧 stream=0，业务帧 stream≠0）。
    #[test]
    fn roundtrip_all_frame_types() {
        let all = [
            (FrameType::SessionInit, 0u64),
            (FrameType::ResumeInit, 0),
            (FrameType::ResumeOk, 0),
            (FrameType::ResumeReject, 0),
            (FrameType::Ping, 0),
            (FrameType::Pong, 0),
            (FrameType::SessionFin, 0),
            (FrameType::SessionReset, 0),
            (FrameType::SessionInitOk, 0),
            (FrameType::SessionInitReject, 0),
            (FrameType::Open, 7),
            (FrameType::OpenOk, 7),
            (FrameType::OpenReject, 7),
            (FrameType::Data, 7),
            (FrameType::Ack, 7),
            (FrameType::Fin, 7),
            (FrameType::Reset, 7),
        ];
        for (ft, sid) in all {
            let f = sample(ft, sid, b"payload-bytes");
            let enc = f.encode_to_vec().unwrap();
            assert_eq!(enc.len(), HEADER_LEN + 13);
            let (dec, used) = Frame::decode(&enc).unwrap();
            assert_eq!(used, enc.len());
            assert_eq!(dec, f, "roundtrip 失败: {ft:?}");
        }
    }

    #[test]
    fn roundtrip_all_flags_and_max_frame() {
        let mut f = sample(FrameType::Data, 3, &[0xAB; 4096]);
        f.flags = flags::KNOWN_MASK; // 全部位同时置位（编码层不限制组合语义）
        let (dec, _) = Frame::decode(&f.encode_to_vec().unwrap()).unwrap();
        assert_eq!(dec.flags, flags::KNOWN_MASK);

        let big = sample(FrameType::Data, 3, &vec![0u8; MAX_FRAME]);
        assert!(big.encode_to_vec().is_ok());
        let over = sample(FrameType::Data, 3, &vec![0u8; MAX_FRAME + 1]);
        assert!(matches!(
            over.encode_to_vec().unwrap_err(),
            FrameError::PayloadTooLarge(_, _)
        ));
    }

    /// 畸形负例（malformed fixture 面）。
    #[test]
    fn malformed_negatives() {
        let good = sample(FrameType::Data, 5, b"x").encode_to_vec().unwrap();
        // 头部截断
        assert!(matches!(
            Frame::decode(&good[..47]),
            Err(FrameError::TooShort(47))
        ));
        // 坏 magic
        let mut b = good.clone();
        b[0] = b'X';
        assert!(matches!(Frame::decode(&b), Err(FrameError::BadMagic)));
        // 坏 version
        let mut b = good.clone();
        b[4] = 2;
        assert!(matches!(Frame::decode(&b), Err(FrameError::BadVersion(2))));
        // header_len ≠ 48
        let mut b = good.clone();
        b[34..36].copy_from_slice(&49u16.to_be_bytes());
        assert!(matches!(
            Frame::decode(&b),
            Err(FrameError::BadHeaderLen(49))
        ));
        // reserved ≠ 0
        let mut b = good.clone();
        b[33] = 1;
        assert!(matches!(Frame::decode(&b), Err(FrameError::BadReserved)));
        // 未知 frame_type
        let mut b = good.clone();
        b[5] = 0x99;
        assert!(matches!(
            Frame::decode(&b),
            Err(FrameError::UnknownFrameType(0x99))
        ));
        // 未知 flags 位
        let mut b = good.clone();
        b[6..8].copy_from_slice(&0x8000u16.to_be_bytes());
        assert!(matches!(
            Frame::decode(&b),
            Err(FrameError::UnknownFlags(0x8000))
        ));
        // 坏 direction
        let mut b = good.clone();
        b[32] = 9;
        assert!(matches!(Frame::decode(&b), Err(FrameError::BadDirection(9))));
        // 声明长度超过实际
        let mut b = good.clone();
        let n = b.len();
        b[44..48].copy_from_slice(&100u32.to_be_bytes());
        assert!(matches!(
            Frame::decode(&b[..n]),
            Err(FrameError::LengthMismatch { declared: 100, .. })
        ));
        // 控制帧带非零 stream_id / 业务帧零 stream_id
        assert!(matches!(
            sample(FrameType::Ping, 1, b"").encode_to_vec(),
            Err(FrameError::ControlWithStreamId(1))
        ));
        assert!(matches!(
            sample(FrameType::Data, 0, b"").encode_to_vec(),
            Err(FrameError::BusinessWithZeroStreamId)
        ));
    }
}
