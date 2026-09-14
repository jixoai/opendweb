# Proposal: invite-token-multi-relay

> 登记来源：relay-failover-hardening 4.2（2026-09-14 归档时留下的已知边界）。
> 本 change 仅为登记，未排期、未实现。

## Why

relay-failover-hardening 修复后，invite 令牌仍只携带**单条** relay URL（wire
格式不动）：`invite_with()` 快照 `active_url`（当前实际在线的 home relay），
快照未沉降（刚启动、net_report 未完成）时回退 `urls.first()`。

残留边界：issuer 配置 `[dead, alive]` 且**快照未沉降**时，令牌携带死条目。
joiner 侧候选合并（`with_local_relay_candidates`）可兜底**同列表**场景
（joiner 配置含同一活条目），但**跨列表配置**的 joiner（本地 relay 列表不含
issuer 的活 relay）无兜底——join 拨号候选 = 令牌死条目 + joiner 本地列表，
两者都不可达 issuer，dial-timeout。

发生概率低（需 issuer 刚启动未沉降 + 配置首条为死条目 + joiner 跨列表
三因叠加），但现场多 relay 自托管部署（docker stop 轮换）可复现该形态。

## What Changes

- 邀请令牌 wire 格式携带 relay URL **列表**（issuer 配置全量或快照优先 +
  其余候选），协议版本号升级表达（新旧格式物理隔离解析）。
- `join()` 拨号候选 = 令牌 relay 列表全量 + 本地配置全量（EndpointAddr
  内部去重），与 connect 的合并语义对齐。
- join 错误分类（8 码 + RELAY_OFFLINE 探针）的探针对象语义随之评审
  （单条 → 首选条目，或逐条探活）。

## Non-goals

- 不改 relay 状态快照/事件语义。
- 不做 relay 健康度排序（net_report preferred relay 既有语义不动）。

## Impact

- `crates/dweb-fabric/src/fabric.rs`（invite_with 签发、join 拨号构造）、
  protocol 层 InviteToken 编解码、`redeem_wire.rs` 兼容测试。
- SDK napi 投影无需变更（令牌对 JS 侧为不透明字符串）。
