// 正交意图（维护于 2026-09-06 Asia/Shanghai）：英文文案字典 —— 自
// routes/+page.svelte 原地迁入（一字不改），`/` 页与 layout chrome 的内容源。
//
// 原始需求（2026-09-06 Asia/Shanghai）：openspec/changes/2026-09-06-add-website —
// 内容全部来自 README.md 定位，不虚构声明；2026-09-06-site-i18n-zh 起
// 作为 en locale 字典（URL 稳定在 `/`）。
import { NPM_PACKAGES } from '$lib/constants';
import type { WebsiteContent } from '$lib/i18n/schema';

export const en: WebsiteContent = {
  meta: {
    siteTitle: 'dweb · application-level networking platform',
    description:
      'dweb lets multi-device applications form logical networks — like game rooms, not a system-level VPN — with controlled, invite-based membership, Ed25519 identity, signed-fact rosters, and iroh/QUIC direct connections with self-hosted relay fallback.',
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
    titleLead: 'Application-level ',
    titleEm: 'logical networks',
    titleTail: ' — game rooms, not system VPNs.',
    badges: [
      'Ed25519 EndpointId',
      'Signed-fact Roster',
      'QUIC direct + relay fallback',
      'MIT OR Apache-2.0',
    ],
    summary:
      'Multi-device applications form logical networks — like game rooms, not a system-level VPN — with controlled, invite-based membership. Peers connect directly over QUIC when possible and fall back to a self-hostable relay.',
    quickStartLabel: 'Quick start',
    barTitle: 'opendweb — server',
    command: 'npx opendweb server',
    outputs: [
      '* opendweb server v0.2.1',
      '> Local:   http://localhost:8787',
      '> Network: http://192.168.1.100:8787',
      'gateway 8787 · rendezvous 8787 · relay 3340',
    ],
  },
  featuresHeading: "What's inside",
  features: [
    {
      id: 'identity',
      eyebrow: 'Identity',
      title: 'Ed25519 EndpointId',
      summary:
        'Stable identity decoupled from network addresses; z-base-32 display form.',
    },
    {
      id: 'roster',
      eyebrow: 'Roster',
      title: 'Signed facts, converged by union-merge',
      summary:
        'Genesis/Grant/Join/Revoke facts are content-addressed (BLAKE3) and converge by union-merge.',
    },
    {
      id: 'invites',
      eyebrow: 'Membership',
      title: 'Controlled, invite-based joins',
      summary:
        'Issuer-online single redemption: challenge-response PoP plus invite_id CAS consumption.',
    },
    {
      id: 'session',
      eyebrow: 'Session',
      title: 'iroh 1.1: QUIC direct + relay fallback',
      summary:
        'Direct connections with NAT traversal; falls back to a self-hostable relay. Gating on both sides — gate before data.',
    },
    {
      id: 'sync',
      eyebrow: 'Sync',
      title: 'Opaque envelopes, bidirectional',
      summary:
        'Send/receive opaque envelopes both ways; an Automerge adapter is planned as a separate change.',
    },
    {
      id: 'server',
      eyebrow: 'Self-hosting',
      title: 'One-liner server',
      summary:
        'npx opendweb server or docker ghcr.io/gaubee/dweb — gateway 8787 + relay 3340.',
    },
    {
      id: 'plugins',
      eyebrow: 'Plugins',
      title: 'Marketplace, vendor-neutral core',
      summary:
        'Any non-builtin first token dispatches adaptively; missing plugins fetch on first use. Cloudflare Tunnel ships as a plugin.',
    },
    {
      id: 'sdk',
      eyebrow: 'SDK',
      title: 'Node SDK (napi-rs)',
      summary:
        '@jixo/opendweb-client-sdk embeds fabrics in your own app (darwin-arm64 / win32-x64).',
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
    banner: `* opendweb server v0.2.1
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
      'All packages are published at v0.2.1. The server CLI is the marketplace host; plugins and the Node SDK extend the same fabric.',
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
