// Svelte 配置（构建期工具链；TS in .svelte 由 vitePreprocess 处理）。
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

export default {
  preprocess: vitePreprocess(),
};
