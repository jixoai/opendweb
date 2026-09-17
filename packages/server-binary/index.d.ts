export interface StartServerOptions {
  /** gateway（rendezvous/healthz/services.json）监听地址，默认 127.0.0.1:8787 */
  gatewayBind?: string;
  /** gatewayBind 的兼容别名（同时给出时 gatewayBind 优先） */
  /** relay HTTP 监听地址，默认 127.0.0.1:3340 */
  relayBind?: string;
  /** 默认 true */
  relayEnabled?: boolean;
  /** true 时向子进程设置 DWEB_TRUST_PROXY=1（采信 X-Forwarded-Proto）；缺省继承父进程环境 */
  trustProxy?: boolean;
  /** 访问控制模式；仅显式定义时写 DWEB_ACCESS_MODE，缺省继承父进程环境 */
  accessMode?: "open" | "restricted";
  /** L2 策略选择（默认 static）；仅显式定义时写 DWEB_ACCESS_POLICY */
  accessPolicy?: "static" | "callback";
  /** owner registry 文件路径；仅显式定义时写 DWEB_OWNERS_FILE */
  ownersFile?: string;
  /** callback policy 的 webhook 入口；仅显式定义时写 DWEB_CALLBACK_URL */
  callbackUrl?: string;
  /** webhook Bearer 凭证；仅显式定义时写 DWEB_CALLBACK_TOKEN */
  callbackToken?: string;
  /** webhook 超时（1..=2000）；仅显式定义时写 DWEB_CALLBACK_TIMEOUT_MS */
  callbackTimeoutMs?: number;
  /** 决策缓存 TTL（0..=60000，0 = 禁用）；仅显式定义时写 DWEB_CALLBACK_CACHE_TTL_MS */
  callbackCacheTtlMs?: number;
  /** loopback webhook 豁免（开发用）；Rust 侧无 env，经 --allow-loopback-callback flag 传递 */
  allowLoopbackCallback?: boolean;
  /** 每客户端 relay 接收字节率上限（字节/秒，>0）；仅显式定义时写 DWEB_RELAY_CLIENT_RX */
  relayClientRx?: number;
}

export interface ServerHandle {
  pid: number;
  /** gateway 基地址 */
  gatewayUrl: string;
  /** 旧字段名保留（值同 gatewayUrl） */
  httpUrl: string;
  /** relay HTTP 基地址 */
  relayHttpUrl: string;
  /** 服务清单地址（GET /services.json） */
  servicesUrl: string;
  /** 发送 SIGINT 并等待退出（5s 后 SIGKILL 兜底），幂等 */
  stop(): Promise<void>;
  /** 进程退出码 future */
  exited: Promise<number>;
}

export declare function startServer(options?: StartServerOptions): Promise<ServerHandle>;
