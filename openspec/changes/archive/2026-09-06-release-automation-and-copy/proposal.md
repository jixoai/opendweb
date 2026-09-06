> Orthogonal intents (maintained 2026-09-06 Asia/Shanghai): release
> automation (GitHub Releases as L1); site copy upgrade from project
> first principles.
>
> Original request (2026-09-06 Asia/Shanghai): 官网文案要升级（子代理
> 深入理解项目目的与初衷）；把没有好好配置 github-releases 的仓库
> CI/CD 升级为实现自动发布，让 jixoai.com 能显示版本号。

## Why

The repo publishes npm packages on tag push (`v*`) but creates NO
GitHub Releases — jixoai.com reads "v—" and the org blog has no L1 to
link. The site copy is a translated feature list; it does not narrate
why application-level networking exists.

## What Changes

### 1. Release automation (L1)

- Extend `release.yml`: after the npm publish steps, cut the matching
  GitHub Release (tag = the triggering tag, notes = curated summary:
  headline changes per package, upgrade one-liner, docker image ref).
  Notes source: the tag's commit range vs previous tag plus package
  CHANGELOGs if present.
- Bootstrap: cut the release for the CURRENT published version
  (opendweb npm 0.4.x / workspace 0.3.x — use the CLI package version
  as the org-facing version) via the new path or a dispatch mode for
  "release current version".

### 2. Site copy upgrade (en + zh)

- Deep-read intent sources (README pair, EXAMPLE.md, openspec/ project
  docs, AGENTS.md) and rewrite hero + features in BOTH locales: lead
  with the problem (multi-device apps need to form logical networks
  like game rooms — membership, identity, and transport solved once —
  without dragging in a system VPN), then the model (EndpointId /
  Roster / iroh session), then proof (invite flow, relay fallback,
  plugin ecosystem). Facts traceable; no invented claims.

## Capabilities

### Modified Capabilities

- `website`: copy upgrade (both locales).

## Non-goals

- No crate/npm publishing policy changes, no release artifact changes
  beyond the GitHub Release creation, no site registry/lock surface
  changes beyond copy.
