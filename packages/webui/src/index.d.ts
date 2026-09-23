// 手写类型声明（home-hub [H4] Phase 2a / design §5.1）——"." 导出面的公共契约。
// 与 src/*.mjs 的 JSDoc 注释同源；实现细节（createSidecar 内部句柄）不在此面。

// ---- core/target.mjs ----

export interface TargetValue {
  scheme: "http" | "https";
  hostname: string;
  port: number;
  hostHeader: string;
  connectHost: string;
  servername: string | null;
  insecure: boolean;
}

export interface TargetDns {
  lookup(
    hostname: string,
    opts: { all: true },
  ): Promise<Array<{ address: string; family: number }>>;
}

export function validateTarget(
  rawUrl: string,
  opts?: { allowInsecure?: boolean; dns?: TargetDns },
): Promise<{ ok: true; value: TargetValue } | { ok: false; error: string }>;

export const defaultDns: TargetDns;

// ---- core/nodes.mjs ----

export interface NodeEntry {
  id: string;
  name: string;
  server_host: string;
  token: string;
  added_at: number;
}

export interface PublicNode {
  id: string;
  name: string;
  server_host: string;
  added_at: number;
  current: boolean;
}

export const NODES_FILE_VERSION: number;

export class NodeStoreError extends Error {}

export class NodeStore {
  constructor(file: string);
  readonly file: string;
  readonly nodes: NodeEntry[];
  load(): Promise<void>;
  get(id: string): NodeEntry | null;
  add(input: {
    name?: string;
    server_host: string;
    token: string;
    added_at: number;
    id?: string;
  }): Promise<NodeEntry>;
  remove(id: string): Promise<NodeEntry | null>;
}

export function publicNode(entry: Omit<NodeEntry, "token">, current: boolean): PublicNode;

// ---- core/sidecar.mjs ----

export const LIMITS: {
  readonly requestBytes: number;
  readonly responseBytes: number;
  readonly upstreamTimeoutMs: number;
  readonly pairingTtlMs: number;
  readonly pairingMaxFailures: number;
};

export interface SidecarOptions {
  /** validateTarget 成功值（给出即 ready；缺省 setup 模式） */
  target?: TargetValue | null;
  /** admin token（内存 + 节点簿例外下的 0600 nodes.json；不落任何日志/响应） */
  token?: string;
  port?: number;
  distDir?: string;
  log?: (line: string) => void;
  allowInsecure?: boolean;
  dns?: TargetDns;
  now?: () => number;
  /** nodesFile 给出即启用节点簿；nodesStore 直接注入实例（优先于 nodesFile） */
  nodesFile?: string | null;
  nodesStore?: NodeStore | null;
}

export interface Sidecar {
  port: number;
  origin: string;
  url: string;
  mode(): "setup" | "ready";
  pairingCode: string | null;
  nodePairingCode(): string | null;
  close(): Promise<void>;
}

/** 既有入口（签名与返回形状零破坏——home-hub 2a 分层后不变）。 */
export function startSidecar(opts?: SidecarOptions): Promise<Sidecar>;

export function parseApiPath(
  rawUrl: string,
): { ok: true; value: { rel: string; query: string } } | { ok: false; error: string };

export function maskTarget(t: {
  scheme: "http" | "https";
  hostname: string;
  port: number;
}): string;

export function generatePairingCode(random?: (n: number) => Buffer): string;

// ---- core/events.mjs（事件 schema v1） ----

export type EventType = "state-change" | "node-switch" | "knock-pending" | "error";

export interface EventFrame {
  v: 1;
  type: EventType;
  payload: unknown;
  ts: number;
}

export const EVENT_TYPES: readonly EventType[];

export function eventFrame(type: EventType, payload: unknown, ts: number): EventFrame;

export class EventBus {
  constructor(opts?: { now?: () => number });
  readonly closed: boolean;
  /** 订阅（close 后抛错）；返回幂等 disposer */
  on(type: EventType, fn: (frame: EventFrame) => void): () => void;
  /** 发射（close 后静默；订阅者异常被隔离） */
  emit(type: EventType, payload: unknown): void;
  close(): void;
}

// ---- core/capability.mjs（会话 capability v1） ----

export const CAPABILITY_TTL_MS: number;

export type CapabilityConsumeResult =
  | { ok: true }
  | { ok: false; reason: "invalid" | "replay" | "expired" };

export interface CapabilityRegistry {
  /** 签发（≥128-bit CSPRNG → base64url；值只进内存与调用方 URL） */
  issue(): string;
  /** 单次消费判定（重放=replay；懒惰过期=expired；未知/跨实例/close 后=invalid） */
  consume(value: string): CapabilityConsumeResult;
  close(): void;
  readonly size: number;
}

export function createCapabilities(opts?: {
  ttlMs?: number;
  now?: () => number;
  random?: (n: number) => Buffer;
}): CapabilityRegistry;

// ---- core/console.mjs（进程内宿主） ----

export interface ConsoleSnapshot {
  mode: "setup" | "ready";
  node: PublicNode | null;
  /** home-hub 2b 槽位：hub.json 投影落地后填充（2a 冻结为 null） */
  hub: null;
}

export interface ConsoleHandle {
  /** 纯函数：生成带一次性会话 capability 的 URL（core 只生成，不打开） */
  urlFor(deepLink?: string): string;
  /** 经注入的 opts.opener(url) 打开（core 零浏览器 spawn） */
  open(deepLink?: string): void;
  mode(): "setup" | "ready";
  /** 调用时刻同步快照（三视角数据面 2b/2c 落地；结构槽位已留） */
  getSnapshot(): ConsoleSnapshot;
  /** 订阅 schema v1 事件；返回 disposer；close 后订阅抛错 */
  onEvent(type: EventType, fn: (frame: EventFrame) => void): () => void;
  /** 进程内直调切换（不经 HTTP；失败 emit 一帧 error 后抛错） */
  switchTarget(id: string): Promise<{ node: PublicNode }>;
  /** 关闭（幂等）：sidecar 停机 + capability 即失效 + 事件静默 */
  close(): Promise<void>;
}

export function createConsole(opts: {
  /** 必填：宿主注入的打开行为（core 不自带浏览器 spawn） */
  opener: (url: string) => void;
  /** 会话 capability TTL（缺省 120s） */
  capabilityTtlMs?: number;
  /** CSPRNG 注入（测试面） */
  random?: (n: number) => Buffer;
} & SidecarOptions): Promise<ConsoleHandle>;

/** urlFor/open 的会话 capability query 参数名 */
export const CAPABILITY_QUERY_PARAM: string;
