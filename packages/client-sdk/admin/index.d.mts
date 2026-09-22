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

/** GET /admin/status（既有冻结 wire）。 */
export interface AdminStatus {
  mode: "open" | "restricted";
  policy: string;
  generation: number;
  max_connections_per_owner: number | null;
  active_connections: AdminEndpointOnlineInfo[];
  per_owner_connections: AdminOwnerOnlineInfo[];
  cache_entries: number;
}

/** GET /admin/owners 的单条 owner。 */
export interface AdminOwnerInfo {
  fabric_id: string;
  root: string;
  registered_at: number;
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

/** 管理面回执联合（receiptCanonical/verifyReceipt 的入参形态）。 */
export type AdminReceipt = AdminRegisterReceipt | AdminDisconnectReceipt;

/** POST /admin/connections/disconnect 响应（「已下发」非「已完成」）。 */
export interface AdminDisconnectResponse {
  disconnected: AdminEndpointOnlineInfo[];
  receipts: AdminDisconnectReceipt[];
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
}

/**
 * 回执待签载荷（与 server 侧 receipt_canonical 逐字节一致）：
 * `b"dweb/admin-receipt/v1\0" || op u8 || fabric_id 32B || target 32B ||
 * ts u64BE || generation u64BE`（全大端；register/unregister target=root，
 * disconnect target=endpoint_id）。
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
