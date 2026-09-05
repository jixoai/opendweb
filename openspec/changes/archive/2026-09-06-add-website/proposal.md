> Orthogonal intents (maintained 2026-09-06 Asia/Shanghai): official-site
> capability; jixoai design-language adoption; GitHub Pages delivery.
>
> Original request (2026-09-06 Asia/Shanghai): 新增 ./opendweb 官网站点
> （背景：./jixoai-ui 发布了新版本 0.3.0）。

## Why

dweb has no official site — the README is the only public surface, and the
project is about to be listed on jixoai.com with a `site` link that has no
target. jixoai-ui 0.3.0 published a complete website surface to the registry
(`website-scaffold`, `terminal-header/footer`, `hero-section`, `llms-txt`),
which makes a family-conformant static site a bootstrap operation instead of
a design project.

## What Changes

- Add `packages/website` — a SvelteKit + adapter-static site in the shared
  jixoai identity, bootstrapped from the official registry
  (`npx jixoai-ui init --hue 95`), hue sourced from the Owner-designated
  logo `opendweb-icon-direct.png`'s amber node `rgb(253 211 9)`
  (oklch 95.3° → 95). Rendered primaries: light `#bd8600`, dark `#cb9800`.
- Content: hero (application-level networking — logical networks like game
  rooms, not system VPNs), features grid (Ed25519 EndpointId, signed-fact
  Roster, invite-gated membership, iroh/QUIC direct + relay fallback,
  self-hosted server one-liner, plugin marketplace, Cloudflare Tunnel
  plugin, Node SDK), quick-start terminal (`npx opendweb server` / docker),
  links (GitHub Gaubee/dweb, README-zh, EXAMPLE).
- Assets: favicon/theme-color carry the project icon hex `#bd8600`; the
  Owner-designated logo `opendweb-icon-direct.png` is promoted verbatim to
  `assets/opendweb-icon.png` (source:
  `.agents/images/2026-09-05-opendweb-icon/`).
- AI export layer: `llms.txt` / `llms-full.txt` / per-page `.md` mirrors via
  the registry `llms-txt` item, one generation point in the vite pipeline.
- Delivery: GitHub Pages via a new deploy workflow (push-to-main +
  workflow_dispatch). Custom-domain CNAME is Owner-managed and gated behind
  a build flag — until DNS exists the site serves from
  `gaubee.github.io/dweb`, so the build supports a configurable base path.
- No changes to crates, plugins, release pipeline, or existing workflows.

## Capabilities

### New Capabilities

- `website`: the official static site, its registry lock, content surface,
  AI export, and Pages delivery.
