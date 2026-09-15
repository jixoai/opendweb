//! app-protocol-layer：session continuity 层（app-protocol-layer change）。
//!
//! Phase 0 先落 wire 帧编解码（frame.rs）与语义模型（model.rs）作为
//! 单一权威；Phase 1/2 在其上接续 raw transport 与会话状态机。
//! 设计文档：openspec/changes/app-protocol-layer/design.md。

pub mod frame;
pub mod model;

pub use frame::{Direction, Frame, FrameError, FrameType, HEADER_LEN, MAGIC, MAX_FRAME, WIRE_VERSION};
pub use model::{GapOverflow, JournalError, JournalLimits, RecvWindow, SegmentAction, StreamJournal};
