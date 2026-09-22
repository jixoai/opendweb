// @jixo/opendweb-client-sdk ./admin 类型声明（sdk-mgmt-surface task 2.1）。
// 自包含（design §2.1：.d.mts 不引用包内 root/net/http 的类型）；字段为
// server spec 冻结的 snake_case wire 直映，未知字段忽略（向前兼容）。

/** 在线端点条目（status.active_connections / connections.per_endpoint 共用）。 */
export interface AdminEndpointOnlineInfo {
  endpoint_id: string;
  fabric_id: string;
  connections: number;
}

/** 按 owner 聚合的在线条目。 */
export interface AdminOwnerOnlineInfo {
  fabric_id: string;
  connections: number;
}

/** 访客在线条目（connections.per_visitor——server-access-roles Phase 1a 增量）。 */
export interface AdminVisitorOnlineInfo {
  endpoint_id: string;
  connections: number;
}

/** GET /admin/status（既有冻结 wire + Phase 1a/1c 纯增量字段）。 */
export interface AdminStatus {
  mode: "open" | "restricted";
  policy: string;
  generation: number;
  max_connections_per_owner: number | null;
  active_connections: AdminEndpointOnlineInfo[];
  per_owner_connections: AdminOwnerOnlineInfo[];
  cache_entries: number;
  /** 访客在线连接总数（Phase 1a 增量）。 */
  visitors_online: number;
  /** 敲门待办数——未 dismissed（Phase 1c 增量）。 */
  knocks_pending: number;
  /** 在册且未过期的访客数（Phase 1c 增量）。 */
  visitors_active: number;
  /** 未吊销且未过期的邀请码数（Phase 1c 增量）。 */
  codes_active: number;
}

/** GET /admin/owners 的单条 owner（alias/note/expires_at·expires_in/status 为 Phase 1c 增量）。 */
export interface AdminOwnerInfo {
  fabric_id: string;
  root: string;
  registered_at: number;
  alias?: string;
  note?: string;
  /** null = 永久租户。 */
  expires_at: number | null;
  /** 剩余毫秒；null = 永久、0 = 已过期。 */
  expires_in: number | null;
  status: "active" | "expired";
}

/** GET /admin/owners。 */
export interface AdminOwnersList {
  generation: number;
  owners: AdminOwnerInfo[];
}

/** GET /admin/connections 的配额结构。 */
export interface AdminQuota {
  configured: boolean;
  max_connections_per_owner: number | null;
}

/** GET /admin/connections（详细在线视图：mode/relay_enabled 独立拆分）。 */
export interface AdminConnectionsView {
  mode: "open" | "restricted";
  policy: string;
  relay_enabled: boolean;
  quota: AdminQuota;
  per_endpoint: AdminEndpointOnlineInfo[];
  per_owner: AdminOwnerOnlineInfo[];
  per_visitor: AdminVisitorOnlineInfo[];
}

/** register/unregister 回执（JSON snake_case wire；kicked_* 仅注销携带）。 */
export interface AdminRegisterReceipt {
  op: "register" | "unregister";
  fabric_id: string;
  root: string;
  ts: number;
  generation: number;
  /** base64url-nopad(64B)——Ed25519 over 域前缀 || canonical */
  receipt_sig: string;
  kicked_endpoints?: number;
  kicked_connections?: number;
}

/** disconnect 回执（target 用显式 endpoint_id 字段，不复用 root 键名）。 */
export interface AdminDisconnectReceipt {
  op: "disconnect";
  fabric_id: string;
  endpoint_id: string;
  ts: number;
  generation: number;
  receipt_sig: string;
}

/** renew 回执（Phase 1c op=0x04；expires_at wire 恒数字——permanent 为 u64.MAX）。 */
export interface AdminRenewReceipt {
  op: "renew";
  fabric_id: string;
  root: string;
  expires_at: number;
  ts: number;
  generation: number;
  receipt_sig: string;
}

/** visitor-grant 回执（Phase 1c op=0x05；expires_at 缺省 = 永久）。 */
export interface AdminVisitorGrantReceipt {
  op: "visitor-grant";
  /** 未用维度置零——64 个 "0"（与 canonical 置零字节同步）。 */
  fabric_id: string;
  endpoint_id: string;
  expires_at?: number;
  ts: number;
  generation: number;
  receipt_sig: string;
}

/** visitor-revoke 回执（Phase 1c op=0x06）。 */
export interface AdminVisitorRevokeReceipt {
  op: "visitor-revoke";
  fabric_id: string;
  endpoint_id: string;
  ts: number;
  generation: number;
  receipt_sig: string;
}

/** code-issue 回执（Phase 1c op=0x07；code 全文**仅此响应一次**）。 */
export interface AdminCodeIssueReceipt {
  op: "code-issue";
  fabric_id: string;
  /** `dwebc1.` + 4-4-4-4 分组——此后一切响应只含 code_hash。 */
  code: string;
  code_hash: string;
  alias_hint?: string;
  max_uses: number;
  expires_at: number;
  default_ttl_days: number;
  ts: number;
  generation: number;
  receipt_sig: string;
}

/** code-revoke 回执（Phase 1c op=0x08）。 */
export interface AdminCodeRevokeReceipt {
  op: "code-revoke";
  fabric_id: string;
  code_hash: string;
  ts: number;
  generation: number;
  receipt_sig: string;
}

/** block-add/block-remove 回执（Phase 1c op=0x09/0x0A；kind=fabric 时
 * fabric_id = id、endpoint 维度为 64 个 "0"）。 */
export interface AdminBlockReceipt {
  op: "block-add" | "block-remove";
  fabric_id: string;
  kind: "endpoint" | "fabric";
  id: string;
  reason?: string;
  ts: number;
  generation: number;
  receipt_sig: string;
}

/** knock-dismiss/knock-undismiss 回执（Phase 1c op=0x0B/0x0C；generation =
 * KnockLog 内存台账内部单调计数器）。 */
export interface AdminKnockReceipt {
  op: "knock-dismiss" | "knock-undismiss";
  fabric_id: string;
  endpoint_id: string;
  ts: number;
  generation: number;
  receipt_sig: string;
}

/** owner-meta 回执（Phase 1c op=0x0D；alias/note 为编辑后终值）。 */
export interface AdminOwnerMetaReceipt {
  op: "owner-meta";
  fabric_id: string;
  root: string;
  alias?: string;
  note?: string;
  ts: number;
  generation: number;
  receipt_sig: string;
}

/** visitor-meta 回执（Phase 1c op=0x0E；alias/note 为编辑后终值）。 */
export interface AdminVisitorMetaReceipt {
  op: "visitor-meta";
  fabric_id: string;
  endpoint_id: string;
  alias?: string;
  note?: string;
  ts: number;
  generation: number;
  receipt_sig: string;
}

/** 管理面回执联合（receiptCanonical/verifyReceipt 的入参形态）。 */
export type AdminReceipt =
  | AdminRegisterReceipt
  | AdminDisconnectReceipt
  | AdminRenewReceipt
  | AdminVisitorGrantReceipt
  | AdminVisitorRevokeReceipt
  | AdminCodeIssueReceipt
  | AdminCodeRevokeReceipt
  | AdminBlockReceipt
  | AdminKnockReceipt
  | AdminOwnerMetaReceipt
  | AdminVisitorMetaReceipt;

/** POST /register 公开兑换的成功回执（server-access-roles；与 opendweb 包
 * parseRegisterResponse 同一 wire——registerReceiptCanonical/verifyRegisterReceipt
 * 的入参形态）。 */
export interface RegisterReceipt {
  op: "register";
  code_hash: string;
  fabric_id: string;
  root: string;
  expires_at: number;
  ts: number;
  generation: number;
  receipt_sig: string;
}

/** POST /admin/connections/disconnect 响应（「已下发」非「已完成」）。 */
export interface AdminDisconnectResponse {
  disconnected: AdminEndpointOnlineInfo[];
  receipts: AdminDisconnectReceipt[];
}

/** GET /admin/knocks 的单条敲门聚合。 */
export interface AdminKnockAgg {
  endpoint_id: string;
  /** 进程内单调序号（排序键：组内 seq 降序；last_at 仅展示）。 */
  seq: number;
  first_at: number;
  last_at: number;
  count: number;
  last_reason: string;
  dismissed: boolean;
}

/** GET /admin/knocks。 */
export interface AdminKnocksList {
  knocks: AdminKnockAgg[];
  /** 恒为未 dismissed 条目数（include_dismissed 不改变语义）。 */
  pending_count: number;
}

/** GET /admin/visitors 的单条访客。 */
export interface AdminVisitorInfo {
  endpoint_id: string;
  alias?: string;
  note?: string;
  granted_at: number;
  /** 缺省 = 永久。 */
  expires_at?: number;
}

/** GET /admin/visitors。 */
export interface AdminVisitorsList {
  generation: number;
  visitors: AdminVisitorInfo[];
}

/** GET /admin/codes 的单条码（**绝不含码全文**）。 */
export interface AdminCodeInfo {
  code_hash: string;
  max_uses: number;
  used_count: number;
  expires_at?: number;
  alias_hint?: string;
  revoked: boolean;
  default_ttl_days: number;
  /** deny-set 命中（补写失败 fail-closed 的运维投影）。 */
  denied: boolean;
}

/** GET /admin/codes。 */
export interface AdminCodesList {
  generation: number;
  codes: AdminCodeInfo[];
}

/** GET /admin/blocklist 的单条名单项。 */
export interface AdminBlocklistEntry {
  kind: "endpoint" | "fabric";
  id: string;
  reason?: string;
  ts: number;
}

/** GET /admin/blocklist。 */
export interface AdminBlocklistList {
  generation: number;
  entries: AdminBlocklistEntry[];
}

/** AdminClient 构造参数。 */
export interface AdminClientOptions {
  baseUrl: string;
  token: string;
  /** 请求超时（毫秒），默认 10_000。 */
  timeoutMs?: number;
}

/**
 * 管理面错误归一：{status, code, message}。code 判别表：admin-not-enabled /
 * unauthorized / invalid-request / no-match / network / timeout / registry
 * （服务端 envelope 透传）+ `http-<status>` 形态（无 envelope 兜底）+
 * invalid-response（2xx 非 JSON 的防御性兜底）。
 */
export class AdminError extends Error {
  readonly code: string;
  readonly status: number | null;
  constructor(code: string, message: string, status?: number | null);
}

/** 注入式验签器：收 (canonical, sig64B)，返回布尔（可异步）。 */
export type ReceiptVerifier = (
  message: Uint8Array,
  signature: Uint8Array,
) => boolean | Promise<boolean>;

/** Server 管理 API 客户端（Node 18+ 全局 fetch；浏览器同构可用）。 */
export class AdminClient {
  constructor(options: AdminClientOptions);
  status(): Promise<AdminStatus>;
  listOwners(): Promise<AdminOwnersList>;
  registerOwner(fabricId: string, root: string): Promise<AdminRegisterReceipt>;
  unregisterOwner(fabricId: string, root: string): Promise<AdminRegisterReceipt>;
  connections(): Promise<AdminConnectionsView>;
  disconnect(selector: {
    endpointId?: string;
    fabricId?: string;
  }): Promise<AdminDisconnectResponse>;
  /**
   * 专用启用探测（六路互斥矩阵）：仅 200 resolve true；404 =
   * admin-not-enabled；401 = unauthorized；任意其它非 200 = `http-<status>`；
   * 网络失败 = network；超时 = timeout。不存在 false 返回值。
   */
  probeEnabled(): Promise<true>;
  // ---- server-access-roles Phase 1c：三角色管理调用 ----
  listKnocks(options?: { includeDismissed?: boolean }): Promise<AdminKnocksList>;
  dismissKnock(endpointId: string): Promise<AdminKnockReceipt>;
  undismissKnock(endpointId: string): Promise<AdminKnockReceipt>;
  listVisitors(): Promise<AdminVisitorsList>;
  grantVisitor(grant: {
    endpointId: string;
    alias?: string;
    note?: string;
    expiresInDays?: number;
  }): Promise<AdminVisitorGrantReceipt>;
  /** 语义糖路由（敲门台一键定位，等同 grantVisitor）。 */
  grantVisitorFromKnock(grant: {
    endpointId: string;
    alias?: string;
    note?: string;
    expiresInDays?: number;
  }): Promise<AdminVisitorGrantReceipt>;
  revokeVisitor(endpointId: string): Promise<AdminVisitorRevokeReceipt>;
  updateVisitorMetadata(
    endpointId: string,
    meta: { alias?: string; note?: string },
  ): Promise<AdminVisitorMetaReceipt>;
  listCodes(): Promise<AdminCodesList>;
  /** 签发——**响应含 code 全文仅此一次**。 */
  issueCode(params?: {
    aliasHint?: string;
    maxUses?: number;
    expiresInDays?: number;
    defaultTtlDays?: number;
  }): Promise<AdminCodeIssueReceipt>;
  revokeCode(codeHash: string): Promise<AdminCodeRevokeReceipt>;
  /** 续期——expiresInDays / permanent 恰好其一。 */
  renewOwner(
    fabricId: string,
    rootId: string,
    renewal: { expiresInDays?: number; permanent?: boolean },
  ): Promise<AdminRenewReceipt>;
  updateOwnerMetadata(
    fabricId: string,
    rootId: string,
    meta: { alias?: string; note?: string },
  ): Promise<AdminOwnerMetaReceipt>;
  listBlocklist(): Promise<AdminBlocklistList>;
  block(entry: {
    kind: "endpoint" | "fabric";
    id: string;
    reason?: string;
  }): Promise<AdminBlockReceipt>;
  unblock(kind: "endpoint" | "fabric", id: string): Promise<AdminBlockReceipt>;
}

/**
 * 回执待签载荷（与 server 侧 receipt_canonical 逐字节一致）：
 * `b"dweb/admin-receipt/v1\0" || op u8 || fabric_id 32B || target 32B ||
 * ts u64BE || generation u64BE`（全大端；target 字段按 op 族取
 * root / endpoint_id / code_hash / id）。
 */
export function receiptCanonical(receipt: AdminReceipt): Uint8Array;

/** 注入式验签（包不内置验签实现——调用方自带 ed25519 库）。 */
export function verifyReceipt(
  receipt: AdminReceipt,
  verifier: ReceiptVerifier,
): Promise<boolean>;

/** 从 services.json 提取回执验签公钥（server_id，hex64 小写）。 */
export function adminPublicKeyFromServices(
  servicesJson: string | object,
): string;

/**
 * register 兑换回执待签载荷（137B 定长，与 server 侧
 * register_receipt_canonical 及 opendweb 包 buildRegisterReceiptCanonical
 * 逐字节互认）：`b"dweb/register-receipt/v1\0" || code_hash 32B ||
 * fabric_id 32B || root 32B || ts u64BE || generation u64BE`。
 */
export function registerReceiptCanonical(receipt: RegisterReceipt): Uint8Array;

/** register 兑换回执注入式验签（公钥 = server_id，经调用方注入 verifier）。 */
export function verifyRegisterReceipt(
  receipt: RegisterReceipt,
  verifier: ReceiptVerifier,
): Promise<boolean>;
