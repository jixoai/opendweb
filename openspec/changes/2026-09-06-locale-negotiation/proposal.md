> Orthogonal intents (maintained 2026-09-06 Asia/Shanghai): browser
> language negotiation for the default locale.
>
> Original request (2026-09-06 Asia/Shanghai): 站点没有基于浏览器语言
> 自动选择默认语言——需要补上。

## Why

The site serves the default locale (en) at `/` and localized mirrors at
`/[lang]/`, but a browser preferring another language still lands on
English unless it clicks the switcher.

## What Changes

- Pre-paint negotiation on default-locale pages (app.html bootstrap,
  before first paint): an explicit persisted choice wins
  (localStorage `lang`, written by the language switcher); otherwise
  the first navigator.languages match among available locales
  redirects ONCE to the same page under `/[lang]/` (path + hash
  preserved). Never redirects from a non-default locale; never
  redirects when the match is the default; crawlers/no-JS get the
  static default (hreflang already carries the alternates).
- The language switcher persists its choice to the same key, so an
  explicit click always beats detection afterwards.

## Capabilities

### Modified Capabilities

- `website`: locale negotiation on the default surface.
