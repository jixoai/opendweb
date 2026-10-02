// Vite 构建配置（webui-console UI 层 Svelte 5 重做）。
// 依赖只在构建期（devDependencies）——运行时是纯静态产物 + 零依赖 sidecar。
// hash 路由无需服务端配合；dist 随包分发（files 含 dist，产物提交入库）。
// 开发期（npm run dev）：/api 与 /sidecar 代理到本地 sidecar（WEBUI_SIDECAR
// 环境变量指定其 origin；changeOrigin 保证 /sidecar/connect 的 Host 校验通过
// ——sidecar 断言 Host === 127.0.0.1:port，代理改写后端看到的即目标地址）。
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";

const pkgRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: "ui",
  // 静态资产目录是 static/（非 vite 默认的 public/）——favicon 等 root 级文件
  // 经此复制进 dist 根；漏配则 /opendweb-icon.svg 404（2026-10-03 favicon 事故）。
  publicDir: "static",
  plugins: [tailwindcss(), svelte()],
  resolve: {
    alias: {
      $lib: path.resolve(pkgRoot, "ui/src/lib"),
    },
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    target: "es2022",
  },
  server: {
    proxy: {
      // dev 期同源模拟：sidecar 校验 Host 与 Origin 都必须等于其自身 origin
      // （CSRF/rebinding 防线）——代理改写两者后，浏览器侧语义与生产同源一致。
      "/api": {
        target: process.env.WEBUI_SIDECAR ?? "http://127.0.0.1:8787",
        changeOrigin: true,
      },
      "/sidecar": {
        target: process.env.WEBUI_SIDECAR ?? "http://127.0.0.1:8787",
        changeOrigin: true,
        headers: process.env.WEBUI_SIDECAR ? { origin: process.env.WEBUI_SIDECAR } : undefined,
      },
    },
  },
});
