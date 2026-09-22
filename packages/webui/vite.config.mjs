// Vite 构建配置（webui-console design §1：ui/ 构建期源码 → dist/ 发布产物）。
// 依赖只在构建期（devDependencies）——运行时是纯静态产物 + 零依赖 sidecar。
// hash 路由无需服务端配合；dist 随包分发（files 含 dist，产物提交入库）。
import { defineConfig } from "vite";

export default defineConfig({
  root: "ui",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    target: "es2022",
  },
});
