//! append-only jsonl 台账共享基座（server-access-roles Phase 1a，r1-P1-5：
//! owners/visitors/codes/blocklist 四台账统一矩阵）。
//!
//! 从 OwnerRegistry（server-access-policy task 1.2）的存储纪律抽取共享内核，
//! 各台账只实现自己的事件归并语义：
//! - 读：全量逐行解析，非空白坏行**硬错误**（带 `path:line` 上下文）；
//!   文件缺失 = 空集合（首启合法形态）；容忍尾随空行
//! - 写：append + fsync，成功后才允许更新内存快照（磁盘失败不留内存超前状态）
//! - generation：进程级全局单调计数器（每次 load / 每次变更 +1，跨台账共享
//!   保证任何两份快照的 (owners_gen, visitors_gen) 组合不回退——复合缓存键
//!   的正确性前提，design §1.1 callback 缓存联动）

use anyhow::{Context, Result};
use serde::Serialize;
use serde::de::DeserializeOwned;
use std::{
    fs::OpenOptions,
    io::{BufRead, BufReader, Write},
    path::Path,
};

/// 进程级单调 generation 计数器：每次 load / 每次变更 +1。全局单调而非每
/// 实例计数，保证后续文件重载（mtime）后 generation 不回退、缓存键不复用
/// 旧值；owners/visitors/blocklist 三台账共享同一计数器（台账间单调可比，
/// 各自快照只在自身变更时前进——复合世代组合的失效语义由此成立）。
static GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub(crate) fn next_generation() -> u64 {
    GENERATION.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1
}

/// 读全量 jsonl 为记录序列（`usize` = 1-based 行号，供调用方拼接坏值上下文）。
/// 文件缺失 = 空序列（首次启动合法形态）；尾随空行容忍、非空白坏行硬错误
/// （admin 信任域的本地文件被截断/篡改必须暴露而非静默跳过，§9 A9）。
pub(crate) fn read_records<R: DeserializeOwned>(
    path: &Path,
    label: &str,
) -> Result<Vec<(usize, R)>> {
    let mut records = Vec::new();
    match std::fs::File::open(path) {
        Ok(file) => {
            for (idx, line) in BufReader::new(file).lines().enumerate() {
                let line = line.with_context(|| format!("read {}", path.display()))?;
                if line.trim().is_empty() {
                    continue; // 容忍尾随空行；非空白坏行仍硬错误（见模块注释）
                }
                let record: R = serde_json::from_str(&line).with_context(|| {
                    format!("{}:{} malformed {label} record", path.display(), idx + 1)
                })?;
                records.push((idx + 1, record));
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            return Err(e).with_context(|| format!("open {label} file {}", path.display()));
        }
    }
    Ok(records)
}

/// 追加一行事件 + fsync（调用方先序列化，成功返回后才更新内存快照）。
/// 串行性由各台账自身的 Mutex 临界区保证。
pub(crate) fn append_line(path: &Path, label: &str, line: &str) -> Result<()> {
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("create {label} dir {}", parent.display()))?;
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .with_context(|| format!("open {label} file {}", path.display()))?;
    file.write_all(line.as_bytes())
        .and_then(|_| file.write_all(b"\n"))
        .with_context(|| format!("append {label} file {}", path.display()))?;
    file.sync_all()
        .with_context(|| format!("fsync {label} file {}", path.display()))?;
    Ok(())
}

/// 记录序列化为一行 jsonl（无尾随换行——append_line 补）
pub(crate) fn record_line<R: Serialize>(record: &R) -> Result<String> {
    Ok(serde_json::to_string(record)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::{Deserialize, Serialize};
    use tempfile::TempDir;

    #[derive(Serialize, Deserialize, PartialEq, Debug)]
    struct Probe {
        op: String,
    }

    #[test]
    fn missing_file_is_empty_and_blank_lines_tolerated() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("probe.jsonl");
        assert!(read_records::<Probe>(&path, "probe").unwrap().is_empty());
        std::fs::write(&path, "\n\n").unwrap();
        assert!(read_records::<Probe>(&path, "probe").unwrap().is_empty());
    }

    #[test]
    fn malformed_lines_carry_line_context() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("probe.jsonl");
        std::fs::write(&path, "{\"op\":\"a\"}\nnot json\n").unwrap();
        let err = read_records::<Probe>(&path, "probe").unwrap_err();
        let msg = format!("{err:#}");
        assert!(msg.contains("malformed probe record"), "{msg}");
        assert!(msg.contains(":2"), "行号上下文: {msg}");
    }

    #[test]
    fn append_line_creates_parent_and_roundtrips() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("nested/deep/probe.jsonl");
        append_line(
            &path,
            "probe",
            &record_line(&Probe { op: "a".into() }).unwrap(),
        )
        .unwrap();
        let records = read_records::<Probe>(&path, "probe").unwrap();
        assert_eq!(records, vec![(1, Probe { op: "a".into() })]);
    }

    #[test]
    fn generation_is_monotonic_across_calls() {
        let a = next_generation();
        let b = next_generation();
        assert!(b > a, "全局单调递增");
        assert!(a >= 1, "恒非零（可作缓存键成分）");
    }
}
