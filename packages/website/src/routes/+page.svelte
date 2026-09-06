<!--
  首页 · en（维护于 2026-09-06 Asia/Shanghai）—— `/` 保持英文（URL 稳定）。
  页面本体在 lib/pages/home-page.svelte（内容驱动），本文件只注入 en 字典与
  locale 级 head（canonical + hreflang en/zh/x-default，绝对 URL 随部署模式）。
  原始需求（2026-09-06 Asia/Shanghai）：openspec/changes/2026-09-06-add-website；
  2026-09-06 site-i18n-zh 增补 hreflang/canonical 与字典化改版。
-->
<script lang="ts">
  import HomePage from '$lib/pages/home-page.svelte';
  import { en } from '$lib/i18n/locales/en';
  import { SITE_URL } from '$lib/site-url';
</script>

<svelte:head>
  <title>{en.meta.siteTitle}</title>
  <meta name="description" content={en.meta.description} />
  <link rel="canonical" href={`${SITE_URL}/`} />
  <link rel="alternate" hreflang="en" href={`${SITE_URL}/`} />
  <link rel="alternate" hreflang="zh" href={`${SITE_URL}/zh/`} />
  <link rel="alternate" hreflang="x-default" href={`${SITE_URL}/`} />
</svelte:head>

<HomePage content={en} />
