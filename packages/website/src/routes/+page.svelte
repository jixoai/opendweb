<!--
  首页（维护于 2026-09-06 Asia/Shanghai）。
  正交意图：
    1. Hero（定位陈述 + 复制 CTA + 服务器横幅终端）
    2. Features 网格（README 的四层事实 + 插件/SDK，card-grid 自持入场）
    3. Quick start（自托管 server / docker / 两终端邀请流）
    4. Packages 表（npm 清单，一字不虚）+ Ecosystem（插件 + Node SDK 样例）
  原始需求（2026-09-06 Asia/Shanghai）：openspec/changes/2026-09-06-add-website —
  内容全部来自 README.md 定位，不虚构声明。data-reveal 为静态标记（注册表
  scroll-driven reveal 契约）；card-grid 的直接子卡绝不包 data-reveal。
-->
<script lang="ts">
  import HeroSection from '$lib/ui/hero-section/hero-section.svelte';
  import SectionCard from '$lib/ui/section-card/section-card.svelte';
  import CardGrid from '$lib/ui/card-grid/card-grid.svelte';
  import PressButton from '$lib/ui/press-button/press-button.svelte';
  import TerminalCard from '$lib/ui/terminal-card/terminal-card.svelte';
  import CodeBlock from '$lib/components/code-block.svelte';
  import { DOCKER_URL, GITHUB_URL, NPM_PACKAGES, npmUrl } from '$lib/constants';

  // —— README「快速开始」原样事实（命令与横幅输出） ——
  const serverQuickStart = `# 1. Start the self-hosted server (gateway + relay) — top-level CLI
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
npx @jixo/opendweb-example chat --data ~/.dweb-b`;

  const serverBanner = `* opendweb server v0.2.1
> Local:   http://localhost:8787
> Network: http://192.168.1.100:8787

  NAME         PORT   STATE
  gateway      8787   entry point
  rendezvous   8787   merged into gateway
  relay        3340   enabled`;

  const sdkSample = `const { Fabric } = require("@jixo/opendweb-client-sdk");

const relay = { mode: "custom", urls: ["http://192.168.2.13:3340"] };

// Machine A: create the fabric (this node becomes root) and sign an invite
const a = await Fabric.createRoot({ dataDir: "/path/a", relay });
const token = await a.invite(60 * 60_000, null); // dweb1.-prefixed token

// Machine B: redeem the token (issuer must be online) and exchange messages
const b = await Fabric.joinWithToken({ dataDir: "/path/b", relay }, token);
await b.connect(a.endpointId);
await a.send(b.endpointId, Buffer.from("ping"));
await a.revoke(b.endpointId); // root-only`;

  const pluginSample = `opendweb plugin add cf            # install (detected pm), lock name@version
opendweb cf setup --hostname dweb.example.com
                                  # push ingress via CF API, route DNS,
                                  # write opendweb.config.toml, verify end-to-end
opendweb cf plan --hostname dweb.example.com   # zero-side-effect preview`;

  // —— Features：README 四层协议事实 + 交付面 ——
  const features = [
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
  ] as const;
</script>

<svelte:head>
  <title>dweb · application-level networking platform</title>
  <meta
    name="description"
    content="dweb lets multi-device applications form logical networks — like game rooms, not a system-level VPN — with controlled, invite-based membership, Ed25519 identity, signed-fact rosters, and iroh/QUIC direct connections with self-hosted relay fallback."
  />
</svelte:head>

<HeroSection
  eyebrow="dweb · application-level networking"
  copyCommand="npx opendweb server"
  summary="Multi-device applications form logical networks — like game rooms, not a system-level VPN — with controlled, invite-based membership. Peers connect directly over QUIC when possible and fall back to a self-hostable relay."
>
  {#snippet title()}
    Application-level <em>logical networks</em> — game rooms, not system VPNs.
  {/snippet}
  {#snippet badges()}
    <span>Ed25519 EndpointId</span>
    <span>Signed-fact Roster</span>
    <span>QUIC direct + relay fallback</span>
    <span>MIT OR Apache-2.0</span>
  {/snippet}
  {#snippet secondary()}
    <PressButton variant="outline" href={GITHUB_URL} external>GitHub ↗</PressButton>
    <PressButton variant="outline" href="#quick-start">Quick start</PressButton>
  {/snippet}
  {#snippet terminal()}
    <TerminalCard
      barTitle="opendweb — server"
      command="npx opendweb server"
      outputs={[
        '* opendweb server v0.2.1',
        '> Local:   http://localhost:8787',
        '> Network: http://192.168.1.100:8787',
        'gateway 8787 · rendezvous 8787 · relay 3340',
      ]}
    />
  {/snippet}
</HeroSection>

<!-- Features：README 四层协议事实 + 交付面（card-grid 自持入场，子卡不加 reveal）。 -->
<section id="features" class="mx-auto w-full max-w-[90rem] px-4 sm:px-6 lg:px-8">
  <h2
    class="font-nav flex items-baseline gap-4 text-lg uppercase tracking-[0.3em]"
    data-reveal=""
  >
    What&rsquo;s inside
    <span class="bg-border h-px flex-1" aria-hidden="true"></span>
  </h2>
  <div class="mt-6">
    <CardGrid min="340px">
      {#each features as feature (feature.id)}
        <SectionCard eyebrow={feature.eyebrow} title={feature.title} summary={feature.summary}>
          <p class="text-muted-foreground text-[12px] leading-5">
            <code>{feature.id}</code>
          </p>
        </SectionCard>
      {/each}
    </CardGrid>
  </div>
</section>

<!-- Quick start：server / docker / 两终端邀请流。 -->
<div
  id="quick-start"
  class="mx-auto w-full max-w-[90rem] px-4 pt-10 sm:px-6 lg:px-8"
  data-reveal=""
>
  <SectionCard
    eyebrow="Quick start"
    title="Start the server, invite a peer, chat"
    summary="The gateway (8787) serves /healthz, /services.json and rendezvous; the relay (3340) is a separate listener. Invites must be redeemed while the inviter is online — the inviter's process stays running during redemption."
  >
    <div class="flex flex-col gap-4">
      <CodeBlock code={serverQuickStart} lang="bash" meta="quick-start.sh" prompt={false} />
      <CodeBlock code={serverBanner} lang="text" meta="expected server banner" prompt={false} />
    </div>
    <p class="text-muted-foreground mt-4 text-[13px] leading-5">
      Self-host without npx: <a href={DOCKER_URL} class="text-primary underline underline-offset-2"
        >docker ghcr.io/gaubee/dweb</a
      >. Behind a reverse proxy or tunnel, set
      <code>DWEB_PUBLIC_GATEWAY_URL</code> / <code>DWEB_PUBLIC_RELAY_URL</code> — see the README for
      the vendor-neutral recipe.
    </p>
  </SectionCard>
</div>

<!-- Packages：npm 清单（README 表格原样）。 -->
<div
  id="packages"
  class="mx-auto w-full max-w-[90rem] px-4 pt-8 sm:px-6 lg:px-8"
  data-reveal=""
>
  <SectionCard
    eyebrow="Packages"
    title="One CLI, one server binary, one SDK — all published"
    summary="All packages are published at v0.2.1. The server CLI is the marketplace host; plugins and the Node SDK extend the same fabric."
  >
    <div class="table-scroll">
      <table class="data-table">
        <thead>
          <tr>
            <th>npm package</th>
            <th>Role</th>
          </tr>
        </thead>
        <tbody>
          {#each NPM_PACKAGES as p (p.pkg)}
            <tr>
              <td><a href={npmUrl(p.pkg)} class="text-primary underline underline-offset-2"><code>{p.pkg}</code></a></td>
              <td>{p.role}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </SectionCard>
</div>

<!-- Ecosystem：插件 + Node SDK。 -->
<div
  id="ecosystem"
  class="mx-auto w-full max-w-[90rem] px-4 pb-4 pt-8 sm:px-6 lg:px-8"
  data-reveal=""
>
  <SectionCard
    eyebrow="Ecosystem"
    title="Vendor integrations are plugins; your app embeds the SDK"
    summary="The CLI core stays vendor-neutral by construction — any non-builtin first token dispatches to a marketplace plugin. The Cloudflare Tunnel plugin covers no-public-IP deployments; the Node SDK embeds fabrics directly."
  >
    <div class="flex flex-col gap-6 lg:flex-row">
      <div class="min-w-0 flex-1">
        <p class="font-nav text-primary mb-2 text-[11px] uppercase tracking-[0.24em]">
          Plugin — Cloudflare Tunnel
        </p>
        <CodeBlock code={pluginSample} lang="bash" meta="opendweb — cf plugin" prompt={false} />
      </div>
      <div class="min-w-0 flex-1">
        <p class="font-nav text-primary mb-2 text-[11px] uppercase tracking-[0.24em]">
          Node SDK — fabric in your app
        </p>
        <CodeBlock code={sdkSample} lang="js" meta="sdk.cjs" prompt={false} />
      </div>
    </div>
    <p class="text-muted-foreground mt-4 text-[13px] leading-5">
      Event stream: <code>peer-connected</code> / <code>peer-disconnected</code>,
      <code>roster-updated</code>, <code>message</code>, <code>path-changed</code> (direct / relay),
      <code>relay-online</code> / <code>relay-offline</code>. Full contract on
      <a href={GITHUB_URL} class="text-primary underline underline-offset-2">GitHub</a>.
    </p>
  </SectionCard>
</div>
