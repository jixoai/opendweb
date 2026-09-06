<!--
  站点外壳（维护于 2026-09-06 Asia/Shanghai）。
  正交意图：
    1. 注册表 website-scaffold 包裹全站（header / main / footer）
    2. TerminalHeader 品牌行（logo slot 内联官方图标 + 锚点导航 + 主题切换）
    3. TerminalFooter 幽灵字收尾 + 生态链接列
    4. 根级一次性导入：app.css、scrollbar-measure（滚动条法则的探针）
    5. locale 感知 chrome（en 根路径 / zh 镜像）+ registry language-switcher
       接入 header switcher 槽，切换保持当前锚点/路径
  原始需求（2026-09-06 Asia/Shanghai）：openspec/changes/2026-09-06-add-website —
  jixoai 家族一致的站点 chrome，仅 hue（95）与内容不同。
  2026-09-06 site-i18n-zh：nav/footer/aria 文案改由 locale 字典注入（`/` = en，
  `/zh/` = zh），锚点 id 两 locale 一致。
  站内链接法则：走 $app/paths 的 base（homeHref），绝不硬编码前缀。
-->
<script lang="ts">
  import '../app.css';
  // 注册表文档写的是 `import '@lib/scrollbar-measure'`（假定了非 SvelteKit 的
  // 别名布局）；SvelteKit 的标准别名是 $lib —— 与 unipty NOTES 的 toc 修正同类。
  import '$lib/scrollbar-measure';
  import { base } from '$app/paths';
  import { page } from '$app/state';
  import { onMount } from 'svelte';
  import AppShell from '$lib/ui/website-scaffold/website-scaffold.svelte';
  import TerminalHeader from '$lib/ui/terminal-header/terminal-header.svelte';
  import NavigationMenuLink from '$lib/ui/navigation-menu/navigation-menu-link.svelte';
  import TerminalFooter from '$lib/ui/terminal-footer/terminal-footer.svelte';
  import TerminalFooterColumn from '$lib/ui/terminal-footer/terminal-footer-column.svelte';
  import ThemeToggle from '$lib/ui/theme-toggle/theme-toggle.svelte';
  import LanguageSwitcher from '$lib/ui/language-switcher/language-switcher.svelte';
  import {
    DOCKER_URL,
    EXAMPLE_URL,
    EXAMPLE_ZH_URL,
    GITHUB_URL,
    NPM_PACKAGES,
    README_URL,
    README_ZH_URL,
    SITE_DOMAIN,
    npmUrl,
  } from '$lib/constants';
  import { getLocaleContent, localeOfRoute, routeOfPath } from '$lib/i18n/content';
  import type { Snippet } from 'svelte';

  let { children }: { children: Snippet } = $props();

  // locale 判定：route 空间（剥 base）下 /zh 前缀即 zh，其余（含 `/`）为 en。
  const route = $derived(routeOfPath(page.url.pathname, base));
  const locale = $derived(localeOfRoute(route));
  const content = $derived(getLocaleContent(locale));

  // 品牌链接留在当前 locale（zh 页回 /zh/，en 页回 /）。
  const home = $derived(locale === 'zh' ? `${base}/zh/` : `${base}/`);
  const anchors = $derived(content.chrome.anchors);

  // 语言切换保持当前锚点：两 locale 锚点 id 一致，切换 href = 目标 locale
  // 页 + 当前 hash。SSR/预渲染输出不带 hash（无 JS 也可用），hydration 后
  // 跟随 hashchange 保持同步。
  let hash = $state('');
  onMount(() => {
    const sync = () => {
      hash = window.location.hash;
    };
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  });
  const enHref = $derived(`${base}/${hash}`);
  const zhHref = $derived(`${base}/zh/${hash}`);

  const switcherLocales = $derived([
    { code: 'en', label: 'EN', href: enHref },
    { code: 'zh', label: '中文', href: zhHref },
  ]);
</script>

<AppShell>
  {#snippet header()}
    <TerminalHeader
      brand="dweb"
      domain={SITE_DOMAIN}
      subtitle={content.chrome.subtitle}
      homeHref={home}
      switcherFrame={false}
    >
      {#each anchors as anchor (anchor.id)}
        <NavigationMenuLink href={'#' + anchor.id}>{anchor.label}</NavigationMenuLink>
      {/each}
      <NavigationMenuLink href={GITHUB_URL}>{content.chrome.githubLabel}</NavigationMenuLink>
      {#snippet logo()}
        <!-- 官方图标（assets/opendweb-icon.png，Owner 指定 direct 变体） -->
        <img
          src="{base}/opendweb-icon.png"
          alt=""
          class="h-6 w-6"
          loading="eager"
          decoding="async"
        />
      {/snippet}
      {#snippet switcher()}
        <div class="flex flex-wrap items-center gap-2">
          <ThemeToggle variant="compact" />
          <LanguageSwitcher
            variant="pair"
            locales={switcherLocales}
            current={locale}
            ariaLabel={content.chrome.languageLabel}
          />
        </div>
      {/snippet}
      {#snippet drawer()}
        <nav class="flex flex-col gap-1 py-2" aria-label={content.chrome.drawerLabel}>
          {#each anchors as anchor (anchor.id)}
            <a
              href={'#' + anchor.id}
              class="font-nav text-terminal-foreground/80 hover:text-terminal-foreground px-2 py-2 text-sm uppercase tracking-[0.12em]"
            >
              {anchor.label}
            </a>
          {/each}
          <a
            href={GITHUB_URL}
            class="font-nav text-terminal-foreground/80 hover:text-terminal-foreground px-2 py-2 text-sm uppercase tracking-[0.12em]"
          >
            {content.chrome.githubLabel}
          </a>
        </nav>
      {/snippet}
    </TerminalHeader>
  {/snippet}

  {@render children()}

  {#snippet footer()}
    <TerminalFooter ghost="DWEB" copyright="MIT OR Apache-2.0 · Gaubee/dweb">
      <TerminalFooterColumn title="project">
        <a href={GITHUB_URL}>GitHub</a>
        <a href={locale === 'zh' ? README_URL : README_ZH_URL}>{content.chrome.readmeLabel}</a>
        <a href={locale === 'zh' ? EXAMPLE_ZH_URL : EXAMPLE_URL}>
          {content.chrome.exampleLabel}
        </a>
      </TerminalFooterColumn>
      <TerminalFooterColumn title="npm">
        {#each NPM_PACKAGES as p (p.pkg)}
          <a href={npmUrl(p.pkg)}>{p.pkg}</a>
        {/each}
      </TerminalFooterColumn>
      <TerminalFooterColumn title="deploy">
        <a href={DOCKER_URL}>ghcr.io/gaubee/dweb</a>
      </TerminalFooterColumn>
    </TerminalFooter>
  {/snippet}
</AppShell>
