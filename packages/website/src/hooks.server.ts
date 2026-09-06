// 正交意图（维护于 2026-09-06 Asia/Shanghai）：唯一的服务端 hook —— 渲染期
// 把 app.html 的 %lang% 占位符替换为按 route 判定的 locale（/zh 镜像 → zh，
// 其余（含 `/`）→ en）。预渲染也走 handle 管线，因此静态产物自带正确的
// <html lang>；对不含占位符的 chunk 替换是 no-op（流式分块安全）。
// base（SITE_BASE/SITE_CNAME）先剥再判定，两种部署模式同一结果。
//
// 原始需求（2026-09-06 Asia/Shanghai）：openspec/changes/2026-09-06-site-i18n-zh —
// 每 locale 的 <html lang>；模式沿用 openspecui 双语站（registry 采纳前的
// 手写参考，language-switcher 即按其构图）。
import type { Handle } from '@sveltejs/kit';
import { base } from '$app/paths';
import { localeOfRoute, routeOfPath } from '$lib/i18n/content';

export const handle: Handle = async ({ event, resolve }) => {
  const lang = localeOfRoute(routeOfPath(event.url.pathname, base));
  return resolve(event, {
    // replaceAll（非首个匹配替换）：文档里若再次出现该占位符字面量（注释等），
    // 也不让首个匹配位被注释抢走 —— 首个命中点必须落在根元素 lang 上。
    transformPageChunk: ({ html }) => html.replaceAll('%lang%', lang),
  });
};
