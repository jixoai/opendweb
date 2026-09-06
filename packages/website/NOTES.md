# dweb Website Implementation Notes

Private static official site for dweb (`dweb-website`), served from GitHub
Pages at `jixoai.github.io/opendweb` (subpath mode) until the Owner configures a
custom domain. Bootstrapped from the official jixoai design-language registry
(<https://ui.jixoai.com>) — hue 95, sourced from the Owner-designated logo
`opendweb-icon-direct.png`'s amber node `rgb(253 211 9)` (oklch 95.3°;
rendered light primary `#bd8600`, dark drift 91°). Initially built at hue 87
from the sibling variant's `#ffc52f`; re-themed to 95 when the Owner pinned
the `direct` variant as the logo (2026-09-06).

## Registry consumption (2026-09-06)

`components.json` was hand-written FIRST (unipty www precedent: `tsx: true` is
schema-mandatory even for this Svelte project, aliases `ui → src/lib/ui`,
`registries.@jixoai = https://ui.jixoai.com/r/{name}.json`), then
`npx jixoai-ui init --hue 95`, then item adds. The wrapper re-applies the brand
hue after every `add`, so the shadcn overwrite prompt for `jixoai.css` can be
answered "y" safely (the hue always ends at 95).

**Lock strategy** (shadcn installs dependencies but only explicit names enter
`jixoai-ui.lock`; `upgrade` refreshes locked items only). Locked items — the 11
site items plus every closure item that landed on disk:

- site: `scrollbar-measure`, `website-scaffold`, `terminal-header`,
  `terminal-footer`, `theme-toggle`, `language-switcher` (2026-09-06
  site-i18n-zh), `hero-section`, `section-card`, `press-button`,
  `terminal-card`, `card-grid`, `llms-txt`
- closure: `jixoai-theme` (init), `utils`, `icons`, `defaults`, `density`,
  `paint`, `context-plugin`, `navigation-menu`, `popover`, `separator`, `figure`

**Exclusions** (not on disk, per the "as actually present" rule):

- `toc-engine` — only consumed by the `toc` item; this single-page site has no
  ToC, so nothing pulled it in.
- `surface-motion.ts` — not a standalone lock name; it ships as a file of the
  `popover` item (the registry notes it as `lib/surface-motion.ts`).

`src/lib/*.ts` `utils`/`icons`/`defaults`/… import `clsx` + `tailwind-merge`.
shadcn wrote both into `dependencies`; they were moved to `devDependencies`
to honor the zero-runtime-deps contract — the package is a private static
bundle, so "runtime dependencies" do not exist and the build toolchain owns
them.

## Registry sheet vs the unipty-era pitfalls

- The 0.3.0 `jixoai-theme` sheet maps EVERY token into Tailwind itself
  (popover/destructive/input/ring/radius/shadows included — the gap unipty's
  NOTES documented). `src/app.css` therefore carries only base-layer paint and
  site surfaces (readonly-code + tokenizer palette, data tables); no mapping
  supplements were needed.
- Reveal is pure CSS scroll-driven in 0.3.0: static `data-reveal=""` attributes
  only, no `reveal` action, no `html.js` gate for reveals (the `js` class is
  still added by the app.html bootstrap; card-grid keys its hidden state on it).
- `card-grid` owns its children's entrance — cards inside it never carry
  `data-reveal`.
- One import-path correction (same class as unipty's toc fix): the
  `scrollbar-measure` docs say `import '@lib/scrollbar-measure'`; the SvelteKit
  alias is `$lib/scrollbar-measure`.
- The sheet's `--brand-hue` comment mentions a wall-clock `hue-runtime`
  (a jixoai.com feature). It is not installed; the static `87` renders in both
  modes — deliberate.

## Divergences from the reference (documented per skill law)

- `theme-color` is `#bd8600` (the icon/light-primary hex). unipty chose
  `#000000` to match its canvas; the design-tokens law ("non-CSS brand assets
  carry the rendered hex of the light primary") governs here and the change
  proposal pins the same hex.
- PressButton variant names drifted upstream: the ladder is now
  `fill / tonal / outline / ghost / link` (the skill's layout-patterns still
  say `primary`/`outline`; hero-section internally uses `fill`).
- No `--radius-*: initial` reset supplement (unipty adds one): the 0.3.0 sheet
  ships without it and nothing on the site uses default `rounded-*` utilities
  beyond the law's rounded-full pills.
- Logo (Owner decision 2026-09-06): `opendweb-icon-direct.png` is THE logo.
  It is promoted verbatim to `assets/opendweb-icon.png` and the site's
  `static/` (no SVG redraw — an earlier traced `opendweb-icon.svg` from a
  sibling variant was removed once the Owner pinned `direct`; favicon is the
  PNG alone).
- MPA view transitions (`view-transitions-toolkit` `useAutoTypes`) are not
  wired: the site is a single page per locale; the scaffold's cross-document
  choreography has nothing to animate.

## Site i18n — `/` = en, `/zh/` = zh mirror (2026-09-06 site-i18n-zh)

- **Route model**: `/` stays English (stable URLs, per proposal decision);
  `/zh/` is the Chinese mirror. The zh page overrides `trailingSlash` to
  `"always"` (`src/routes/zh/+page.ts`) so its canonical URL is the directory
  index — adapter-static writes `dist/zh/index.html` and static servers
  (GitHub Pages, `python3 -m http.server`) answer `/zh/` with 200 directly.
  The root layout's `"never"` keeps governing `/`. `svelte.config.js`
  prerender entries are `["/", "/zh/"]` (crawl stays off).
- **Content layer**: `src/lib/i18n/` — `schema.ts` (one `WebsiteContent`
  contract), `locales/en.ts` (moved verbatim from the old `+page.svelte`;
  the npm table stays single-sourced in `constants.ts`), `locales/zh.ts`
  (copy sourced from README-zh.md, terms cross-checked against
  EXAMPLE-zh.md — nothing invented). Both routes render the SAME
  `src/lib/pages/home-page.svelte`; anchor ids (`#features` etc.) are
  locale-invariant by schema.
- **`<html lang>`**: app.html carries a `%lang%` placeholder replaced by
  `src/hooks.server.ts` (`transformPageChunk`), the openspecui bilingual
  pattern — the prerendered HTML is the truth, no JS patch. TRAP hit and
  fixed: `String.replace` only replaces the FIRST occurrence, and the
  app.html header comment originally spelled the placeholder literally, so
  the comment ate the replacement and the real attribute kept `%lang%`.
  The hook now uses `replaceAll` AND the comment never spells the token.
- **canonical/hreflang** (en/zh/x-default, absolute): emitted from each
  `+page.svelte` via `SITE_URL` from `src/lib/site-url.ts`, which reads the
  `__SITE_URL__` vite `define` — same fact source (`SITE_URL` env, default
  `https://jixoai.github.io/opendweb`) as the llms plugin and the CNAME
  gate. hreflang uses `zh` (not `zh-CN`) per the change spec.
- **Language switcher**: registry item `language-switcher` (0.3.0, `pair`
  variant) wired into terminal-header's `switcher` slot beside the compact
  ThemeToggle (`switcherFrame={false}`, one flex cluster — the openspecui
  composition). Hrefs are `${base}/` and `${base}/zh/` plus the live
  `location.hash` (tracked via `hashchange`) so switching preserves the
  current anchor; SvelteKit's SSR link relativization renders them as
  `./`/`../` forms, which resolve correctly from either page (verified by
  HTTP spot checks of every emitted ref).
- **llms export locale split**: vite `llmsTxt` config gained
  `locale: { segments: ["zh"], default: "en" }` — en at root is the default
  locale's index (unsegmented), zh gets `zh/llms.txt`, root `llms.txt` gains
  an "Other languages" section, and `llms-full.txt` follows the default
  locale only (a mixed-language dump defeats retrieval). Per-page `.md`
  mirrors ship for both locales (`index.md`, `zh/index.md`).
- **Kit drift note**: this repo's lockfile resolves `@sveltejs/kit` 2.70.3
  (`^2.59.1`), while the openspecui reference runs a pinned 2.59.1 — the
  `%lang%` hook pattern works on both, but template internals
  (precompiled `templates.app`) differ; re-verify the lang replacement if
  kit major-bumps again.

## Serving modes (one build, two targets)

| Mode | Env | base | CNAME |
| ---- | --- | ---- | ----- |
| subpath (default until DNS) | `SITE_BASE=/opendweb` | `/opendweb` | not written |
| custom domain (Owner) | `SITE_CNAME=1` + `SITE_URL=https://<domain>` | `""` | written from SITE_URL host |

`SITE_URL` also feeds the llms-txt generator's absolute URLs (default
`https://jixoai.github.io/opendweb`). Internal links resolve through
`$app/paths` `base` (never hardcoded prefixes); adapter-static's default
`paths.relative` then emits `./`-relative asset URLs, so the same artifact
shape serves from both the `/dweb/` subpath and a domain root.

## Verification record (2026-09-06)

- `SITE_BASE=/opendweb pnpm build` → dist + `[llms-txt] 2 pages → 5 files`
  (en + zh mirrors; was `1 pages → 3 files` before the i18n change).
- Double build: the AI export layer (`llms.txt` / `llms-full.txt` /
  `index.md` / `zh/llms.txt` / `zh/index.md`) is byte-identical across runs
  (the spec's determinism requirement). `index.html` itself differs
  run-to-run ONLY in rolldown content-hash chunk filenames and the
  `__sveltekit_<hash>` variable name — SvelteKit/vite-8 artifact bytes are
  not fully reproducible; no build-time timestamp is embedded in page
  content.
- Static spot checks (`python3 -m http.server`, dist mounted as
  `/opendweb/`): `/`, `/zh/`, both locale llms exports, icon, and EVERY
  relative asset ref the zh page emits (`../_app/...` form) return 200;
  `zh/index.html` ships `lang="zh"`, canonical `/zh/`, and the
  en/zh/x-default hreflang set.
- CNAME gate (standalone postbuild): off → no file; `SITE_CNAME=1` +
  `SITE_URL=https://<domain>` → `dist/CNAME` with the host; a github.io
  SITE_URL or a missing SITE_URL is a hard error.
- `vite dev` serves on port 13322 (slow cold start on the network disk is
  I/O, not configuration; sub-agents use their own port assignment).

## Copy upgrade — purpose-led narrative (2026-09-06 release-automation-and-copy)

- **Narrative structure** (both locales, schema unchanged): hero now leads
  with the problem — multi-device apps need *logical networks* (game-room
  semantics: invite-based membership, stable identity, direct connections),
  not a system-level VPN — then names the three-layer answer (badges +
  Layer 1/2/3 feature eyebrows: EndpointId / Roster+Membership / Session),
  with delivery surfaces (Payload / Self-hosting / Plugins / SDK) as
  `Delivery ·` cards. Every feature summary is motivation-first; all facts
  traceable to README.md / EXAMPLE.md, nothing invented.
- **Version facts are npm-truth, not tag-truth**: the v0.4.2 tag carries
  `opendweb` 0.4.1 in-tree (0.4.2 actually shipped from the `v1.0.1-cli`
  tag), so the site's version line was written from `npm view` results
  (opendweb 0.4.2 · client-sdk / server-binary / example 0.3.2 · ext-cf
  1.0.3 · config 0.1.0), and the sample server banners were bumped
  v0.2.1 → v0.4.2. **Maintenance rule: bump the four version mentions
  (both locales' `packages.summary` + `hero.outputs`/`quickStart.banner`)
  at every release** — they are prose-embedded by design (no build-time
  injection), so NOTES records them as the release checklist item.
- **en/zh isomorphism** is proven at runtime (vite build does not
  typecheck): esbuild-bundle both locale files with
  `--alias:$lib=src/lib`, then deep-diff the key shape — ids
  (`features[].id`, `chrome.anchors[].id`) must match exactly (they drive
  the language-switcher anchor preservation).
- Both serving modes rebuilt green after the rewrite (artifact shape,
  lang/hreflang, relative-asset existence, llms absolute-URL prefixes,
  CNAME gate); the deploy workflow's static assertions grep URLs only, so
  no workflow changes were needed for the copy.
