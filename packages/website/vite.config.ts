// 正交意图（维护于 2026-09-06 Asia/Shanghai）：
//   1. SvelteKit + Tailwind v4 构建管线
//   2. llms-txt 唯一生成点（vite 插件，SSR closeBundle 扫描最终 dist）
//   3. dev/preview 端口固定 13322（多 agent 并行开发端口纪律）
//
// 原始需求（2026-09-06 Asia/Shanghai）：openspec/changes/2026-09-06-add-website —
// AI 导出层随构建产出 llms.txt / llms-full.txt / 每页 .md 镜像，绝对 URL。
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { llmsTxt } from "./src/vite-plugins/llms-txt.mjs";

// 站点对外绝对地址：默认 GitHub Pages 子路径；CNAME 切换时由 SITE_URL 覆盖
// （postbuild.mjs 用同一变量的 host 写 dist/CNAME，两个模式共用一个事实源）。
const siteUrl = process.env.SITE_URL ?? "https://gaubee.github.io/dweb";

export default defineConfig({
  plugins: [
    sveltekit(),
    tailwindcss(),
    llmsTxt({
      distDir: "dist",
      siteUrl,
      title: "dweb",
      summary:
        "Application-level networking platform: multi-device apps form logical networks (game rooms, not system VPNs) with Ed25519 identity, signed-fact rosters, invite-gated membership, and iroh/QUIC direct connections with self-hosted relay fallback.",
    }),
  ],
  server: { port: 13322 },
  preview: { port: 13322 },
});
