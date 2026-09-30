//! known_addrs 有界存储（HB 3.1 + N1 学习卫生 2026-09-30）：从邀请令牌/连接
//! 学到的对端可达地址，按来源标注、活性修剪、优先级排序。
//! HashMap 无插入序——以 VecDeque 维护 endpoint 首次插入序实现 FIFO 淘汰，
//! 手写实现，不引第三方依赖。
//!
//! 意图登记（Owner 文件顶注释规范）：
//! - [2026-08-29] hardening-backlog 3.1：per-endpoint/global 容量上限 + FIFO 淘汰
//! - [2026-09-30] E1′ 学习卫生（真双机第六批实证，N1 正式闭合）：
//!   ① 来源标注——Announced（invite 宣告，唯一权威）/ DialOk（本端拨号成功
//!   观测）/ ObservedInbound（入站连接源地址——可能是对端 scratch 专用
//!   endpoint 的临时端口，不可识别，**一律不落盘**）/ Manual（NAPI 注入）；
//!   ② 活性修剪——非 Announced 条目连续拨号失败 ≥3 淘汰（末位保留：失败
//!   淘汰不得清空候选——整计划失败可由对端滞留造成，清空即丧失重试资本）、
//!   ObservedInbound 未验证 TTL 过期淘汰、per-endpoint ObservedInbound 条数
//!   上限（墓地是 scratch 端口随端点弃置累积的死地址，root 侧曾实证 16 条）；
//!   ③ 拨号候选排序「宣告 > 手工 > 近期拨号成功 > 观测」，死地址降权淘汰；
//!   ④ v1 known_addrs.json（无来源信息）加载时降级为 ObservedInbound
//!   （内存 + TTL）——脏条目不跨重启存活，首个成功拨号后以 DialOk 重新落盘。
//! - [2026-08-29] learned 不遮蔽 custom relay 的合并语义在 fabric.rs
//!   `merge_dial_candidates` 冻结（本文件只管存储边界）

use crate::identity::EndpointId;
use std::collections::{HashMap, VecDeque};

/// per-endpoint 地址容量上限（spec 冻结值 1024）。
pub(crate) const MAX_ADDRS_PER_ENDPOINT: usize = 1024;
/// 全局 endpoint 容量上限（spec 冻结值 65536）。
pub(crate) const MAX_ENDPOINTS: usize = 65_536;
/// 非 Announced 条目的拨号失败淘汰阈值（整个两步拨号计划失败计一次）。
pub(crate) const FAIL_EVICT_THRESHOLD: u32 = 3;
/// ObservedInbound 未验证存活期：从未拨号成功且超过该时长的观测条目淘汰
/// （scratch 专用 endpoint 的寿命量级远小于此值）。
pub(crate) const OBSERVED_TTL_MS: u64 = 10 * 60 * 1000;
/// per-endpoint ObservedInbound 条数上限（按 learned_at 留最新）。
pub(crate) const OBSERVED_CAP: usize = 4;

/// 地址来源（N1：学习面按来源分治持久化与信任级）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AddrSource {
    /// invite 令牌宣告（issuer advertise_addrs / relay URL）——权威来源，
    /// 不因拨号失败淘汰。
    Announced,
    /// NAPI `add_known_addr` 手工注入。
    Manual,
    /// 本端拨号成功时选中路径的对端地址——验证过可达，可持久。
    DialOk,
    /// 入站连接观测的对端源地址。**可能是对端 direct-dial 专用 endpoint 的
    /// 临时随机端口**（E1′ 交叉学习实证：scratch 端口随端点弃置即死，持久化
    /// 后双方互相拨对方死端口）——不可识别，一律不落盘，仅内存 + TTL/失败
    /// 修剪；本端对该地址拨号成功后升格 DialOk 落盘。
    ObservedInbound,
}

impl AddrSource {
    fn as_str(self) -> &'static str {
        match self {
            AddrSource::Announced => "announced",
            AddrSource::Manual => "manual",
            AddrSource::DialOk => "dial-ok",
            AddrSource::ObservedInbound => "observed",
        }
    }

    fn parse(s: &str) -> Self {
        match s {
            "announced" => AddrSource::Announced,
            "manual" => AddrSource::Manual,
            "dial-ok" => AddrSource::DialOk,
            // 未知来源标签（含防御面）一律按不可信观测处理：不落盘、TTL 修剪
            _ => AddrSource::ObservedInbound,
        }
    }

    /// 是否允许写入持久化快照。
    fn persistable(self) -> bool {
        !matches!(self, AddrSource::ObservedInbound)
    }

    /// 拨号失败是否计淘汰分（Announced 是宣告事实，不因失败淘汰）。
    fn fail_evictable(self) -> bool {
        !matches!(self, AddrSource::Announced)
    }
}

/// 单条地址条目（来源 + 活性元数据）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AddrEntry {
    pub(crate) addr: String,
    pub(crate) source: AddrSource,
    /// 最后一次本端拨号成功时刻（ms；0 = 从未验证）。
    pub(crate) last_success_ms: u64,
    /// 学习时刻（ms）。
    pub(crate) learned_at_ms: u64,
    /// 连续拨号失败计数（成功清零）。
    pub(crate) fail_count: u32,
}

/// 持久化形态（v2；serde 字段名冻结）。v1 文件（`Vec<(String, Vec<String>)>`）
/// 经 [`PersistEntry`] 的 untagged 兼容解析，地址降级为 ObservedInbound。
#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub(crate) struct PersistedAddr {
    pub(crate) addr: String,
    pub(crate) src: String,
    pub(crate) last_ok: u64,
    pub(crate) learned_at: u64,
}

/// v1/v2 混布容错条目（untagged：对象=v2，字符串=v1）。
#[derive(Debug, serde::Deserialize)]
#[serde(untagged)]
pub(crate) enum PersistEntry {
    V2(PersistedAddr),
    V1(String),
}

/// 有界 known_addrs：endpoint -> 条目列表。
///
/// 淘汰语义：全局 endpoint 数超 [`MAX_ENDPOINTS`] 按 FIFO 淘汰最旧；
/// per-endpoint 超 [`MAX_ADDRS_PER_ENDPOINT`] 按学习序淘汰最旧；活性修剪
/// （失败计数/观测 TTL/ObservedInbound 条数上限）见模块注释。
#[derive(Debug, Default)]
pub(crate) struct KnownAddrs {
    map: HashMap<EndpointId, Vec<AddrEntry>>,
    /// endpoint 首次插入序（FIFO 淘汰序）；不变式：内容与 map 的键集合一致。
    order: VecDeque<EndpointId>,
}

/// 拨号候选优先级：宣告 > 手工 > 拨号成功（新近优先）> 观测（新近优先）。
/// 同级内 `last_success_ms` 降序、再按 `learned_at_ms` 降序（新学优先）。
fn priority(e: &AddrEntry) -> (u8, u64, u64) {
    let class = match e.source {
        AddrSource::Announced => 0u8,
        AddrSource::Manual => 1,
        AddrSource::DialOk => 2,
        AddrSource::ObservedInbound => 3,
    };
    (class, e.last_success_ms, e.learned_at_ms)
}

impl KnownAddrs {
    /// 该 endpoint 的条目（未排序、未修剪；测试/诊断面）。
    #[cfg(test)]
    pub(crate) fn entries(&self, id: &EndpointId) -> &[AddrEntry] {
        self.map.get(id).map(Vec::as_slice).unwrap_or(&[])
    }

    /// 拨号候选（惰性修剪 + 优先级排序后的地址串列表；relay URL 形态的
    /// Announced/Manual 条目原样在内，直连候选解析由 merge_dial_candidates
    /// 承接）。调用方持有锁；`now_ms` 显式传参保证确定性测试。
    pub(crate) fn ordered_addrs(&mut self, id: &EndpointId, now_ms: u64) -> Vec<String> {
        self.prune(id, now_ms);
        let Some(v) = self.map.get_mut(id) else {
            return Vec::new();
        };
        let mut sorted = v.clone();
        // 升序 = 类号小者（宣告）在前；同级内 last_success/learned_at 大者
        //（新近）在前——由元组 (class, last_ok, learned_at) 的字典序承载：
        // class 占最高位（升序即优先级降序），last_ok/learned_at 需降序，
        // 取其补序（u64::MAX - x）保持单键排序。
        sorted.sort_by_key(|e| {
            (
                priority(e).0,
                u64::MAX - priority(e).1,
                u64::MAX - priority(e).2,
            )
        });
        sorted.into_iter().map(|e| e.addr).collect()
    }

    /// 宣告地址集（join 学习路径：以令牌携带的最新可达信息为准）。upsert：
    /// 宣告集合整体替换既有 Announced 条目；其它来源条目保留（活性修剪另管）。
    /// `now_ms` 同时记为宣告时刻。
    pub(crate) fn announce(&mut self, id: EndpointId, addrs: Vec<String>, now_ms: u64) {
        let slot = self.ensure_slot(&id);
        // 去掉旧 Announced（不在新宣告集内的宣告事实撤销）
        slot.retain(|e| e.source != AddrSource::Announced);
        for a in addrs {
            if let Some(existing) = slot
                .iter_mut()
                .find(|e| e.addr == a && e.source == AddrSource::Announced)
            {
                // 宣告刷新（理论不可达：上面已 retain 掉）——保持元数据更新
                existing.last_success_ms = now_ms;
                existing.fail_count = 0;
            } else if !slot.iter().any(|e| e.addr == a) {
                slot.push(AddrEntry {
                    addr: a,
                    source: AddrSource::Announced,
                    last_success_ms: now_ms,
                    learned_at_ms: now_ms,
                    fail_count: 0,
                });
            }
        }
        Self::cap_addrs(slot);
    }

    /// 手工注入（NAPI add_known_addr）：幂等；已存在只升来源为 Manual。
    pub(crate) fn record_manual(&mut self, id: EndpointId, addr: String, now_ms: u64) {
        let slot = self.ensure_slot(&id);
        if let Some(existing) = slot.iter_mut().find(|e| e.addr == addr) {
            existing.source = AddrSource::Manual;
            existing.fail_count = 0;
            return;
        }
        slot.push(AddrEntry {
            addr,
            source: AddrSource::Manual,
            last_success_ms: 0,
            learned_at_ms: now_ms,
            fail_count: 0,
        });
        Self::cap_addrs(slot);
    }

    /// 拨号成功：命中条目升格/刷新（fails 清零、last_ok=now）；未命中的新
    /// 地址（路径迁移等）以 DialOk 学习（验证过可达，可持久）。
    pub(crate) fn record_dial_success(&mut self, id: &EndpointId, addr: &str, now_ms: u64) {
        let slot = self.ensure_slot(id);
        if let Some(existing) = slot.iter_mut().find(|e| e.addr == addr) {
            existing.last_success_ms = now_ms;
            existing.fail_count = 0;
            if existing.source == AddrSource::ObservedInbound {
                existing.source = AddrSource::DialOk;
            }
            return;
        }
        slot.push(AddrEntry {
            addr: addr.to_owned(),
            source: AddrSource::DialOk,
            last_success_ms: now_ms,
            learned_at_ms: now_ms,
            fail_count: 0,
        });
        Self::cap_addrs(slot);
    }

    /// 入站连接观测的对端源地址：**不落盘**（可能是对端 scratch 临时端口）。
    /// 已有条目（任何来源）只刷新学习时刻——Announced/DialOk/Manual 命中
    /// 视为该地址再次在场，TTL 不再适用（其自身来源语义不变）。
    pub(crate) fn record_inbound_observed(&mut self, id: &EndpointId, addr: &str, now_ms: u64) {
        let slot = self.ensure_slot(id);
        if let Some(existing) = slot.iter_mut().find(|e| e.addr == addr) {
            if existing.source == AddrSource::ObservedInbound {
                existing.learned_at_ms = now_ms;
            }
            return;
        }
        slot.push(AddrEntry {
            addr: addr.to_owned(),
            source: AddrSource::ObservedInbound,
            last_success_ms: 0,
            learned_at_ms: now_ms,
            fail_count: 0,
        });
        Self::cap_observed(slot);
        Self::cap_addrs(slot);
    }

    /// 整个拨号计划失败（主 endpoint + 独立 endpoint 两步全败）：全部可淘汰
    /// 条目计一次失败并立即修剪（失败 ≥3 或观测 TTL 到期即逐出）。
    pub(crate) fn record_dial_failure(&mut self, id: &EndpointId, now_ms: u64) {
        if let Some(slot) = self.map.get_mut(id) {
            for e in slot.iter_mut() {
                e.fail_count = e.fail_count.saturating_add(1);
            }
        }
        self.prune(id, now_ms);
    }

    /// 惰性修剪（ordered_addrs / record_dial_failure 调用）：
    /// - ObservedInbound 未验证且超过 [`OBSERVED_TTL_MS`]；
    /// - 可淘汰来源失败计数 ≥ [`FAIL_EVICT_THRESHOLD`]；
    /// - ObservedInbound 条数 > [`OBSERVED_CAP`]（按 learned_at 留最新）。
    fn prune(&mut self, id: &EndpointId, now_ms: u64) {
        let Some(slot) = self.map.get_mut(id) else {
            return;
        };
        let before = slot.clone();
        slot.retain(|e| {
            if e.source == AddrSource::ObservedInbound
                && e.last_success_ms == 0
                && now_ms.saturating_sub(e.learned_at_ms) > OBSERVED_TTL_MS
            {
                return false;
            }
            if e.source.fail_evictable() && e.fail_count >= FAIL_EVICT_THRESHOLD {
                return false;
            }
            true
        });
        // 末位保留（仅失败淘汰路径）：整计划拨号失败可由对端侧滞留状态造成
        //（对活地址的拨号同样停滞——真双机实证：mini 换新后对旧 iMac 的拨号
        // 连续失败，全部可淘汰条目过阈清空 → NoAddressingInfo 连重试资本都
        // 没有）。TTL 过期（时间证据）不在此列——纯墓地清空是正确终态。
        if slot.is_empty() && !before.is_empty() {
            let ttl_evicted = |e: &AddrEntry| {
                e.source == AddrSource::ObservedInbound
                    && e.last_success_ms == 0
                    && now_ms.saturating_sub(e.learned_at_ms) > OBSERVED_TTL_MS
            };
            let mut candidates: Vec<AddrEntry> =
                before.iter().filter(|e| !ttl_evicted(e)).cloned().collect();
            if let Some(best) = candidates
                .iter_mut()
                .max_by_key(|e| (e.last_success_ms, e.learned_at_ms))
            {
                best.fail_count = 0;
                let restored = best.clone();
                slot.push(restored);
            }
        }
        Self::cap_observed(slot);
        Self::cap_addrs(slot);
    }

    /// 确保 endpoint 槽位存在；新 endpoint 在全局满时先按 FIFO 淘汰最旧。
    fn ensure_slot(&mut self, id: &EndpointId) -> &mut Vec<AddrEntry> {
        if !self.map.contains_key(id) {
            while self.order.len() >= MAX_ENDPOINTS {
                let Some(victim) = self.order.pop_front() else {
                    break;
                };
                self.map.remove(&victim);
                tracing::debug!("known_addrs global cap reached: evicted oldest endpoint (HB 3.1)");
            }
            self.order.push_back(*id);
        }
        self.map.entry(*id).or_default()
    }

    /// per-endpoint 地址上限：超限按学习序淘汰最旧（容量常数小，头部 drain
    /// 代价可忽略）。
    fn cap_addrs(v: &mut Vec<AddrEntry>) {
        if v.len() > MAX_ADDRS_PER_ENDPOINT {
            let overflow = v.len() - MAX_ADDRS_PER_ENDPOINT;
            v.drain(..overflow);
        }
    }

    /// ObservedInbound 条数上限：按 learned_at 留最新（scratch 端点每代一条，
    /// 墓地累积的量级控制）。
    fn cap_observed(v: &mut Vec<AddrEntry>) {
        let observed: Vec<usize> = v
            .iter()
            .enumerate()
            .filter(|(_, e)| e.source == AddrSource::ObservedInbound)
            .map(|(i, _)| i)
            .collect();
        if observed.len() <= OBSERVED_CAP {
            return;
        }
        // learned_at 最旧的 excess 条淘汰（下标从大到小 remove 保持稳定）
        let mut victims: Vec<(u64, usize)> = observed
            .into_iter()
            .map(|i| (v[i].learned_at_ms, i))
            .collect();
        victims.sort();
        let excess = victims.len() - OBSERVED_CAP;
        let mut drop_idx: Vec<usize> = victims[..excess].iter().map(|(_, i)| *i).collect();
        drop_idx.sort_unstable();
        for i in drop_idx.into_iter().rev() {
            v.remove(i);
        }
    }

    /// 持久化快照（endpoint z32 展示串 -> 可持久条目，插入序保持）。
    /// **ObservedInbound 不落盘**（E1′：scratch 临时端口跨重启存活的唯一通道
    /// 必须堵死）；空 endpoint 不出条目。
    pub(crate) fn snapshot_for_persist(&self) -> Vec<(String, Vec<PersistedAddr>)> {
        self.order
            .iter()
            .filter_map(|id| {
                self.map.get(id).map(|v| {
                    (
                        crate::identity::endpoint_id_display(id),
                        v.iter()
                            .filter(|e| e.source.persistable())
                            .map(|e| PersistedAddr {
                                addr: e.addr.clone(),
                                src: e.source.as_str().to_owned(),
                                last_ok: e.last_success_ms,
                                learned_at: e.learned_at_ms,
                            })
                            .collect::<Vec<_>>(),
                    )
                })
            })
            .filter(|(_, v)| !v.is_empty())
            .collect()
    }

    /// 从持久化快照重建（坏键跳过——advisory 数据不 fail-fast）。
    /// v1 字符串条目（无来源信息，含 E1′ 墓地脏数据）降级为 ObservedInbound：
    /// 不落盘、TTL 修剪，首个成功拨号后以 DialOk 重新落盘。**迁移宽限**：
    /// v1 条目 learned_at 记为加载时刻（`now_ms`）——存量文件里唯一的活路由
    ///（如 mini 的 announced 3341）先按观测候选参与拨号，10 分钟窗口内拨通
    /// 即升格 DialOk 落盘；死地址（scratch 墓地）失败计分/TTL 淘汰。若记 0
    /// 则加载即全数 TTL 过期，重启（open 路径不重跑 join）后无候选可拨。
    pub(crate) fn from_persisted(entries: Vec<(String, Vec<PersistEntry>)>, now_ms: u64) -> Self {
        let mut out = Self::default();
        for (id_str, addrs) in entries {
            let Ok(id) = crate::identity::endpoint_id_parse(&id_str) else {
                continue;
            };
            let slot = out.ensure_slot(&id);
            for entry in addrs {
                let e = match entry {
                    PersistEntry::V2(p) => AddrEntry {
                        addr: p.addr,
                        source: AddrSource::parse(&p.src),
                        last_success_ms: p.last_ok,
                        learned_at_ms: p.learned_at,
                        fail_count: 0,
                    },
                    PersistEntry::V1(addr) => AddrEntry {
                        addr,
                        source: AddrSource::ObservedInbound,
                        last_success_ms: 0,
                        learned_at_ms: now_ms,
                        fail_count: 0,
                    },
                };
                if !slot.iter().any(|x| x.addr == e.addr) {
                    slot.push(e);
                }
            }
            Self::cap_addrs(slot);
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// PublicKey::from_bytes 校验点有效性——随机字节不是合法 ed25519 公钥，
    /// 经 SecretKey 派生（全局容量测试 65k+ 次派生，单次 ~20µs，总耗时 ~1.5s）。
    fn eid(seed: u32) -> EndpointId {
        let mut b = [0u8; 32];
        b[..4].copy_from_slice(&seed.to_le_bytes());
        iroh_base::SecretKey::from_bytes(&b).public()
    }

    #[test]
    fn announce_upsert_replaces_only_announced_class() {
        let mut ka = KnownAddrs::default();
        let id = eid(1);
        ka.announce(id, vec!["192.0.2.1:1".into()], 100);
        ka.record_dial_success(&id, "192.0.2.2:2", 200);
        ka.record_inbound_observed(&id, "192.0.2.3:3", 300);
        // 新宣告集不含 192.0.2.1:1 → 旧宣告撤销；其它来源保留
        ka.announce(id, vec!["192.0.2.9:9".into()], 400);
        let entries = ka.entries(&id);
        assert!(!entries.iter().any(|e| e.addr == "192.0.2.1:1"));
        assert!(entries.iter().any(|e| e.addr == "192.0.2.9:9"
            && e.source == AddrSource::Announced
            && e.last_success_ms == 400));
        assert!(
            entries
                .iter()
                .any(|e| e.addr == "192.0.2.2:2" && e.source == AddrSource::DialOk)
        );
        assert!(
            entries
                .iter()
                .any(|e| e.addr == "192.0.2.3:3" && e.source == AddrSource::ObservedInbound)
        );
    }

    #[test]
    fn inbound_observed_upgrades_to_dial_ok_on_success() {
        let mut ka = KnownAddrs::default();
        let id = eid(2);
        ka.record_inbound_observed(&id, "192.0.2.5:5", 100);
        ka.record_dial_success(&id, "192.0.2.5:5", 200);
        let e = ka
            .entries(&id)
            .iter()
            .find(|e| e.addr == "192.0.2.5:5")
            .unwrap();
        assert_eq!(e.source, AddrSource::DialOk);
        assert_eq!(e.last_success_ms, 200);
    }

    #[test]
    fn observed_never_persisted_but_announced_and_dial_ok_are() {
        let mut ka = KnownAddrs::default();
        let id = eid(3);
        ka.announce(
            id,
            vec!["192.0.2.1:1".into(), "https://r.example".into()],
            100,
        );
        ka.record_dial_success(&id, "192.0.2.2:2", 200);
        ka.record_inbound_observed(&id, "192.0.2.3:3", 300);
        ka.record_manual(id, "192.0.2.4:4".into(), 400);
        let snap = ka.snapshot_for_persist();
        assert_eq!(snap.len(), 1);
        let addrs: Vec<&str> = snap[0].1.iter().map(|p| p.addr.as_str()).collect();
        assert_eq!(
            addrs,
            vec![
                "192.0.2.1:1",
                "https://r.example",
                "192.0.2.2:2",
                "192.0.2.4:4"
            ]
        );
        assert!(snap[0].1.iter().all(|p| p.src != "observed"));
    }

    #[test]
    fn v1_entries_load_as_observed_and_expire_by_ttl() {
        let mut ka = KnownAddrs::from_persisted(
            vec![(
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(), // 坏键跳过
                vec![PersistEntry::V1("192.0.2.1:1".into())],
            )],
            100,
        );
        assert!(ka.entries(&eid(9)).is_empty());
        // 真键（经 z32 展示串）：v1 字符串 → ObservedInbound、learned_at=0
        let id = eid(4);
        let id_str = crate::identity::endpoint_id_display(&id);
        ka = KnownAddrs::from_persisted(
            vec![(
                id_str,
                vec![
                    PersistEntry::V1("192.0.2.1:1".into()),
                    PersistEntry::V2(PersistedAddr {
                        addr: "192.0.2.2:2".into(),
                        src: "announced".into(),
                        last_ok: 0,
                        learned_at: 0,
                    }),
                ],
            )],
            100,
        );
        let entries = ka.entries(&id);
        assert!(
            entries
                .iter()
                .any(|e| e.addr == "192.0.2.1:1" && e.source == AddrSource::ObservedInbound)
        );
        assert!(
            entries
                .iter()
                .any(|e| e.addr == "192.0.2.2:2" && e.source == AddrSource::Announced)
        );
        // 迁移宽限内（learned_at=加载时刻 100，距今未超 TTL）：v1 条目仍在
        // 候选（存量活路由先可拨）；过期后被惰性修剪淘汰，announced 保留
        assert_eq!(
            ka.ordered_addrs(&id, 100 + OBSERVED_TTL_MS - 1),
            vec!["192.0.2.2:2".to_owned(), "192.0.2.1:1".to_owned()]
        );
        let ordered = ka.ordered_addrs(&id, 100 + OBSERVED_TTL_MS + 1);
        assert_eq!(ordered, vec!["192.0.2.2:2".to_owned()]);
    }

    /// v1 持久化文件经 serde untagged 解析（真双机现场形态字节）+ 迁移宽限：
    /// 条目 learned_at=加载时刻，宽限窗内为可拨候选（E1′ 修复后 mini 重启
    /// （open 路径不重跑 join）必须仍有路由可拨——曾因 learned_at=0 加载即
    /// 全数 TTL 过期导致 no addressing information）。
    /// 末位保留（E1′ 双机实证）：无 Announced 兜底时，整计划拨号失败不把
    /// 候选清空——保留最优先一条（成功优先），否则 NoAddressingInfo 死局。
    #[test]
    fn dial_failures_never_empty_the_candidate_set() {
        let mut ka = KnownAddrs::default();
        let id = eid(11);
        ka.record_dial_success(&id, "192.0.2.1:1", 100);
        ka.record_inbound_observed(&id, "192.0.2.2:2", 100);
        for i in 0..(FAIL_EVICT_THRESHOLD + 3) {
            ka.record_dial_failure(&id, 200 + i as u64);
        }
        let ordered = ka.ordered_addrs(&id, 10_000);
        assert_eq!(
            ordered,
            vec!["192.0.2.1:1".to_owned()],
            "失败淘汰后仍保留最优先一条候选（拨号成功过者优先）"
        );
        // TTL 过期（时间证据）不适用末位保留：宽限窗过后纯墓地清空为终态
        let id2 = eid(12);
        ka.record_inbound_observed(&id2, "192.0.2.3:3", 100);
        assert_eq!(
            ka.ordered_addrs(&id2, 100 + OBSERVED_TTL_MS + 1),
            Vec::<String>::new()
        );
    }

    #[test]
    fn v1_file_bytes_parse_with_migration_grace() {
        let raw = r#"[["3pyssy4pexat7ez7jbtqwwzgytg3dj7opj84qbuxpdcp9bd3g1ay",["192.168.2.8:3341","192.168.2.8:56873","192.168.2.8:52169"]]]"#;
        let parsed: Vec<(String, Vec<PersistEntry>)> =
            serde_json::from_str(raw).expect("v1 file shape parses");
        let mut ka = KnownAddrs::from_persisted(parsed, 1_000);
        let id = crate::identity::endpoint_id_parse(
            "3pyssy4pexat7ez7jbtqwwzgytg3dj7opj84qbuxpdcp9bd3g1ay",
        )
        .expect("z32 key parses");
        assert_eq!(
            ka.entries(&id).len(),
            3,
            "三地址全部加载（来源=ObservedInbound）"
        );
        let ordered = ka.ordered_addrs(&id, 1_500);
        assert_eq!(
            ordered.len(),
            3,
            "宽限窗内全部可拨（含活 3341 与死 scratch 端口）"
        );
        assert!(ordered.contains(&"192.168.2.8:3341".to_owned()));
        // 宽限窗过后未验证条目全数淘汰
        let expired = ka.ordered_addrs(&id, 1_000 + OBSERVED_TTL_MS + 1);
        assert!(expired.is_empty());
    }

    #[test]
    fn dial_failures_evict_non_announced_after_threshold() {
        let mut ka = KnownAddrs::default();
        let id = eid(5);
        ka.announce(id, vec!["192.0.2.1:1".into()], 100);
        ka.record_dial_success(&id, "192.0.2.2:2", 100);
        ka.record_inbound_observed(&id, "192.0.2.3:3", 100);
        for i in 0..FAIL_EVICT_THRESHOLD {
            ka.record_dial_failure(&id, 200 + i as u64);
        }
        let ordered = ka.ordered_addrs(&id, 300);
        assert_eq!(
            ordered,
            vec!["192.0.2.1:1".to_owned()],
            "announced survives; others evicted"
        );
        // 成功清零：失败 2 次后成功 → 条目保留
        let id2 = eid(6);
        ka.record_inbound_observed(&id2, "192.0.2.4:4", 100);
        ka.record_dial_failure(&id2, 200);
        ka.record_dial_failure(&id2, 300);
        ka.record_dial_success(&id2, "192.0.2.4:4", 400);
        ka.record_dial_failure(&id2, 500);
        assert_eq!(
            ka.ordered_addrs(&id2, 600),
            vec!["192.0.2.4:4".to_owned()],
            "success resets fail count"
        );
    }

    #[test]
    fn ordered_addrs_priority_announced_manual_dialok_observed() {
        let mut ka = KnownAddrs::default();
        let id = eid(7);
        ka.record_inbound_observed(&id, "192.0.2.9:9", 100); // observed 新
        ka.record_dial_success(&id, "192.0.2.5:5", 100); // dial-ok 旧成功
        ka.record_dial_success(&id, "192.0.2.6:6", 500); // dial-ok 新成功
        ka.record_manual(id, "192.0.2.3:3".into(), 100);
        ka.announce(id, vec!["192.0.2.1:1".into()], 100);
        ka.record_inbound_observed(&id, "192.0.2.8:8", 900); // observed 更新
        assert_eq!(
            ka.ordered_addrs(&id, 1000),
            vec![
                "192.0.2.1:1".to_owned(),
                "192.0.2.3:3".to_owned(),
                "192.0.2.6:6".to_owned(),
                "192.0.2.5:5".to_owned(),
                "192.0.2.8:8".to_owned(),
                "192.0.2.9:9".to_owned(),
            ]
        );
    }

    #[test]
    fn observed_cap_keeps_most_recent() {
        let mut ka = KnownAddrs::default();
        let id = eid(8);
        for i in 0..(OBSERVED_CAP as u64 + 3) {
            ka.record_inbound_observed(&id, &format!("192.0.2.1:{i}"), i * 100);
        }
        let observed_count = ka
            .entries(&id)
            .iter()
            .filter(|e| e.source == AddrSource::ObservedInbound)
            .count();
        assert_eq!(observed_count, OBSERVED_CAP, "observed 条数上限");
        // 留下的是 learned_at 最新的 OBSERVED_CAP 条
        let addrs = ka.ordered_addrs(&id, 10_000);
        assert!(!addrs.contains(&"192.0.2.1:0".to_owned()));
        assert!(addrs.contains(&format!("192.0.2.1:{}", OBSERVED_CAP + 2)));
    }

    #[test]
    fn set_empty_clears_content_but_keeps_bounded() {
        let mut ka = KnownAddrs::default();
        let id = eid(10);
        ka.record_inbound_observed(&id, "192.0.2.1:1", 100);
        // 宣告空集 = 撤销全部宣告（此端点无宣告，无变化）；条目仍受 TTL 管
        ka.announce(id, Vec::new(), 200);
        assert_eq!(ka.entries(&id).len(), 1);
    }
}
