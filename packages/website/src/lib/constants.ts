// 正交意图（维护于 2026-09-06 Asia/Shanghai）：站点常量（品牌、外部链接、
// npm 包清单）。单一事实源，布局与页面从这里取数，不散落硬编码。
//
// 原始需求（2026-09-06 Asia/Shanghai）：openspec/changes/2026-09-06-add-website —
// 内容全部取自仓库 README.md / README-zh.md，不虚构。
// 2026-09-07 rename：展示层去 dweb 化（Owner 指令，GitHub 仓库已改名
// jixoai/opendweb）——品牌词 OpenDWeb，外部链接/容器包页全部指向
// jixoai/opendweb 命名空间（ghcr 包页为 jixoai/opendweb/pkgs/container/opendweb）。
export const SITE_TITLE = "OpenDWeb";
export const SITE_DOMAIN = "github.com/jixoai/opendweb";
export const SITE_SUBTITLE = "application-level networking";
export const GITHUB_URL = "https://github.com/jixoai/opendweb";
export const README_URL = "https://github.com/jixoai/opendweb/blob/main/README.md";
export const README_ZH_URL = "https://github.com/jixoai/opendweb/blob/main/README-zh.md";
export const EXAMPLE_URL = "https://github.com/jixoai/opendweb/blob/main/EXAMPLE.md";
export const EXAMPLE_ZH_URL = "https://github.com/jixoai/opendweb/blob/main/EXAMPLE-zh.md";
export const DOCKER_URL = "https://github.com/jixoai/opendweb/pkgs/container/opendweb";

/** README「Packages」表的站点呈现（npm 链接 + 角色，一字不虚）。 */
export const NPM_PACKAGES: readonly { pkg: string; role: string }[] = [
  { pkg: "opendweb", role: "Server CLI — `npx opendweb server` starts the self-hosted gateway + relay; plugin marketplace host" },
  { pkg: "@jixo/opendweb-server-binary", role: "Server binary wrapper used by the CLI; also exposes a programmatic `startServer()`" },
  { pkg: "@jixo/opendweb-example", role: "Reference two-process client CLI (`init` / `invite` / `join` / `chat`)" },
  { pkg: "@jixo/opendweb-client-sdk", role: "Node SDK for embedding fabrics in your own app (napi-rs; darwin-arm64 / win32-x64)" },
  { pkg: "@jixo/opendweb-config", role: "`definePlugin` helper for local plugin files (runtime-agnostic: deno / bun / node)" },
  { pkg: "@jixo/opendweb-ext-cf", role: "Cloudflare Tunnel plugin: ingress push via API, DNS routing, end-to-end verification, optional cloudflared co-spawn" },
];

export const npmUrl = (pkg: string): string => `https://www.npmjs.com/package/${pkg}`;
