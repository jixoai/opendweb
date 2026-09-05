> Execution law: implementation is delegated work; the visual acceptance and
> any DNS/CNAME decision stay with the Owner.

## 1. Site package

- [x] 1.1 Create `packages/website` in the pnpm workspace (private, zero
  runtime deps) with SvelteKit + adapter-static + Tailwind v4 + TypeScript
  strict, mirroring unipty `packages/www` as the structural precedent.
- [x] 1.2 Create `components.json` FIRST (hand-write following the unipty
  www precedent: shadcn schema fields, `tsx: true` is schema-mandatory,
  aliases with `ui → src/lib/ui`, `registries.@jixoai =
  "https://ui.jixoai.com/r/{name}.json"`) — `jixoai-ui init` refuses to run
  without it. Then `npx jixoai-ui init --hue 95`.
- [x] 1.3 Add site items: `scrollbar-measure` (import once in the root
  layout), `website-scaffold`, `terminal-header`, `terminal-footer`,
  `theme-toggle`, `hero-section`, `section-card`, `press-button`,
  `terminal-card`, `card-grid`, `llms-txt`. Then LOCK THE DEPENDENCY
  CLOSURE (shadcn installs dependencies but only explicit names enter
  `jixoai-ui.lock`; `upgrade` refreshes locked items only) — explicitly
  `npx jixoai-ui add` every closure item that landed on disk (`icons`,
  `defaults`, `utils`, `jixoai-theme`, `navigation-menu`, `popover`,
  `density`, `paint`, `separator`, `figure`, `context-plugin`,
  `toc-engine` …as actually present); record exclusions in NOTES.md.
- [x] 1.4 Pages: home (hero + features + quick-start + ecosystem links).
  All content from the README positioning; no invented claims.

## 2. Delivery

- [x] 2.1 Base-path-aware build: `svelte.config.js` reads an env var
  (e.g. `SITE_BASE`) into `kit.paths.base`; internal links resolve through
  `$app/paths` `base` (never hardcoded prefixes); CNAME flag switches the
  build to root serving. Document the two modes in the package README.
- [x] 2.2 GitHub Pages workflow (push to main + manual dispatch): pnpm
  install (commit the updated `pnpm-lock.yaml` — the existing ci.yml runs
  `pnpm -r --if-present run build` so the website joins CI automatically),
  build in subpath mode (`SITE_BASE=/dweb`) until the Owner sets DNS,
  static checks, deploy.
- [x] 2.3 Favicon + theme-color carry `#bd8600`; logo is the Owner-pinned
  `opendweb-icon-direct.png`, promoted verbatim to `assets/` and the site's
  static assets (no vector redraw).
- [x] 2.4 Check the app.css supplies the token→utility mappings the
  registry sheet leaves empty (popover/destructive/input/ring/radius/
  shadows — the unipty NOTES pitfall) so Tailwind never silently falls
  back to soft defaults.

## 3. Verification

- [x] 3.1 `llms.txt` / per-page `.md` mirrors generate with absolute URLs,
  byte-identical on re-run.
- [x] 3.2 Build passes from a clean install; output serves correctly from a
  file/preview server under the configured base path (link check).
- [x] 3.3 jixoai-website skill verification checklist reviewed item by item;
  deviations recorded in the package NOTES.md.
