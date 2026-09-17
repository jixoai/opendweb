//! Server identity：`<data_dir>/server.key` load-or-create（task 1.1，需求来源
//! 2026-09-17；design §6.2 职责边界 / §11.2 数据目录）。
//!
//! Ed25519 32B 裸 seed（iroh_base::SecretKey 封装，与客户端 identity.key 同构，
//! 但 server 不依赖 dweb-fabric——同构实现原子写语义，约 60 行，design §6.2 收窄
//! 原则）。写路径：0600 + 临时文件 + 内容 fsync + rename 原子写 + 目录 fsync。
//! 损坏文件（长度 ≠ 32B）fail-fast 报错且**不覆盖**（防误吞篡改/截断，§9 A9）。
//!
//! 幂等边界：main 每进程串行调用一次即够用（单进程内不分叉），不引入跨进程
//! 锁——同 fabric 侧 FileSecretStore 语义由 admin 保证单一部署目录。

use anyhow::{Context, Result};
use iroh_base::{PublicKey, SecretKey};
use std::path::{Path, PathBuf};

/// 数据目录内的 server key 文件名（design §11.2）
pub const SERVER_KEY_FILE: &str = "server.key";

/// Ed25519 seed 长度
const SEED_LEN: usize = 32;

/// Server 身份。Debug 恒为脱敏形态（seed 不进日志，§8.5 token 脱敏同源纪律）。
pub struct ServerIdentity {
    secret: SecretKey,
}

impl std::fmt::Debug for ServerIdentity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ServerIdentity([REDACTED])")
    }
}

impl ServerIdentity {
    /// 载入 `<data_dir>/server.key`；缺失则生成新 key 并原子落盘。
    /// 损坏文件报错不覆盖；目录不存在则创建。
    pub fn load_or_create(data_dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(data_dir)
            .with_context(|| format!("create data dir {}", data_dir.display()))?;
        let path = data_dir.join(SERVER_KEY_FILE);
        match std::fs::read(&path) {
            Ok(bytes) => {
                let found = bytes.len();
                let seed: [u8; SEED_LEN] = bytes.try_into().map_err(|_| {
                    anyhow::anyhow!(
                        "server key {} corrupted: expected {SEED_LEN} bytes of Ed25519 seed, found {found}",
                        path.display()
                    )
                })?;
                Ok(Self {
                    secret: SecretKey::from_bytes(&seed),
                })
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let secret = SecretKey::generate();
                write_atomic_0600(&path, &secret.to_bytes())
                    .with_context(|| format!("write server key {}", path.display()))?;
                Ok(Self { secret })
            }
            Err(e) => Err(e).with_context(|| format!("read server key {}", path.display())),
        }
    }

    /// ServerId（Ed25519 公钥；z-base-32 展示）。capability 的 server_id 字段
    /// 绑定值（design §11.1，防跨 Server 重放）。
    pub fn server_id(&self) -> PublicKey {
        self.secret.public()
    }
}

/// 0600 + tmp + 内容 fsync + rename 原子写 + 目录 fsync（design §11.2；同构
/// dweb-fabric FileSecretStore 的 create 语义，但用 rename 形态——本 crate
/// 单进程调用，无需 hard_link 的 create-if-absent CAS）。
fn write_atomic_0600(path: &Path, bytes: &[u8]) -> Result<()> {
    let dir = path.parent().unwrap_or(Path::new("."));
    // 唯一临时名（pid + 原子计数器）：同进程多调用也绝不互踩
    static TMP_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let tmp: PathBuf = dir.join(format!(
        "{}.{}.{}.tmp",
        SERVER_KEY_FILE,
        std::process::id(),
        TMP_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp)?;
    restrict_permissions(&tmp)?;
    std::io::Write::write_all(&mut file, bytes)?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(&tmp, path)?;
    fsync_dir(dir)
}

/// unix 下 0600；Windows 无同等文件权限模型，降级为目录 ACL 责任
/// （同 fabric secret.rs 文档化边界）。
#[cfg(unix)]
fn restrict_permissions(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .with_context(|| format!("chmod 0600 {}", path.display()))
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &Path) -> Result<()> {
    Ok(())
}

/// 目录 fsync 保证 rename 的持久性（崩溃后不留无主 tmp）
#[cfg(unix)]
fn fsync_dir(dir: &Path) -> Result<()> {
    std::fs::File::open(dir)?
        .sync_all()
        .with_context(|| format!("fsync dir {}", dir.display()))
}

#[cfg(not(unix))]
fn fsync_dir(_dir: &Path) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[cfg(unix)]
    fn mode_of(path: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn first_run_generates_32b_seed_with_0600() {
        let dir = TempDir::new().unwrap();
        let _id = ServerIdentity::load_or_create(dir.path()).unwrap();
        let key = dir.path().join(SERVER_KEY_FILE);
        assert_eq!(std::fs::read(&key).unwrap().len(), SEED_LEN);
        #[cfg(unix)]
        assert_eq!(mode_of(&key), 0o600);
        // 无崩溃残留 tmp（写路径走唯一临时名 + rename）
        let leftover: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(
            leftover.len(),
            1,
            "expected only server.key, got {leftover:?}"
        );
    }

    #[test]
    fn restart_restores_same_server_id() {
        let dir = TempDir::new().unwrap();
        let first = ServerIdentity::load_or_create(dir.path()).unwrap();
        let second = ServerIdentity::load_or_create(dir.path()).unwrap();
        assert_eq!(first.server_id(), second.server_id());
    }

    #[test]
    fn corrupted_file_errors_without_overwrite() {
        let dir = TempDir::new().unwrap();
        let key = dir.path().join(SERVER_KEY_FILE);
        std::fs::write(&key, [7u8; 31]).unwrap(); // 长度错误
        let err = ServerIdentity::load_or_create(dir.path()).unwrap_err();
        assert!(err.to_string().contains("corrupted"), "{err}");
        // 损坏文件必须原样保留（不覆盖、不静默重新生成）
        assert_eq!(std::fs::read(&key).unwrap(), [7u8; 31]);
    }

    #[test]
    fn corrupted_file_reports_actual_length() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join(SERVER_KEY_FILE), [0u8; 64]).unwrap();
        let err = ServerIdentity::load_or_create(dir.path()).unwrap_err();
        assert!(err.to_string().contains("found 64"), "{err}");
    }
}
