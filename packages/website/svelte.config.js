// 正交意图（维护于 2026-09-06 Asia/Shanghai）：
//   1. adapter-static 严格静态产物（dist/，无服务端运行时）
//   2. SITE_BASE 环境变量 → kit.paths.base（GitHub Pages 子路径 /dweb 起步）
//   3. SITE_CNAME=1 门控的根路径模式（Owner 配置 DNS 后的自定义域切换）
//
// 原始需求（2026-09-06 Asia/Shanghai）：openspec/changes/2026-09-06-add-website —
// 新增官网站点，jixoai.github.io/opendweb 子路径部署起步，CNAME 由 Owner 管理并用
// 构建开关门控（详见 packages/website/README.md 的两种构建模式）。
import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

// 两种服务模式（proposal 决策，不引入更多开关）：
//   默认（子路径）：SITE_BASE=/opendweb → base "/opendweb"，不写 CNAME 文件
//   CNAME 模式：SITE_CNAME=1 → base ""（域根服务），postbuild 写 dist/CNAME
// base 必须是 "" 或以 "/" 开头的合法 kit.paths.base 值；非法值直接失败（宁可构建红）。
const cnameMode = process.env.SITE_CNAME === "1";
const rawBase = cnameMode ? "" : (process.env.SITE_BASE ?? "");
if (rawBase !== "" && !/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/.test(rawBase)) {
  throw new Error(`SITE_BASE must be "" or a root-relative path (got: ${JSON.stringify(rawBase)})`);
}

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess({ script: true }),
  kit: {
    adapter: adapter({ pages: "dist", assets: "dist", strict: true }),
    paths: { base: rawBase },
    prerender: {
      // 单页落地页 × 两 locale：显式 entry、不爬取（站内只有锚点与外部链接）。
      // `/zh/` 带尾斜杠 —— zh/+page.ts 的 trailingSlash "always" 产物是目录
      // index（dist/zh/index.html），静态服务器对 /zh/ 直接 200。
      // （2026-09-06 site-i18n-zh 增补 zh 镜像 entry。）
      crawl: false,
      entries: ["/", "/zh/"],
    },
    // trailingSlash 是页面级选项（+layout.ts 导出），不属于 kit 配置。
  },
};

export default config;
