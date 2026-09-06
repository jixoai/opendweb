// 正交意图（维护于 2026-09-06 Asia/Shanghai）：中文文案字典 —— `/zh/` 镜像页
// 的内容源，文案全部取自 README-zh.md（EXAMPLE-zh.md 校对术语），不虚构。
// 锚点 id 与 en 严格一致（#features/#quick-start/#packages/#ecosystem），
// 切换 locale 时锚点/路径得以保持。
//
// 原始需求（2026-09-06 Asia/Shanghai）：openspec/changes/2026-09-06-site-i18n-zh。
import type { WebsiteContent } from '$lib/i18n/schema';

export const zh: WebsiteContent = {
  meta: {
    siteTitle: 'dweb · 应用级组网平台',
    description:
      'dweb 让多设备应用组成逻辑网络——类似游戏房间，而非系统级 VPN——支持受控邀请他人加入，具备 Ed25519 身份、签名事实名册，以及带自托管 relay 回退的 iroh/QUIC 直连。',
  },
  chrome: {
    subtitle: '应用级组网',
    languageLabel: '语言',
    anchors: [
      { id: 'features', label: '特性' },
      { id: 'quick-start', label: '快速开始' },
      { id: 'packages', label: '软件包' },
      { id: 'ecosystem', label: '生态' },
    ],
    githubLabel: 'GitHub ↗',
    drawerLabel: '站点导航',
    readmeLabel: 'README（English）',
    exampleLabel: 'EXAMPLE（中文）',
  },
  hero: {
    eyebrow: 'dweb · 应用级组网',
    titleLead: '应用级',
    titleEm: '逻辑网络',
    titleTail: ' —— 类似游戏房间，不是系统级 VPN。',
    badges: [
      'Ed25519 EndpointId',
      '签名事实名册',
      'QUIC 直连 + relay 回退',
      'MIT OR Apache-2.0',
    ],
    summary:
      '让多设备应用组成逻辑网络（类似游戏房间，不是系统级 VPN），支持受控邀请他人加入；P2P 直连优先，回退到可自托管的 Relay。',
    quickStartLabel: '快速开始',
    barTitle: 'opendweb — server',
    command: 'npx opendweb server',
    outputs: [
      '* opendweb server v0.2.1',
      '> Local:   http://localhost:8787',
      '> Network: http://192.168.1.100:8787',
      'gateway 8787 · rendezvous 8787 · relay 3340',
    ],
  },
  featuresHeading: '内部构成',
  features: [
    {
      id: 'identity',
      eyebrow: '身份层',
      title: 'Ed25519 EndpointId',
      summary: '稳定身份，与网络地址解耦；展示串 z-base-32。',
    },
    {
      id: 'roster',
      eyebrow: '名册层',
      title: '签名事实，union-merge 收敛',
      summary: 'Genesis/Grant/Join/Revoke 签名事实内容寻址（BLAKE3），经 union-merge 收敛。',
    },
    {
      id: 'invites',
      eyebrow: '成员',
      title: '受控邀请加入',
      summary: 'issuer-online 单次兑换：challenge-response PoP 加 invite_id CAS 消费。',
    },
    {
      id: 'session',
      eyebrow: '会话层',
      title: 'iroh 1.1：QUIC 直连 + relay 回退',
      summary: 'QUIC 直连带 NAT 穿透；回退到可自托管 relay。两侧门控——先门控后数据。',
    },
    {
      id: 'sync',
      eyebrow: '同步层',
      title: '不透明 envelope，双向收发',
      summary: '不透明 envelope 双向收发；Automerge 适配器为后续独立 change。',
    },
    {
      id: 'server',
      eyebrow: '自托管',
      title: '一行命令 server',
      summary: 'npx opendweb server 或 docker ghcr.io/gaubee/dweb —— gateway 8787 + relay 3340。',
    },
    {
      id: 'plugins',
      eyebrow: '插件',
      title: 'Marketplace，厂商中立内核',
      summary: '任意非 builtin 首 token 自适应派发；缺失插件首用时自愈安装。Cloudflare Tunnel 以插件交付。',
    },
    {
      id: 'sdk',
      eyebrow: 'SDK',
      title: 'Node SDK（napi-rs）',
      summary: '@jixo/opendweb-client-sdk 把 fabric 嵌入你自己的应用（darwin-arm64 / win32-x64）。',
    },
  ],
  quickStart: {
    eyebrow: '快速开始',
    title: '启动 server，邀请一个 peer，开始聊天',
    summary:
      'gateway（8787）承载 /healthz、/services.json 与 rendezvous；relay（3340）独立监听。邀请必须在签发者在线期间兑换——兑换期间签发者进程保持运行。',
    scriptMeta: 'quick-start.sh',
    script: `# 1. 启动自托管 server（gateway + relay）—— 顶层 CLI
npx opendweb server
#   也可用 docker: docker run -p 8787:8787 -p 3340:3340 ghcr.io/gaubee/dweb
#   横幅会列出本机全部 Network 地址——任一地址即客户端唯一配置入口，
#   gateway 经 /services.json 自动发现 relay。

# 2. 每台客户端机器：一次性配置（持久化于 ~/.opendweb/config.json）
npx @jixo/opendweb-example config set relay http://192.168.2.13:8787

# 3. 终端 A：初始化并常驻聊天
npx @jixo/opendweb-example init --data ~/.dweb-a
npx @jixo/opendweb-example invite --data ~/.dweb-a --ttl 30m   # 复制 token
npx @jixo/opendweb-example chat --data ~/.dweb-a

# 4. 终端 B（另一目录/设备）：兑换邀请并聊天
npx @jixo/opendweb-example join --data ~/.dweb-b <token>
npx @jixo/opendweb-example chat --data ~/.dweb-b`,
    bannerMeta: '预期 server 横幅',
    banner: `* opendweb server v0.2.1
> Local:   http://localhost:8787
> Network: http://192.168.1.100:8787

  NAME         PORT   STATE
  gateway      8787   entry point
  rendezvous   8787   merged into gateway
  relay        3340   enabled`,
    note: [
      { t: 'text', v: '不用 npx 自托管：' },
      { t: 'link', v: 'docker ghcr.io/gaubee/dweb', kind: 'docker' },
      { t: 'text', v: '。反代或隧道后面，设置 ' },
      { t: 'code', v: 'DWEB_PUBLIC_GATEWAY_URL / DWEB_PUBLIC_RELAY_URL' },
      { t: 'text', v: ' —— 厂商中立的方案见 README。' },
    ],
  },
  packages: {
    eyebrow: '软件包',
    title: '一个 CLI、一个 server 二进制、一个 SDK —— 全部发布',
    summary: '全部包发布于 v0.2.1。server CLI 即 marketplace 宿主；插件与 Node SDK 扩展同一 fabric。',
    pkgHeader: 'npm 包',
    roleHeader: '角色',
    rows: [
      {
        pkg: 'opendweb',
        role: '服务器 CLI —— `npx opendweb server` 启动自托管 gateway + relay；插件 marketplace 宿主',
      },
      {
        pkg: '@jixo/opendweb-server-binary',
        role: 'CLI 使用的服务端二进制包装；亦暴露可编程的 `startServer()`',
      },
      {
        pkg: '@jixo/opendweb-example',
        role: '双进程参考客户端 CLI（`init` / `invite` / `join` / `chat`）',
      },
      {
        pkg: '@jixo/opendweb-client-sdk',
        role: '把 fabric 嵌入你自己应用的 Node SDK（napi-rs；darwin-arm64 / win32-x64）',
      },
      {
        pkg: '@jixo/opendweb-config',
        role: '本地插件文件的 `definePlugin` helper（runtime 无关：deno / bun / node）',
      },
      {
        pkg: '@jixo/opendweb-ext-cf',
        role: 'Cloudflare Tunnel 插件：API 推 ingress、DNS 路由、端到端验证、可选 cloudflared 共生 spawn',
      },
    ],
  },
  ecosystem: {
    eyebrow: '生态',
    title: '厂商集成皆为插件；你的应用内嵌 SDK',
    summary:
      'CLI 内核在结构上保持厂商中立——任意非 builtin 首 token 都派发到 marketplace 插件。Cloudflare Tunnel 插件覆盖无公网 IP 部署；Node SDK 直接内嵌 fabric。',
    pluginLabel: '插件 —— Cloudflare Tunnel',
    pluginMeta: 'opendweb — cf 插件',
    pluginSample: `opendweb plugin add cf          # 安装进当前项目（探测包管理器），锁定 name@version
opendweb cf setup --hostname dweb.example.com
                                 # API 推 ingress、路由 DNS、
                                 # 写 opendweb.config.toml、端到端自检
opendweb cf plan --hostname dweb.example.com    # 零副作用预览`,
    sdkLabel: 'Node SDK —— 应用内嵌 fabric',
    sdkMeta: 'sdk.cjs',
    sdkSample: `const { Fabric } = require("@jixo/opendweb-client-sdk");

const relay = { mode: "custom", urls: ["http://192.168.2.13:3340"] };

// 机器 A：创建 fabric（本节点成为 root）并签发邀请
const a = await Fabric.createRoot({ dataDir: "/path/a", relay });
const token = await a.invite(60 * 60_000, null); // dweb1. 前缀令牌

// 机器 B：兑换令牌（签发者须在线）并收发消息
const b = await Fabric.joinWithToken({ dataDir: "/path/b", relay }, token);
await b.connect(a.endpointId);
await a.send(b.endpointId, Buffer.from("ping"));
await a.revoke(b.endpointId); // 撤销（root-only）`,
    note: [
      { t: 'text', v: '事件流：' },
      {
        t: 'code',
        v: 'peer-connected / peer-disconnected、roster-updated、message、path-changed（direct / relay）、relay-online / relay-offline',
      },
      { t: 'text', v: '。完整契约见 ' },
      { t: 'link', v: 'GitHub', kind: 'github' },
      { t: 'text', v: '。' },
    ],
  },
};
