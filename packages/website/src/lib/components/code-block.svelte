<!--
  正交意图（维护于 2026-09-06 Asia/Shanghai）：readonly-code 代码面组件 —
  meta 条（文件名/提示）+ 确定性 tokenizer 着色的 <pre>。
  原始需求（2026-09-06 Asia/Shanghai）：openspec/changes/2026-09-06-add-website —
  快速开始（server / docker / 两终端邀请流）的展示。
-->
<script lang="ts">
  import { highlight } from '$lib/highlight';

  interface Props {
    code: string;
    lang?: 'bash' | 'js' | 'text';
    meta?: string;
    prompt?: boolean;
  }

  let { code, lang = 'bash', meta, prompt = true }: Props = $props();

  const rendered = $derived(highlight(code, lang));
</script>

<figure class="readonly-code">
  {#if meta}
    <figcaption class="readonly-code-meta">
      {#if prompt}<span class="prompt">$</span>{/if}
      <span>{meta}</span>
    </figcaption>
  {/if}
  <pre><code>{@html rendered}</code></pre>
</figure>
