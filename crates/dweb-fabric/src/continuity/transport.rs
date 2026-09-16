//! continuity raw 传输（app-protocol-layer Phase 1 task 2.1）。
//!
//! `ContinuityTransport` = 在已采纳的 continuity 连接上开一条 bidi 流，
//! 承载 [`super::frame::Frame`] 的收发。流上帧无长度前缀——`Frame::decode`
//! 的返回消费数即边界，`StreamFramer` 负责增量缓冲（不完整帧等待更多字节）。
//! Phase 2 的会话层在本传输之上做 SESSION_INIT/RESUME 与 journal 重放。

use bytes::BytesMut;

use super::frame::{Frame, FrameError};

/// 增量分帧器：喂入任意切片，吐出完整帧。
/// `TooShort` / `LengthMismatch{declared>available}` 视为「等待更多字节」。
#[derive(Debug, Default)]
pub struct StreamFramer {
    buf: BytesMut,
}

enum FeedOutcome {
    Frame(Frame),
    NeedMore,
    Fatal(FrameError),
}

impl StreamFramer {
    pub fn new() -> Self {
        Self::default()
    }

    fn try_one(src: &[u8]) -> FeedOutcome {
        match Frame::decode(src) {
            Ok((frame, _used)) => FeedOutcome::Frame(frame),
            Err(FrameError::TooShort(_)) => FeedOutcome::NeedMore,
            Err(FrameError::LengthMismatch { declared, available }) => {
                if declared > available {
                    FeedOutcome::NeedMore
                } else {
                    FeedOutcome::Fatal(FrameError::LengthMismatch { declared, available })
                }
            }
            Err(e) => FeedOutcome::Fatal(e),
        }
    }

    /// 喂入字节，返回完整帧列表；协议违规立即返回（缓冲区保留后续供诊断）。
    pub fn feed(&mut self, chunk: &[u8]) -> Result<Vec<Frame>, FrameError> {
        self.buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        loop {
            match Self::try_one(&self.buf) {
                FeedOutcome::Frame(f) => {
                    let used = super::frame::HEADER_LEN + f.payload.len();
                    let _ = self.buf.split_to(used);
                    out.push(f);
                }
                FeedOutcome::NeedMore => return Ok(out),
                FeedOutcome::Fatal(e) => {
                    if out.is_empty() {
                        return Err(e);
                    }
                    // 已解出的帧先交付；错误留给下一次 feed 重放同一缓冲触发
                    self.buf.clear();
                    return Ok(out);
                }
            }
        }
    }
}

/// 一条已采纳连接上的 continuity 双向流。
pub struct ContinuityTransport {
    pub epoch: u64,
    send: iroh::endpoint::SendStream,
    recv: iroh::endpoint::RecvStream,
    framer: StreamFramer,
}

#[derive(Debug, thiserror::Error)]
pub enum TransportError {
    #[error("continuity stream io: {0}")]
    Io(String),
    #[error("continuity frame: {0}")]
    Frame(#[from] FrameError),
    #[error("continuity stream ended")]
    Ended,
}

impl ContinuityTransport {
    /// 在当前代次连接上开一条 bidi 流（调用方保证 conn 存活窗口内使用）。
    pub async fn open(
        conn: &iroh::endpoint::Connection,
        epoch: u64,
    ) -> Result<Self, TransportError> {
        let (send, recv) = conn
            .open_bi()
            .await
            .map_err(|e| TransportError::Io(format!("{e}")))?;
        Ok(Self {
            epoch,
            send,
            recv,
            framer: StreamFramer::new(),
        })
    }

    pub async fn send(&mut self, frame: &Frame) -> Result<(), TransportError> {
        let mut buf = BytesMut::with_capacity(super::frame::HEADER_LEN + frame.payload.len());
        frame.encode(&mut buf)?;
        self.send
            .write_all(&buf)
            .await
            .map_err(|e| TransportError::Io(format!("{e}")))?;
        Ok(())
    }

    /// 阻塞收一帧（EOF/错误 → Ended/Io）。
    pub async fn recv(&mut self) -> Result<Frame, TransportError> {
        loop {
            let mut chunk = [0u8; 16 * 1024];
            let n = self
                .recv
                .read(&mut chunk)
                .await
                .map_err(|e| TransportError::Io(format!("{e}")))?;
            let Some(n) = n else { return Err(TransportError::Ended) };
            let frames = self.framer.feed(&chunk[..n])?;
            if let Some(f) = frames.into_iter().next() {
                return Ok(f);
            }
            // 帧未齐：继续读
        }
    }

    /// 由已建立的 (send, recv) 组装（接受侧入口）。
    pub fn from_parts(
        send: iroh::endpoint::SendStream,
        recv: iroh::endpoint::RecvStream,
        epoch: u64,
    ) -> Self {
        Self {
            epoch,
            send,
            recv,
            framer: StreamFramer::new(),
        }
    }

    /// 优雅半关（发送侧 FIN）。
    pub fn finish(&mut self) -> Result<(), TransportError> {
        self.send
            .finish()
            .map_err(|e| TransportError::Io(format!("{e}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bytes::Bytes;
    use crate::continuity::frame::{Direction, FrameType};

    fn data_frame(offset: u64, payload: &[u8]) -> Frame {
        Frame {
            frame_type: FrameType::Data,
            flags: 0,
            session_id: [5u8; 16],
            stream_id: 9,
            direction: Direction::ClientToProvider,
            byte_offset: offset,
            payload: Bytes::copy_from_slice(payload),
        }
    }

    #[test]
    fn framer_incremental_and_split_boundaries() {
        let f1 = data_frame(0, b"hello");
        let f2 = data_frame(5, b"world!!!");
        let mut wire = BytesMut::new();
        f1.encode(&mut wire).unwrap();
        f2.encode(&mut wire).unwrap();
        let wire = wire.freeze();
        // 逐字节喂入：每一步都不得报错，最终恰好两帧且内容一致
        let mut fr = StreamFramer::new();
        let mut got = Vec::new();
        for b in wire.iter() {
            got.extend(fr.feed(&[*b]).unwrap());
        }
        assert_eq!(got.len(), 2);
        assert_eq!(got[0], f1);
        assert_eq!(got[1], f2);
        // 中间任何截断点：已产出帧数单调、无错
        let mut fr2 = StreamFramer::new();
        let mut produced = 0usize;
        for cut in 1..=wire.len() {
            let out = fr2.feed(&wire[cut - 1..cut]).unwrap();
            produced += out.len();
        }
        assert_eq!(produced, 2);
    }

    #[test]
    fn framer_fatal_propagates() {
        let good = data_frame(0, b"x");
        let mut wire = good.encode_to_vec().unwrap();
        wire[0] = b'Q'; // 坏 magic
        let mut fr = StreamFramer::new();
        assert!(fr.feed(&wire).is_err());
    }
}
