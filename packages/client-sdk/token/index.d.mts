// @jixo/opendweb-client-sdk ./token 类型声明（sdk-mgmt-surface task 3.1）。
// 自包含（design §2.1 隔离规则）；只读解码显示——不验签，安全决策依赖服务端
// 验证结果而非本解码。

/** 令牌解析错误（code 判别 + 人类可读原因）。 */
export class TokenError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}

/** invite v2 的单条 relay 条目（url + 可选内嵌 capability 标注）。 */
export interface DecodedInviteRelay {
  url: string;
  /** 内嵌 `dwebr1.` 串；null = 该 relay 无凭证。 */
  capability: string | null;
  /** capability !== null 的便捷标注（spec「含是否内嵌 capability 标注」）。 */
  hasCapability: boolean;
}

/** `dweb2.` 邀请令牌解码结果（附录 A wire 字段；hex 均 64 字符小写，
 * inviteId 为 32 字符）。 */
export interface DecodedInvite {
  fabricId: string;
  inviteId: string;
  issuer: string;
  /** 预绑定对象（v2 恒必填）。 */
  recipient: string;
  /** Unix epoch ms；now >= expiresAtMs 即过期（等值即过期）。 */
  expiresAtMs: number;
  relays: DecodedInviteRelay[];
  /** SocketAddr 展示形态（IPv6 带 []，RFC 5952 压缩——与 Rust Display 同形）。 */
  directAddrs: string[];
}

/** caps 位图命名展开（bit0 relay / bit1 rdzAnnounce / bit2 rdzResolve）。 */
export interface CapabilityFlags {
  relay: boolean;
  rdzAnnounce: boolean;
  rdzResolve: boolean;
}

/** `dwebr1.` 能力令牌解码结果（§11.1 wire 字段；hex 均 64 字符小写）。 */
export interface DecodedCapability {
  fabricId: string;
  serverId: string;
  issuer: string;
  recipient: string;
  /** 原始 caps 位图（已验证无保留位）。 */
  capsBits: number;
  caps: CapabilityFlags;
  issuedAt: number;
  expiresAt: number;
  /** 签名 hex128（原样透出；本解码不验证）。 */
  signature: string;
}

/** 解码 `dweb2.` 邀请令牌（前缀/长度/字符集/保留位/计数非法 → TokenError；
 * 不返回部分解码结果）。 */
export function decodeInvite(token: string): DecodedInvite;

/** 解码 `dwebr1.` 能力令牌（caps 位图命名展开；保留位拒收）。 */
export function decodeCapability(token: string): DecodedCapability;
