## ADDED Requirements

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
