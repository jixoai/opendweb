// 正交意图（维护于 2026-09-06 Asia/Shanghai）：
//   1. 渲染期把 app.html 的 lang 占位符替换为按 route 判定的 locale（/zh 镜像
//      → zh，其余（含 `/`）→ en）。预渲染也走 handle 管线，因此静态产物自带
//      正确的 <html lang>；对不含占位符的 chunk 替换是 no-op（流式分块安全）。
//      base（SITE_BASE/SITE_CNAME）先剥再判定，两种部署模式同一结果。
//   2. 语言协商脚本的服务模式 base（2026-09-06 locale-negotiation 增补）：
//      同源解析 SITE_BASE/SITE_CNAME（与 svelte.config.js 同律）烘焙进 app.html。
//      不用 $app/paths 的 base —— 预渲染期它是页相对形态（见 i18n/content
//      同类注释），env 解析才与 kit.paths.base 恒等。
//
// 原始需求（2026-09-06 Asia/Shanghai）：openspec/changes/2026-09-06-site-i18n-zh —
// 每 locale 的 <html lang>；模式沿用 openspecui 双语站（registry 采纳前的
// 手写参考，language-switcher 即按其构图）。
import type { Handle } from '@sveltejs/kit';
import { base } from '$app/paths';
import { localeOfRoute, routeOfPath } from '$lib/i18n/content';

// 与 svelte.config.js 同律：CNAME 模式 → 根路径；否则 SITE_BASE 规格化
// （剥首尾斜杠、确保以 / 开头）。
const cnameMode = process.env.SITE_CNAME === '1';
const rawBase = cnameMode ? '' : (process.env.SITE_BASE ?? '').replace(/^\/+|\/+$/g, '');
const siteBase = rawBase === '' ? '' : `/${rawBase}`;

export const handle: Handle = async ({ event, resolve }) => {
  const lang = localeOfRoute(routeOfPath(event.url.pathname, base));
  return resolve(event, {
    // replaceAll（非首个匹配替换）：文档里若再次出现该占位符字面量（注释等），
    // 也不让首个匹配位被注释抢走 —— 首个命中点必须落在根元素 lang 上。
    transformPageChunk: ({ html }) =>
      typeof html === 'string'
        ? html.replaceAll('%lang%', lang).replaceAll('%site_base%', siteBase)
        : html,
  });
};
