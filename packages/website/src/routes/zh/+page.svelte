<!--
  首页 · zh（维护于 2026-09-06 Asia/Shanghai）—— `/zh/` 中文镜像，与 en 页
  同构（同一 home-page 组件），文案取自 README-zh.md（i18n/locales/zh.ts）。
  head 与 en 页同组 hreflang（en/zh/x-default）+ 指向 /zh/ 的 canonical。
  原始需求（2026-09-06 Asia/Shanghai）：openspec/changes/2026-09-06-site-i18n-zh。
-->
<script lang="ts">
  import HomePage from '$lib/pages/home-page.svelte';
  import { zh } from '$lib/i18n/locales/zh';
  import { SITE_URL } from '$lib/site-url';
</script>

<svelte:head>
  <title>{zh.meta.siteTitle}</title>
  <meta name="description" content={zh.meta.description} />
  <link rel="canonical" href={`${SITE_URL}/zh/`} />
  <link rel="alternate" hreflang="en" href={`${SITE_URL}/`} />
  <link rel="alternate" hreflang="zh" href={`${SITE_URL}/zh/`} />
  <link rel="alternate" hreflang="x-default" href={`${SITE_URL}/`} />
</svelte:head>

<HomePage content={zh} />
