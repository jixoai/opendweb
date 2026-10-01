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
  /** home-hub 2b：member 姿态（不生成配对码；connect/nodes 403；/api/* 404 零出站） */
  member?: boolean;
  /** home-hub 2b：hub 本机自动形态标记（row 2——/sidecar/state.hub_local） */
  hubLocal?: boolean;
  /** home-hub 2b：DWEB_HOME（注入即启用 /sidecar 本机数据面） */
  homeDir?: string | null;
  /** hub 投影注入面（机器名/网卡/探测 fetch/锁 pid 存活；测试用） */
  hostname?: string;
  interfaces?: NodeJS.Dict<import("node:os").NetworkInterfaceInfo[]> | null;
  homeFetch?: typeof fetch;
  homeIsPidAlive?: (pid: number) => boolean;
  homeProbeTimeoutMs?: number;
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

// ---- core/home.mjs + core/cardkit.mjs（home-hub 2b/2c 本机数据面与接入卡片） ----

export type LaunchKind = "hub-local" | "member" | "setup";

export interface LaunchDecision {
  kind: LaunchKind;
  hubState: Record<string, unknown> | null;
  /** hub-local 且可读时非 null——只进调用方进程内存，绝不入 argv/URL/浏览器状态 */
  hubToken: string | null;
  hubBase: string | null;
}

/** 无参启动分流（design §4.2 五行表 row 2-5；row 1 显式 --server 由调用方先行）。 */
export function resolveLaunch(input: {
  home: string;
  setup?: boolean;
  readToken?: (home: string) => Promise<string>;
}): Promise<LaunchDecision>;

export interface LeaseProjectionEntry {
  id: string;
  server: string;
  relay_url: string;
  server_id: string | null;
  fabric_id: string;
  root: string;
  alias: string | null;
  label: string | null;
  registered_at: number;
  expires_at: number;
  /** 毫秒（可负=已过期）；本地快照语义——管理端续期不回写本机 */
  expires_in: number | null;
  receipt: unknown;
}

export function leasesProjection(
  home: string,
  ctx?: { now?: () => number },
): Promise<{ leases: LeaseProjectionEntry[] }>;

export interface VisitProjectionEntry {
  server: string;
  server_id: string | null;
  first_visit_at: number;
  last_visit_at: number | null;
  last_probe: { result: "reachable" | "unreachable"; detail?: string; at: number };
  note: string | null;
}

export function visitsProjection(home: string): Promise<{ visits: VisitProjectionEntry[] }>;

/** 五类映射探测 + visits.json 落账（锁写复用 opendweb leases.mjs）。 */
export function probeVisit(
  home: string,
  server: string,
  ctx?: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    now?: () => number;
    isPidAlive?: (pid: number) => boolean;
  },
): Promise<{
  probe: { result: "reachable" | "unreachable"; detail: string | null; at: number };
  entry: VisitProjectionEntry;
}>;

export const LABEL_MAX_BYTES: number;

/** label 行内编辑写入口（leases.mjs 锁协议；空串归一 null；未知 id not-found）。 */
export function setLeaseLabel(
  home: string,
  id: string,
  label: string | null,
  ctx?: { now?: () => number; isPidAlive?: (pid: number) => boolean },
): Promise<
  | { ok: true; lease: LeaseProjectionEntry }
  | { ok: false; code: "too-long" | "not-found" | "lock" }
>;

export interface HubProjection {
  version: number;
  machine: string;
  urls: string[];
  primary_url: string;
  short_code: string;
  qr_svg: string;
  gateway_bind: string;
  running: boolean;
}

/** hub.json 投影 + 接入卡片模型（与 CLI hub card 同源）；无 hub.json → null。 */
export function hubProjection(
  home: string,
  ctx?: { hostname?: string; interfaces?: object; fetchImpl?: typeof fetch },
): Promise<HubProjection | null>;

/** getSnapshot().hub 槽位数据（fs-only；running=null=未探测）。 */
export function hubSnapshotSlot(
  home: string,
  ctx?: { hostname?: string; interfaces?: object },
): Promise<{ present: true; machine: string; primary_url: string; short_code: string; running: null } | null>;

/** 接入卡片数据模型（与 CLI printHubCard 同一推导；输出即 renderHubCard 入参形状）。 */
export function hubCardModel(input: {
  hostname?: string;
  interfaces?: NodeJS.Dict<import("node:os").NetworkInterfaceInfo[]>;
  gatewayBind?: string;
}): { machine: string; urls: string[]; primaryUrl: string; shortCode: string; port: number };

/** 二维码 SVG（与终端 ASCII 同一 qrMatrix 矩阵的 webui 渲染层）。 */
export function qrSvg(text: string, opts?: { scale?: number }): string;

/** CLI `hub card` 同一渲染函数（懒加载 re-export——hub.mjs 传递依赖重，按需加载）。 */
export function loadRenderHubCard(): Promise<
  (input: { machine: string; urls: string[]; primaryUrl: string; shortCode: string }) => string
>;

// ---- core/console.mjs（进程内宿主） ----

export interface HubSlot {
  present: true;
  machine: string;
  primary_url: string;
  short_code: string;
  running: boolean | null;
}

export interface ConsoleSnapshot {
  mode: "setup" | "ready";
  node: PublicNode | null;
  /** home-hub 2b：hub.json 投影槽位（homeDir 数据面启用时；无 hub.json=null） */
  hub: HubSlot | null;
  /** admin | member（member=本机数据面姿态，SPA 不进 setup） */
  role: "admin" | "member";
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

// ---- core/plugins/*（webui-plugin-kernel Phase 0：插件宿主地基） -----------------
//
// WebUI 插件契约 ./opendweb-webui-plugin（webuiApi 1）——独立于 CLI
// ./opendweb-plugin（apiVersion 1 零变化）。Phase 0 宿主只静态注册编译内置的
// ports/files/sync 占位 descriptor；第一个真实导出该子路径的 workspace 包在
// Phase 1（@jixo/opendweb-ext-ports）。

export const WEBUI_PLUGIN_API: 1;

export type PluginPagePerspective = "admin" | "member" | "both";
export type PluginPageType = "settings" | "page";

export interface WebuiPluginPage {
  id: string;
  title: string;
  /** 导航区（"tools"=SideNav 工具区）；null/缺省=不进导航 */
  nav?: string | null;
  /** lucide 图标名（kebab-case；可缺省） */
  icon?: string | null;
  /** settings=通用 renderer（简单配置/表格页）；page=插件专属组件 */
  type: PluginPageType;
  /** 视角可见性 */
  perspective: PluginPagePerspective;
  /** 宿主编译期绑定的 Svelte 组件（非 wire 契约；可缺省） */
  component?: unknown;
}

export interface PluginConfigProperty {
  type: "string" | "number" | "boolean";
}

export interface PluginConfigSchema {
  type: "object";
  properties: Record<string, PluginConfigProperty>;
  required?: string[];
}

export interface WebuiPluginDescriptor {
  id: string;
  webuiApi: 1;
  pages: WebuiPluginPage[];
  /** 声明面（后续 Phase 消费；可缺省） */
  routes?: Array<{ id: string }>;
  /** 声明面（/wpk1 wire 端点；可缺省） */
  dataEndpoints?: Array<{ id: string; path?: string }>;
  configSchema: PluginConfigSchema;
}

/** descriptor 校验（字段集冻结：未知字段拒绝；信任模型=可信插件，非沙箱）。 */
export function validateWebuiPluginDescriptor(
  value: unknown,
): { ok: true; value: WebuiPluginDescriptor } | { ok: false; error: string };

/** config 值校验（未知键/类型不符/缺 required 拒绝；返回规范化副本）。 */
export function validatePluginConfig(
  schema: PluginConfigSchema,
  values: unknown,
): { ok: true; value: Record<string, string | number | boolean> } | { ok: false; error: string };

/** 内置四插件 descriptor（ports/files/sync/ai——ai 自 Phase C 实现入册；每调用返回新对象）。 */
export function builtinWebuiPluginDescriptors(): WebuiPluginDescriptor[];

/** 「即将推出」占位清单（[W6]：vpn/clash/ssh/screen——无实现仅展示；ai 已实现入册不在列）。 */
export function comingSoonPlugins(): Array<{ id: string }>;

/** 外部 WebUI 插件标注（v1=后续版本；安装仅 CLI；CLI 命令插件不可被 webui 启用）。 */
export const EXTERNAL_WEBUI_PLUGINS_NOTE: string;

export function assertDescriptorsValid(
  descriptors: WebuiPluginDescriptor[],
): { ok: true } | { ok: false; error: string };

export type PluginStatus = "registered" | "enabled" | "disabled";

export interface PublicWebuiPlugin {
  id: string;
  webui_api: 1;
  status: PluginStatus;
  pages: Array<{
    id: string;
    title: string;
    nav: string | null;
    icon: string | null;
    type: PluginPageType;
    perspective: PluginPagePerspective;
  }>;
  config_schema: PluginConfigSchema;
  config: Record<string, string | number | boolean>;
}

/** Phase 1+ 运行时钩子通道（契约 descriptor 不承载可调用物）。 */
export interface PluginRuntime {
  onEnable?(ctx: { home: string; dataDir: string }): Promise<void>;
  onDispose?(): Promise<void>;
}

export interface PluginHost {
  list(): {
    plugins: PublicWebuiPlugin[];
    coming_soon: Array<{ id: string }>;
    external_webui_plugins: { available: boolean; note: string };
  };
  get(id: string): PublicWebuiPlugin | null;
  /** 摘牌语义：仅 enabled 接受新活动 */
  isAccepting(id: string): boolean;
  /** 登记在途活动；非 enabled → 稳定拒绝 */
  beginActivity(
    id: string,
    activity: { cancel: () => void },
  ): { ok: true; end: () => void } | { ok: false; code: "plugin-disabled" | "unknown-plugin" };
  enable(id: string): Promise<{ ok: true; plugin: PublicWebuiPlugin } | { ok: false; code: "unknown-plugin" | "busy" | "lock" }>;
  disable(id: string): Promise<
    | { ok: true; plugin: PublicWebuiPlugin; drained: boolean; timedOut: boolean }
    | { ok: false; code: "unknown-plugin" | "invalid-transition" | "busy" | "lock" }
  >;
  getConfig(id: string): Record<string, string | number | boolean> | null;
  setConfig(
    id: string,
    values: unknown,
  ): Promise<
    | { ok: true; config: Record<string, string | number | boolean> }
    | { ok: false; code: "unknown-plugin" | "busy" | "invalid-config" | "lock"; error?: string }
  >;
  dataDir(id: string): string;
  /** 拆运行时不落盘（重启按账本恢复）；幂等 */
  close(): Promise<void>;
  onTransition: ((id: string, transition: string) => void) | null;
}

export const DRAIN_TIMEOUT_MS: number;

/** 停用 drain 默认 10s（可配） */
export function createPluginHost(opts?: {
  home: string;
  descriptors?: WebuiPluginDescriptor[];
  runtimes?: Record<string, PluginRuntime>;
  drainTimeoutMs?: number;
  now?: () => number;
}): Promise<PluginHost>;

// 运行账本 <DWEB_HOME>/plugins/state.json（0600 原子写 + acquireFileLock 家族；
// 安装账本 ~/.opendweb/plugins.json 零接触）

export const PLUGINS_DIR: string;
export const STATE_FILE: string;
export const STATE_LOCK: string;

export interface PluginStateFile {
  version: 1;
  plugins: Record<string, { status: PluginStatus; config?: Record<string, string | number | boolean> }>;
}

export function pluginStatePath(home: string): string;
export function loadPluginState(home: string): Promise<PluginStateFile>;
export function mutatePluginState(
  home: string,
  fn: (state: PluginStateFile) => void | Promise<void>,
  ctx?: { now?: () => number; isPidAlive?: (pid: number) => boolean },
): Promise<{ ok: true } | { ok: false; code: "lock" }>;
export function ensurePluginDataDir(home: string, id: string): Promise<string>;
