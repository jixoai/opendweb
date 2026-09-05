// 正交意图（维护于 2026-09-06 Asia/Shanghai）：构建后处理 — SITE_CNAME=1 时写
// dist/CNAME（Owner 管理 DNS 后的自定义域切换；内容取 SITE_URL 的 host）。
// 除 CNAME 外不动任何产物（llms-txt 的 declared-outputs-only 法则）。
//
// 原始需求（2026-09-06 Asia/Shanghai）：openspec/changes/2026-09-06-add-website —
// 自定义域 CNAME 由 Owner 管理并用构建开关门控，DNS 就绪前从
// jixoai.github.io/opendweb 子路径服务。两种模式的用法见 README.md。
import { writeFileSync } from "node:fs";

if (process.env.SITE_CNAME === "1") {
  const raw = process.env.SITE_URL ?? "";
  let host;
  try {
    host = new URL(raw).host;
  } catch {
    throw new Error(`SITE_CNAME=1 requires SITE_URL to be the custom-domain origin (got: ${JSON.stringify(raw)})`);
  }
  if (host.endsWith("github.io")) {
    throw new Error(
      `SITE_CNAME=1 requires a custom domain, but SITE_URL is a github.io host (${host}); ` +
        "subpath mode needs no CNAME file",
    );
  }
  writeFileSync(new URL("../dist/CNAME", import.meta.url), `${host}\n`);
  console.log(`website: CNAME → ${host}`);
} else {
  console.log("website: CNAME gate off (subpath mode) — dist/CNAME not written");
}
