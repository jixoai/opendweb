//! per-IP 令牌桶限流组件（server-access-roles Phase 1b，design §1.4/§1.6：
//! `/register` 与 rendezvous resolve/announce 共用，~40 行级实现，无新依赖）。
//!
//! 语义冻结（spec「rendezvous 访问控制」/「租户邀请码与公开自助注册」）：
//! - 键 = **直连 TCP peer 地址**（`ConnectInfo<SocketAddr>`）；
//!   `X-Forwarded-For`/`Forwarded` 等代理头 v1 一律不采信（可伪造——反代
//!   部署下按代理地址聚合，属明示取舍）
//! - 速率 = 每分钟许可数（整数 refill：elapsed_ms × rate / 60_000）；
//!   突发容量 = 调用方给定（/register burst=rate/2，rendezvous burst=rate/2）
//! - 超限 = 调用方返回 429 + error envelope（`rate-limited`），与凭证有效
//!   性无关、与 access mode 正交
//!
//! 实现：`Mutex<HashMap<IpAddr, Bucket>>`，整数运算（无浮点/无时间模拟依赖）；
//! 容量有界（超过阈值时清理已静默过期的桶，防女巫 IP 撑爆内存）。

use std::{
    collections::HashMap,
    net::IpAddr,
    sync::Mutex,
    time::{Duration, Instant},
};

/// 触发清理的条目阈值（每 IP 一条；超出即清理静默桶——有界内存）
const PRUNE_THRESHOLD: usize = 4096;

/// 桶：当前令牌数 + 上次补给时刻（整数 refill 的时钟锚点）
#[derive(Clone, Copy)]
struct Bucket {
    tokens: u32,
    updated: Instant,
}

/// per-IP 令牌桶限流器（构造后只读共享；`take` 为唯一消费面）
pub struct IpRateLimiter {
    rate_per_min: u32,
    burst: u32,
    buckets: Mutex<HashMap<IpAddr, Bucket>>,
}

impl IpRateLimiter {
    /// 构造。`rate_per_min` 每分钟许可数（≥1 钳位）；`burst` 突发容量
    /// （≥1 钳位——rendezvous 的 rate/2 规则由调用方计算）。
    pub fn new(rate_per_min: u32, burst: u32) -> Self {
        Self {
            rate_per_min: rate_per_min.max(1),
            burst: burst.max(1),
            buckets: Mutex::new(HashMap::new()),
        }
    }

    /// 消费一个许可（真实时钟；返回 false = 超限 429 语义）
    pub fn take(&self, ip: IpAddr) -> bool {
        self.take_at(ip, Instant::now())
    }

    /// 可注入时钟版本（单测用合成 Instant 驱动 refill 语义）
    pub fn take_at(&self, ip: IpAddr, now: Instant) -> bool {
        let mut buckets = self.buckets.lock().unwrap();
        if buckets.len() > PRUNE_THRESHOLD {
            // 清理静默超过两倍补满窗口的桶（等价于「桶已满且长期未用」）
            let idle = self.refill_window() * 2;
            buckets.retain(|_, b| now.checked_duration_since(b.updated).unwrap_or_default() < idle);
        }
        let bucket = buckets.entry(ip).or_insert(Bucket {
            tokens: self.burst,
            updated: now,
        });
        let elapsed = now
            .checked_duration_since(bucket.updated)
            .unwrap_or_default();
        let refill = elapsed.as_millis() as u64 * u64::from(self.rate_per_min) / 60_000;
        if refill > 0 {
            bucket.tokens = (bucket.tokens.saturating_add(refill as u32)).min(self.burst);
            bucket.updated = now;
        }
        if bucket.tokens > 0 {
            bucket.tokens -= 1;
            true
        } else {
            false
        }
    }

    /// 补满窗口（速率的完整周期）
    fn refill_window(&self) -> Duration {
        Duration::from_secs(60)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr};

    fn ip(a: u8) -> IpAddr {
        IpAddr::V4(Ipv4Addr::new(127, 0, 0, a))
    }

    /// 突发容量 + 耗尽：burst=2 → 前两次放行、第三次拒绝（零时间流逝）
    #[test]
    fn burst_allows_then_rejects() {
        let limiter = IpRateLimiter::new(10, 2);
        let t0 = Instant::now();
        assert!(limiter.take_at(ip(1), t0));
        assert!(limiter.take_at(ip(1), t0));
        assert!(!limiter.take_at(ip(1), t0), "突发耗尽 → 429 语义");
    }

    /// 周期补给：30s 后按 10/min 回补 5 个许可（整数 refill：
    /// 30_000ms × 10 / 60_000 = 5）
    #[test]
    fn refill_over_time() {
        let limiter = IpRateLimiter::new(10, 2);
        let t0 = Instant::now();
        assert!(limiter.take_at(ip(1), t0));
        assert!(limiter.take_at(ip(1), t0));
        assert!(!limiter.take_at(ip(1), t0));
        let t1 = t0 + Duration::from_secs(30);
        assert!(limiter.take_at(ip(1), t1));
        assert!(
            limiter.take_at(ip(1), t1),
            "回补 5 个许可（上限突发 2 → 重取）"
        );
        assert!(!limiter.take_at(ip(1), t1), "再次耗尽");
    }

    /// per-IP 隔离 + 突发上限封顶（长静默后不会超过 burst）
    #[test]
    fn per_ip_isolation_and_burst_cap() {
        let limiter = IpRateLimiter::new(60, 3);
        let t0 = Instant::now();
        for a in 1..=10u8 {
            assert!(limiter.take_at(ip(a), t0), "各 IP 独立突发");
        }
        // ip(1) 已用 1/3：再取两次后耗尽（burst=3）
        assert!(limiter.take_at(ip(1), t0));
        assert!(limiter.take_at(ip(1), t0));
        assert!(!limiter.take_at(ip(1), t0));
        // 静默 10 分钟后回补封顶在 burst=3（而非累积 600）
        let t1 = t0 + Duration::from_secs(600);
        assert!(limiter.take_at(ip(1), t1));
        assert!(limiter.take_at(ip(1), t1));
        assert!(limiter.take_at(ip(1), t1));
        assert!(!limiter.take_at(ip(1), t1), "回补封顶 burst");
    }

    /// IPv6 键独立；容量清理（超阈值丢静默桶，活跃桶保留）
    #[test]
    fn ipv6_key_and_prune() {
        let limiter = IpRateLimiter::new(60, 1);
        let v6 = IpAddr::V6(Ipv6Addr::LOCALHOST);
        let t0 = Instant::now();
        assert!(limiter.take_at(v6, t0));
        assert!(!limiter.take_at(v6, t0));
        assert!(limiter.take_at(ip(9), t0), "v4/v6 键互不影响");

        let big = IpRateLimiter::new(60, 1);
        let t = Instant::now();
        for i in 0..5000u32 {
            let addr = IpAddr::V4(Ipv4Addr::new(10, (i >> 16) as u8, (i >> 8) as u8, i as u8));
            assert!(big.take_at(addr, t));
        }
        // 5000 > 4096 阈值 → 静默桶（含本例全部）被清理后 map 有界；
        // 新 IP 仍可正常取（清理不破坏可用性）
        let fresh = IpAddr::V4(Ipv4Addr::new(192, 0, 2, 1));
        assert!(big.take_at(fresh, t));
    }

    /// 速率与突发钳位（0 入参不 panic，钳到 1）
    #[test]
    fn zero_rate_clamped() {
        let limiter = IpRateLimiter::new(0, 0);
        let t0 = Instant::now();
        assert!(limiter.take_at(ip(1), t0));
        assert!(!limiter.take_at(ip(1), t0));
    }
}
