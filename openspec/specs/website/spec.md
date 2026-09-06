# website Specification

## Purpose
The official static site presenting dweb to the public: positioning,
features, quick start, and ecosystem links, in the shared jixoai identity.

## Requirements

### Requirement: Static official site in the jixoai identity

The site SHALL be a SvelteKit adapter-static build whose entire visual
identity comes from the `@jixoai` registry (jixoai-theme token sheet with
`--brand-hue: 95`, registry site chrome), differing from sibling jixoai
sites in hue and content only.

#### Scenario: registry lock governs the chrome

- **WHEN** the site package is built after `npx jixoai-ui upgrade`
- **THEN** every locked component refreshes from the registry and the build
  still passes, with no hand-edited registry files.

#### Scenario: dark mode

- **WHEN** the theme is toggled to dark
- **THEN** the background is pure black, borders/shadows invert, the primary
  drifts to the dark-mode variant, and no flash precedes first paint.

### Requirement: GitHub Pages delivery with deferred custom domain

The site SHALL deploy to GitHub Pages from a workflow, serving from the
project pages path until the Owner configures DNS, and SHALL support both
root and subpath serving from one build configuration.

#### Scenario: subpath serving before DNS

- **WHEN** the site is built without the CNAME flag
- **THEN** all internal links and assets resolve under the `/dweb` base path
  and the deployed pages return 200.

#### Scenario: custom domain cutover

- **WHEN** the Owner sets DNS and the workflow builds with the CNAME flag
- **THEN** the build writes the CNAME file and serves from the domain root
  with no code change beyond the flag.

### Requirement: AI export layer

The site SHALL ship `llms.txt`, `llms-full.txt`, and per-page `.md` mirrors
generated at build time from one generation point, with absolute URLs.

#### Scenario: regeneration is stable

- **WHEN** the build runs twice without content changes
- **THEN** the exported files are byte-identical.

### Requirement: Bilingual locale surface (en/zh)

The site SHALL serve English at the root (stable URLs) and a full Chinese
mirror at `/zh/`, with per-locale `<html lang>`, hreflang alternates, a
visible language switcher, and locale-covered AI export.

#### Scenario: zh mirror

- **WHEN** `/zh/` is requested (built under any SITE_BASE)
- **THEN** the page renders with Chinese copy sourced from README-zh.md,
  `lang="zh"`, and hreflang links for en, zh, and x-default.

#### Scenario: switching locales

- **WHEN** the language switcher is used
- **THEN** navigation stays on the corresponding page of the other locale.

### Requirement: Purpose-led bilingual copy

The site copy SHALL lead with the problem dweb exists to solve —
application-level logical networks with identity, membership, and
transport solved once — sourced from the repo's intent documents, in
both locales, with every claim traceable.

#### Scenario: hero narrates purpose

- **WHEN** the home page renders in either locale
- **THEN** the hero frames "logical networks like game rooms, not a
  system VPN" before listing capabilities, and each feature section
  carries a motivation sentence.
