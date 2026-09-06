// 正交意图（维护于 2026-09-06 Asia/Shanghai）：站点对外绝对 URL 的客户端/
// SSR 可用形态 —— vite `define` 在构建期以字面量替换 __SITE_URL__（与
// vite.config.ts 的 siteUrl / postbuild 的 CNAME 同一事实源 SITE_URL env，
// 默认 https://jixoai.github.io/opendweb）。canonical 与 hreflang 需要
// 绝对 URL，而客户端 bundle 读不到 process.env，故走 define。
//
// 原始需求（2026-09-06 Asia/Shanghai）：openspec/changes/2026-09-06-site-i18n-zh —
// hreflang（en/zh/x-default）与 canonical 必须随部署模式（子路径/CNAME）变化。

declare const __SITE_URL__: string;

/** 站点对外绝对 origin+子路径（无尾斜杠），如 https://jixoai.github.io/opendweb */
export const SITE_URL: string = __SITE_URL__;
