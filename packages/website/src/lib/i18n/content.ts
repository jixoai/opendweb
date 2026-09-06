// 正交意图（维护于 2026-09-06 Asia/Shanghai）：locale 解析 —— 路由 → 内容字典。
// `/` = en（URL 稳定），`/zh/` = zh 镜像；routeOfPath 剥掉 kit base 后判定，
// base 有无（SITE_BASE/SITE_CNAME 两模式）都不影响结果。
//
// 原始需求（2026-09-06 Asia/Shanghai）：openspec/changes/2026-09-06-site-i18n-zh。
import { en } from '$lib/i18n/locales/en';
import { zh } from '$lib/i18n/locales/zh';
import type { WebsiteContent } from '$lib/i18n/schema';

export type WebsiteLanguage = 'en' | 'zh';

export const websiteLanguages: readonly WebsiteLanguage[] = ['en', 'zh'];

export function getLocaleContent(language: WebsiteLanguage): WebsiteContent {
  return language === 'zh' ? zh : en;
}

/** 归一化路由路径：剥 base 前缀（有则剥），返回以 / 开头的 route 空间路径。 */
export function routeOfPath(pathname: string, base: string): string {
  const stripped =
    base !== '' && pathname.startsWith(base) ? pathname.slice(base.length) : pathname;
  return stripped.startsWith('/') ? stripped : `/${stripped}`;
}

/** 该 route 是否属于 zh 镜像（/zh 与 /zh/ 都算，/zh-foo 不算）。 */
export function isZhRoute(route: string): boolean {
  return route === '/zh' || route === '/zh/' || route.startsWith('/zh/');
}

/** route → locale（en 为默认：根路径与一切非 /zh 路径）。 */
export function localeOfRoute(route: string): WebsiteLanguage {
  return isZhRoute(route) ? 'zh' : 'en';
}
