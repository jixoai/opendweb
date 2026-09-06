## 1. Release automation

- [x] 1.1 Extend release.yml: post-publish GitHub Release creation
  (tag = trigger tag, curated notes per package + upgrade line + docker
  ref); add a dispatch "release current version" bootstrap mode.
- [x] 1.2 Bootstrap the release for the current CLI version; verify via
  gh api; jixoai.com resolves it on next build.
  (v0.4.2 — https://github.com/jixoai/opendweb/releases/tag/v0.4.2,
  `releases/latest` resolves to it; npm-truth notes because the v0.4.2
  tag carries opendweb 0.4.1 in-tree — 0.4.2 shipped from v1.0.1-cli.)

## 2. Site copy upgrade

- [x] 2.1 Read intent sources (README pair, EXAMPLE.md, openspec/,
  AGENTS.md); extract the why (logical networks ≠ system VPN) and proof
  points.
- [x] 2.2 Rewrite hero + features copy in en and zh (i18n dictionary);
  purpose-led, facts only; quick-start stays factual.
- [x] 2.3 Rebuild both locales + both serving modes green; checks pass;
  NOTES.md updated; friction log reported.
