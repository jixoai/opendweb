<!--
  首页主体（维护于 2026-09-06 Asia/Shanghai）—— 自 routes/+page.svelte 抽取的
  内容驱动组件：en（`/`）与 zh（`/zh/`）渲染同一组件，两 locale 同构。
  正交意图：
    1. Hero（定位陈述 + 复制 CTA + 服务器横幅终端）
    2. Features 网格（README 的四层事实 + 插件/SDK，card-grid 自持入场）
    3. Quick start（自托管 server / docker / 两终端邀请流）
    4. Packages 表（npm 清单，一字不虚）+ Ecosystem（插件 + Node SDK 样例）
  原始需求（2026-09-06 Asia/Shanghai）：openspec/changes/2026-09-06-add-website —
  内容全部来自 README.md 定位，不虚构声明。data-reveal 为静态标记（注册表
  scroll-driven reveal 契约）；card-grid 的直接子卡绝不包 data-reveal。
  2026-09-06 site-i18n-zh：文案改由 content（en/zh 字典）注入，锚点 id 两
  locale 一致（language-switcher 保持锚点的前提）。
-->
<script lang="ts">
  import HeroSection from '$lib/ui/hero-section/hero-section.svelte';
  import SectionCard from '$lib/ui/section-card/section-card.svelte';
  import CardGrid from '$lib/ui/card-grid/card-grid.svelte';
  import PressButton from '$lib/ui/press-button/press-button.svelte';
  import TerminalCard from '$lib/ui/terminal-card/terminal-card.svelte';
  import CodeBlock from '$lib/components/code-block.svelte';
  import { DOCKER_URL, GITHUB_URL, npmUrl } from '$lib/constants';
  import type { WebsiteContent } from '$lib/i18n/schema';

  interface Props {
    content: WebsiteContent;
  }

  let { content }: Props = $props();

  const noteLinkHref = (kind: 'docker' | 'github'): string =>
    kind === 'docker' ? DOCKER_URL : GITHUB_URL;
</script>

<HeroSection
  eyebrow={content.hero.eyebrow}
  copyCommand={content.hero.command}
  summary={content.hero.summary}
>
  {#snippet title()}
    {content.hero.titleLead}<em>{content.hero.titleEm}</em>{content.hero.titleTail}
  {/snippet}
  {#snippet badges()}
    {#each content.hero.badges as badge (badge)}
      <span>{badge}</span>
    {/each}
  {/snippet}
  {#snippet secondary()}
    <PressButton variant="outline" href={GITHUB_URL} external>{content.chrome.githubLabel}</PressButton>
    <PressButton variant="outline" href="#quick-start">{content.hero.quickStartLabel}</PressButton>
  {/snippet}
  {#snippet terminal()}
    <TerminalCard
      barTitle={content.hero.barTitle}
      command={content.hero.command}
      outputs={content.hero.outputs}
    />
  {/snippet}
</HeroSection>

<!-- Features：README 四层协议事实 + 交付面（card-grid 自持入场，子卡不加 reveal）。 -->
<section id="features" class="mx-auto w-full max-w-[90rem] px-4 sm:px-6 lg:px-8">
  <h2
    class="font-nav flex items-baseline gap-4 text-lg uppercase tracking-[0.3em]"
    data-reveal=""
  >
    {content.featuresHeading}
    <span class="bg-border h-px flex-1" aria-hidden="true"></span>
  </h2>
  <div class="mt-6">
    <CardGrid min="340px">
      {#each content.features as feature (feature.id)}
        <SectionCard eyebrow={feature.eyebrow} title={feature.title} summary={feature.summary}>
          <p class="text-muted-foreground text-[12px] leading-5">
            <code>{feature.id}</code>
          </p>
        </SectionCard>
      {/each}
    </CardGrid>
  </div>
</section>

<!-- Quick start：server / docker / 两终端邀请流。 -->
<div
  id="quick-start"
  class="mx-auto w-full max-w-[90rem] px-4 pt-10 sm:px-6 lg:px-8"
  data-reveal=""
>
  <SectionCard
    eyebrow={content.quickStart.eyebrow}
    title={content.quickStart.title}
    summary={content.quickStart.summary}
  >
    <div class="flex flex-col gap-4">
      <CodeBlock code={content.quickStart.script} lang="bash" meta={content.quickStart.scriptMeta} prompt={false} />
      <CodeBlock code={content.quickStart.banner} lang="text" meta={content.quickStart.bannerMeta} prompt={false} />
    </div>
    <p class="text-muted-foreground mt-4 text-[13px] leading-5">
      {#each content.quickStart.note as segment, i (i)}
        {#if segment.t === 'text'}{segment.v}{:else if segment.t === 'code'}<code>{segment.v}</code>{:else}<a
            href={noteLinkHref(segment.kind)}
            class="text-primary underline underline-offset-2">{segment.v}</a
          >{/if}
      {/each}
    </p>
  </SectionCard>
</div>

<!-- Packages：npm 清单（README 表格原样）。 -->
<div
  id="packages"
  class="mx-auto w-full max-w-[90rem] px-4 pt-8 sm:px-6 lg:px-8"
  data-reveal=""
>
  <SectionCard
    eyebrow={content.packages.eyebrow}
    title={content.packages.title}
    summary={content.packages.summary}
  >
    <div class="table-scroll">
      <table class="data-table">
        <thead>
          <tr>
            <th>{content.packages.pkgHeader}</th>
            <th>{content.packages.roleHeader}</th>
          </tr>
        </thead>
        <tbody>
          {#each content.packages.rows as p (p.pkg)}
            <tr>
              <td><a href={npmUrl(p.pkg)} class="text-primary underline underline-offset-2"><code>{p.pkg}</code></a></td>
              <td>{p.role}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </SectionCard>
</div>

<!-- Ecosystem：插件 + Node SDK。 -->
<div
  id="ecosystem"
  class="mx-auto w-full max-w-[90rem] px-4 pb-4 pt-8 sm:px-6 lg:px-8"
  data-reveal=""
>
  <SectionCard
    eyebrow={content.ecosystem.eyebrow}
    title={content.ecosystem.title}
    summary={content.ecosystem.summary}
  >
    <div class="flex flex-col gap-6 lg:flex-row">
      <div class="min-w-0 flex-1">
        <p class="font-nav text-primary mb-2 text-[11px] uppercase tracking-[0.24em]">
          {content.ecosystem.pluginLabel}
        </p>
        <CodeBlock code={content.ecosystem.pluginSample} lang="bash" meta={content.ecosystem.pluginMeta} prompt={false} />
      </div>
      <div class="min-w-0 flex-1">
        <p class="font-nav text-primary mb-2 text-[11px] uppercase tracking-[0.24em]">
          {content.ecosystem.sdkLabel}
        </p>
        <CodeBlock code={content.ecosystem.sdkSample} lang="js" meta={content.ecosystem.sdkMeta} prompt={false} />
      </div>
    </div>
    <p class="text-muted-foreground mt-4 text-[13px] leading-5">
      {#each content.ecosystem.note as segment, i (i)}
        {#if segment.t === 'text'}{segment.v}{:else if segment.t === 'code'}<code>{segment.v}</code>{:else}<a
            href={noteLinkHref(segment.kind)}
            class="text-primary underline underline-offset-2">{segment.v}</a
          >{/if}
      {/each}
    </p>
  </SectionCard>
</div>
