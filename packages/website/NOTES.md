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
  `terminal-footer`, `theme-toggle`, `hero-section`, `section-card`,
  `press-button`, `terminal-card`, `card-grid`, `llms-txt`
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
  wired: the site is a single page; the scaffold's cross-document choreography
  has nothing to animate.

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

- `SITE_BASE=/opendweb pnpm build` → dist + `[llms-txt] 1 pages → 3 files`.
- Double build: the AI export layer (`llms.txt` / `llms-full.txt` / `index.md`)
  is byte-identical across runs (the spec's determinism requirement).
  `index.html` itself differs run-to-run ONLY in rolldown content-hash chunk
  filenames and the `__sveltekit_<hash>` variable name — SvelteKit/vite-8
  artifact bytes are not fully reproducible; no build-time timestamp is
  embedded in page content.
- Preview server spot checks under the `/dweb/` mount: page, all CSS/JS
  chunks, icon assets, and the three llms exports all return 200.
- CNAME gate (standalone postbuild): off → no file; `SITE_CNAME=1` +
  `SITE_URL=https://<domain>` → `dist/CNAME` with the host; a github.io
  SITE_URL or a missing SITE_URL is a hard error.
- `vite dev` serves on port 13322 (slow cold start on the network disk is
  I/O, not configuration).
