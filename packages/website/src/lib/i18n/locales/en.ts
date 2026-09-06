// 正交意图（维护于 2026-09-06 Asia/Shanghai）：英文文案字典 —— `/` 页与
// layout chrome 的内容源（2026-09-06-add-website 自 +page.svelte 迁入；
// site-i18n-zh 起作为 en locale，URL 稳定在 `/`）。
//
// 原始需求（2026-09-06 Asia/Shanghai）：openspec/changes/
// 2026-09-06-release-automation-and-copy —— 文案升级为意图叙事：问题先行
// （逻辑网络 ≠ 系统 VPN）→ 三层模型（identity/roster/session）→ 证据（邀请
// 流、relay 回退、插件生态、Node SDK）。事实源 README.md / EXAMPLE.md；
// 版本号为 npm 实测（发布时随 NOTES.md 的维护规则同步 bump）。
import { NPM_PACKAGES } from '$lib/constants';
import type { WebsiteContent } from '$lib/i18n/schema';

export const en: WebsiteContent = {
  meta: {
    siteTitle: 'dweb · application-level networking platform',
    description:
      'Multi-device apps need logical networks, not a system VPN: dweb gives applications game-room semantics — invite-based membership, stable Ed25519 identity, signed-fact rosters, and iroh/QUIC direct connections with self-hosted relay fallback.',
  },
  chrome: {
    subtitle: 'application-level networking',
    languageLabel: 'Language',
    anchors: [
      { id: 'features', label: 'Features' },
      { id: 'quick-start', label: 'Quick start' },
      { id: 'packages', label: 'Packages' },
      { id: 'ecosystem', label: 'Ecosystem' },
    ],
    githubLabel: 'GitHub ↗',
    drawerLabel: 'Site',
    readmeLabel: 'README（中文）',
    exampleLabel: 'EXAMPLE.md',
  },
  hero: {
    eyebrow: 'dweb · application-level networking',
    titleLead: 'Multi-device apps need ',
    titleEm: 'logical networks',
    titleTail: ' — game rooms, not system VPNs.',
    badges: [
      'Ed25519 EndpointId',
      'Signed-fact Roster',
      'QUIC direct + relay fallback',
      'MIT OR Apache-2.0',
    ],
    summary:
      'Devices drift across networks and addresses; what an app lacks is a room — a logical network it owns, joined by invitation, with stable identity and direct connections. dweb forms that logical network at the application level: Ed25519 EndpointId for identity, signed-fact rosters for membership, iroh/QUIC direct connections with a self-hostable relay as fallback — no system-level VPN dragging the whole machine in.',
    quickStartLabel: 'Quick start',
    barTitle: 'opendweb — server',
    command: 'npx opendweb server',
    outputs: [
      '* opendweb server v0.4.2',
      '> Local:   http://localhost:8787',
      '> Network: http://192.168.1.100:8787',
      'gateway 8787 · rendezvous 8787 · relay 3340',
    ],
  },
  featuresHeading: 'The three-layer answer, then delivery',
  features: [
    {
      id: 'identity',
      eyebrow: 'Layer 1 · Identity',
      title: 'Ed25519 EndpointId',
      summary:
        'Addresses change as devices move; members should not. Stable identity decoupled from network addresses — z-base-32 display form, the same node across address changes.',
    },
    {
      id: 'roster',
      eyebrow: 'Layer 2 · Roster',
      title: 'Signed facts, converged by union-merge',
      summary:
        'Membership verifiable without a central database: Genesis/Grant/Join/Revoke facts are signed, content-addressed (BLAKE3), and converge by union-merge.',
    },
    {
      id: 'invites',
      eyebrow: 'Layer 2 · Membership',
      title: 'Controlled, invite-based joins',
      summary:
        'A room is only a room if joining is by invitation. Issuer-online single redemption: challenge-response PoP plus invite_id CAS consumption — each token redeemed exactly once.',
    },
    {
      id: 'session',
      eyebrow: 'Layer 3 · Session',
      title: 'iroh 1.1: QUIC direct + relay fallback',
      summary:
        'Members talk directly whenever the network allows. QUIC direct with NAT traversal; falls back to a self-hostable relay. Gating on both sides — gate before data; per-frame resource caps.',
    },
    {
      id: 'sync',
      eyebrow: 'Payload',
      title: 'Opaque envelopes, bidirectional',
      summary:
        'The fabric does not dictate your data model. Send/receive opaque envelopes both ways; an Automerge adapter is planned as a separate change.',
    },
    {
      id: 'server',
      eyebrow: 'Delivery · Self-hosting',
      title: 'One-liner server',
      summary:
        'The control plane is yours to host: npx opendweb server or docker ghcr.io/gaubee/dweb — gateway 8787 + relay 3340.',
    },
    {
      id: 'plugins',
      eyebrow: 'Delivery · Plugins',
      title: 'Marketplace, vendor-neutral core',
      summary:
        'Vendor integrations are opt-in, not baked in. Any non-builtin first token dispatches adaptively; missing plugins fetch on first use. Cloudflare Tunnel ships as a plugin.',
    },
    {
      id: 'sdk',
      eyebrow: 'Delivery · SDK',
      title: 'Node SDK (napi-rs)',
      summary:
        'Embed the fabric instead of shelling out: @jixo/opendweb-client-sdk embeds fabrics in your own app (darwin-arm64 / win32-x64).',
    },
  ],
  quickStart: {
    eyebrow: 'Quick start',
    title: 'Start the server, invite a peer, chat',
    summary:
      "The gateway (8787) serves /healthz, /services.json and rendezvous; the relay (3340) is a separate listener. Invites must be redeemed while the inviter is online — the inviter's process stays running during redemption.",
    scriptMeta: 'quick-start.sh',
    script: `# 1. Start the self-hosted server (gateway + relay) — top-level CLI
npx opendweb server
#   or: docker run -p 8787:8787 -p 3340:3340 ghcr.io/gaubee/dweb
#   The banner lists every Network address. Any of them is the single
#   config entry for clients — the gateway discovers the relay URL
#   automatically via /services.json.

# 2. On each client machine: one-time config (persisted to ~/.opendweb/config.json)
npx @jixo/opendweb-example config set relay http://192.168.2.13:8787

# 3. Terminal A: initialize and keep a chat session running
npx @jixo/opendweb-example init --data ~/.dweb-a
npx @jixo/opendweb-example invite --data ~/.dweb-a --ttl 30m   # copy the token
npx @jixo/opendweb-example chat --data ~/.dweb-a

# 4. Terminal B (another directory/device): redeem the invite and chat
npx @jixo/opendweb-example join --data ~/.dweb-b <token>
npx @jixo/opendweb-example chat --data ~/.dweb-b`,
    bannerMeta: 'expected server banner',
    banner: `* opendweb server v0.4.2
> Local:   http://localhost:8787
> Network: http://192.168.1.100:8787

  NAME         PORT   STATE
  gateway      8787   entry point
  rendezvous   8787   merged into gateway
  relay        3340   enabled`,
    note: [
      { t: 'text', v: 'Self-host without npx: ' },
      { t: 'link', v: 'docker ghcr.io/gaubee/dweb', kind: 'docker' },
      { t: 'text', v: '. Behind a reverse proxy or tunnel, set ' },
      { t: 'code', v: 'DWEB_PUBLIC_GATEWAY_URL / DWEB_PUBLIC_RELAY_URL' },
      { t: 'text', v: ' — see the README for the vendor-neutral recipe.' },
    ],
  },
  packages: {
    eyebrow: 'Packages',
    title: 'One CLI, one server binary, one SDK — all published',
    summary:
      'Current published line: opendweb 0.4.2 · client-sdk / server-binary / example 0.3.2 · ext-cf 1.0.3 · config 0.1.0. The server CLI is the marketplace host; plugins and the Node SDK extend the same fabric.',
    pkgHeader: 'npm package',
    roleHeader: 'Role',
    rows: NPM_PACKAGES,
  },
  ecosystem: {
    eyebrow: 'Ecosystem',
    title: 'Vendor integrations are plugins; your app embeds the SDK',
    summary:
      'The CLI core stays vendor-neutral by construction — any non-builtin first token dispatches to a marketplace plugin. The Cloudflare Tunnel plugin covers no-public-IP deployments; the Node SDK embeds fabrics directly.',
    pluginLabel: 'Plugin — Cloudflare Tunnel',
    pluginMeta: 'opendweb — cf plugin',
    pluginSample: `opendweb plugin add cf            # install (detected pm), lock name@version
opendweb cf setup --hostname dweb.example.com
                                  # push ingress via CF API, route DNS,
                                  # write opendweb.config.toml, verify end-to-end
opendweb cf plan --hostname dweb.example.com   # zero-side-effect preview`,
    sdkLabel: 'Node SDK — fabric in your app',
    sdkMeta: 'sdk.cjs',
    sdkSample: `const { Fabric } = require("@jixo/opendweb-client-sdk");

const relay = { mode: "custom", urls: ["http://192.168.2.13:3340"] };

// Machine A: create the fabric (this node becomes root) and sign an invite
const a = await Fabric.createRoot({ dataDir: "/path/a", relay });
const token = await a.invite(60 * 60_000, null); // dweb1.-prefixed token

// Machine B: redeem the token (issuer must be online) and exchange messages
const b = await Fabric.joinWithToken({ dataDir: "/path/b", relay }, token);
await b.connect(a.endpointId);
await a.send(b.endpointId, Buffer.from("ping"));
await a.revoke(b.endpointId); // root-only`,
    note: [
      { t: 'text', v: 'Event stream: ' },
      {
        t: 'code',
        v: 'peer-connected / peer-disconnected, roster-updated, message, path-changed (direct / relay), relay-online / relay-offline',
      },
      { t: 'text', v: '. Full contract on ' },
      { t: 'link', v: 'GitHub', kind: 'github' },
      { t: 'text', v: '.' },
    ],
  },
};
