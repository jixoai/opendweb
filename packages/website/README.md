# dweb website

Private static official site for [dweb](https://github.com/Gaubee/dweb),
rendered in the shared jixoai identity (brand hue 95 — the logo's amber node)
and consumed from the official design-language registry at
<https://ui.jixoai.com>. Zero runtime dependencies; the devDependencies are
the site toolchain only. Implementation notes: [NOTES.md](./NOTES.md).

## Commands

```bash
pnpm --filter dweb-website run dev      # vite dev on port 13322
pnpm --filter dweb-website run build    # vite build + CNAME gate postbuild
pnpm --filter dweb-website run preview  # vite preview on port 13322
```

## Serving modes

The site deploys to GitHub Pages and supports both project-subpath and
custom-domain serving from one build configuration. The deploy workflow
(`.github/workflows/deploy-website.yml`) builds subpath mode by default.

| Mode | Env | Effect |
| ---- | --- | ------ |
| subpath | `SITE_BASE=/opendweb` | `kit.paths.base = "/opendweb"`; serves from `jixoai.github.io/opendweb`; no CNAME file |
| custom domain | `SITE_CNAME=1` `SITE_URL=https://<domain>` | `kit.paths.base = ""`; postbuild writes `dist/CNAME` from the SITE_URL host; llms.txt absolute URLs follow SITE_URL |

`SITE_URL` defaults to `https://jixoai.github.io/opendweb` and feeds the llms-txt
generator. Internal links resolve through `$app/paths` `base` — never
hardcoded prefixes.

## Registry updates

`jixoai-ui.lock` governs the chrome. Refresh locked items with
`npx jixoai-ui upgrade` (or re-`add` a name); the build must stay green with
no hand-edited registry files under `src/lib/`.
