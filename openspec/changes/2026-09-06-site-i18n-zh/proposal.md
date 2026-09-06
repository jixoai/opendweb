> Orthogonal intents (maintained 2026-09-06 Asia/Shanghai): site i18n (en/zh).
>
> Original request (2026-09-06 Asia/Shanghai): 所有站点需要至少提供中英两种
> 语言的支持。README-zh.md 已存在，作为 zh 文案信源。

## Why

The new official site ships English-only; the family convention expects a
zh mirror, and the repo already carries README-zh.md as the content source.

## What Changes

- Site i18n: `/` stays English (stable URLs); add a `/zh/` mirror with zh
  copy sourced from README-zh.md. Per-locale `<html lang>`, hreflang
  alternates, registry `language-switcher` (add + lock) wired into
  terminal-header. llms export covers both locales.

## Capabilities

### Modified Capabilities

- `website`: locale surface (en root + /zh/ mirror, switcher, hreflang,
  bilingual AI export).
