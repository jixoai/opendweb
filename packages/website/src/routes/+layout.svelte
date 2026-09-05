<!--
  站点外壳（维护于 2026-09-06 Asia/Shanghai）。
  正交意图：
    1. 注册表 website-scaffold 包裹全站（header / main / footer）
    2. TerminalHeader 品牌行（logo slot 内联官方图标 + 锚点导航 + 主题切换）
    3. TerminalFooter 幽灵字收尾 + 生态链接列
    4. 根级一次性导入：app.css、scrollbar-measure（滚动条法则的探针）
  原始需求（2026-09-06 Asia/Shanghai）：openspec/changes/2026-09-06-add-website —
  jixoai 家族一致的站点 chrome，仅 hue（87）与内容不同。
  站内链接法则：走 $app/paths 的 base（homeHref），绝不硬编码前缀。
-->
<script lang="ts">
  import '../app.css';
  // 注册表文档写的是 `import '@lib/scrollbar-measure'`（假定了非 SvelteKit 的
  // 别名布局）；SvelteKit 的标准别名是 $lib —— 与 unipty NOTES 的 toc 修正同类。
  import '$lib/scrollbar-measure';
  import { base } from '$app/paths';
  import AppShell from '$lib/ui/website-scaffold/website-scaffold.svelte';
  import TerminalHeader from '$lib/ui/terminal-header/terminal-header.svelte';
  import NavigationMenuLink from '$lib/ui/navigation-menu/navigation-menu-link.svelte';
  import TerminalFooter from '$lib/ui/terminal-footer/terminal-footer.svelte';
  import TerminalFooterColumn from '$lib/ui/terminal-footer/terminal-footer-column.svelte';
  import ThemeToggle from '$lib/ui/theme-toggle/theme-toggle.svelte';
  import {
    DOCKER_URL,
    EXAMPLE_URL,
    GITHUB_URL,
    NPM_PACKAGES,
    README_ZH_URL,
    SITE_DOMAIN,
    SITE_SUBTITLE,
    npmUrl,
  } from '$lib/constants';
  import type { Snippet } from 'svelte';

  let { children }: { children: Snippet } = $props();

  const home = `${base}/`;

  // 单页锚点导航（#features/#quick-start/#packages/#ecosystem）
  const anchors = [
    { href: '#features', label: 'Features' },
    { href: '#quick-start', label: 'Quick start' },
    { href: '#packages', label: 'Packages' },
    { href: '#ecosystem', label: 'Ecosystem' },
  ] as const;
</script>

<AppShell>
  {#snippet header()}
    <TerminalHeader
      brand="dweb"
      domain={SITE_DOMAIN}
      subtitle={SITE_SUBTITLE}
      homeHref={home}
      switcherFrame={false}
    >
      {#each anchors as anchor (anchor.href)}
        <NavigationMenuLink href={anchor.href}>{anchor.label}</NavigationMenuLink>
      {/each}
      <NavigationMenuLink href={GITHUB_URL}>GitHub ↗</NavigationMenuLink>
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
        <ThemeToggle variant="compact" />
      {/snippet}
      {#snippet drawer()}
        <nav class="flex flex-col gap-1 py-2" aria-label="Site">
          {#each anchors as anchor (anchor.href)}
            <a
              href={anchor.href}
              class="font-nav text-terminal-foreground/80 hover:text-terminal-foreground px-2 py-2 text-sm uppercase tracking-[0.12em]"
            >
              {anchor.label}
            </a>
          {/each}
          <a
            href={GITHUB_URL}
            class="font-nav text-terminal-foreground/80 hover:text-terminal-foreground px-2 py-2 text-sm uppercase tracking-[0.12em]"
          >
            GitHub ↗
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
        <a href={README_ZH_URL}>README（中文）</a>
        <a href={EXAMPLE_URL}>EXAMPLE.md</a>
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
