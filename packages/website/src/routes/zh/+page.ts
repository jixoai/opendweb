// zh 镜像页的页面级选项（维护于 2026-09-06 Asia/Shanghai）：
// trailingSlash 覆盖为 "always" —— /zh/（目录 index 形态 dist/zh/index.html）
// 是该 locale 的规范 URL，静态服务器（GitHub Pages / http.server）对
// /zh/ 直接 200；根布局的 "never" 只治理 `/`（en）。
// prerender 自根布局继承（true）。
//
// 原始需求（2026-09-06 Asia/Shanghai）：openspec/changes/2026-09-06-site-i18n-zh。
export const trailingSlash = 'always';
