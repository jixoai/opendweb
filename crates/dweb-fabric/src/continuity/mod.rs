//! app-protocol-layer：session continuity 层（app-protocol-layer change）。
//!
//! 分层（design §1）：
//! - `frame`：wire 帧编解码（Phase 0 冻结，单一权威）
//! - `model`：去重/journal 语义模型（Phase 0，Phase 2 实现的语义权威）
//! - `state`：连接状态面（Phase 1——快照/epoch/stateSeq watch）
//! - `manager`：continuity 连接管理（Phase 1——ALPN/胜者/监督重连）
//! - `transport`：raw 传输（Phase 1——bidi 流上的 Frame 收发）
//!
//! 设计文档：openspec/changes/app-protocol-layer/design.md。

pub mod frame;
pub mod http;
pub mod manager;
pub mod model;
pub mod session;
pub mod state;
pub mod transport;

/// continuity 专用 ALPN（与 legacy envelope 物理隔离；design §1.1）。
pub const ALPN_CONTINUITY: &[u8] = b"/dweb/fabric-continuity/1";

pub use frame::{Direction, Frame, FrameError, FrameType, HEADER_LEN, MAGIC, MAX_FRAME, WIRE_VERSION};
pub use model::{GapOverflow, JournalError, JournalLimits, RecvWindow, SegmentAction, StreamJournal};
pub use session::{RequestState, Session, SessionChannel, SessionOptions, SessionPhase, SessionRegistry, SessionShared};
pub use state::{ConnHandle, ConnectionPhase, ConnectionStateSnapshot, ContinuityState};
pub use transport::{ContinuityTransport, StreamFramer, TransportError, TransportRecv, TransportSend};
