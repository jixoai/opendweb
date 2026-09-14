// pack:dry 门禁（plugin-marketplace 7.2 升级）：三段式。
//   1) 静态检查——package.json 零运行时依赖（依赖分类语义：bundle 只吃
//      devDependencies，dependencies 视为 external，见 tsdown.config.ts 注释）。
//   2) 产物检查——dist 递归扫描（静态 + 动态 import）无被打包依赖泄漏、
//      体积上限（历史基线 368KB / 上限 2MB）。
//   3) clean-tar 消费者导入测试——真实 npm pack 出 tarball，解包进一个
//      空临时消费者目录的 node_modules（等价于零依赖 tarball 的 npm install
//      落盘结果，且确定性离线），从消费者上下文 import 两个 exports 面
//      （config 面 "." 与 CLI 面 "./opendweb-plugin"），经 package.json
//      exports 映射解析——端到端证明零运行时依赖在干净环境可解析。
// 失败语义：任一段失败即非零退出；临时目录始终清理。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const pkgDir = path.dirname(new URL(".", import.meta.url).pathname);
const pkg = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));

// ---- 1) 零运行时依赖 ----
const deps = pkg.dependencies ?? {};
if (Object.keys(deps).length > 0) {
  console.error("unexpected runtime dependencies:", deps);
  process.exit(1);
}

// ---- 2) dist 静态扫描（泄漏 import + 体积上限） ----
const BUNDLED = ["@clack", "cloudflare", "cloudflared"];
const files = [];
(function walk(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name);
    if (e.isDirectory()) walk(f);
    else files.push(f);
  }
})(path.join(pkgDir, "dist"));
if (files.length === 0) {
  console.error("dist is empty — run the build first");
  process.exit(1);
}
let kb = 0;
const leaks = [];
for (const f of files) {
  kb += statSync(f).size;
  if (!f.endsWith(".mjs")) continue;
  const text = readFileSync(f, "utf8");
  for (const line of text.split("\n")) {
    const t = line.trim();
    if ((t.startsWith("import") || t.startsWith("export")) && BUNDLED.some((b) => t.includes(`"${b}`) || t.includes(`'${b}`))) {
      leaks.push(`${f}: ${t}`);
    }
  }
  for (const m of text.matchAll(/import\s*\(\s*['"]([^'"]+)['"]/g)) {
    const s = m[1];
    if (BUNDLED.some((b) => s === b || s.startsWith(`${b}/`))) leaks.push(`${f}: dynamic import of ${s}`);
  }
}
if (leaks.length > 0) {
  console.error("bundled dependency leaked in dist:");
  for (const l of leaks) console.error(" ", l);
  process.exit(1);
}
if (kb > 2048 * 1024) {
  console.error("dist too large:", Math.round(kb / 1024), "KB");
  process.exit(1);
}

// ---- 3) clean-tar 消费者导入 ----
const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "cf-packdry-"));
try {
  const manifest = JSON.parse(
    execFileSync("npm", ["pack", "--json", `--pack-destination=${tmp}`], { cwd: pkgDir, encoding: "utf8" }),
  )[0];
  const tgz = path.join(tmp, manifest.filename);
  console.log(`packed ${manifest.filename} (${Math.round(manifest.size / 1024)} KB, ${manifest.entryCount} files)`);

  // 解包 tarball 的 package/ 根直接就位为消费者唯一的 node_modules 条目——
  // 与 npm install <tgz>（零依赖包）的落盘结果一致，零网络、零 npm 配置差异
  const consumerDir = path.join(tmp, "consumer");
  const pkgInConsumer = path.join(consumerDir, "node_modules", pkg.name);
  await fsp.mkdir(path.dirname(pkgInConsumer), { recursive: true });
  execFileSync("tar", ["-xzf", tgz, "-C", path.dirname(pkgInConsumer)]);
  await fsp.rename(path.join(path.dirname(pkgInConsumer), "package"), pkgInConsumer);
  // 干净环境自证：包目录之外没有任何 node_modules（bare import 只能由包内自给）
  await fsp.writeFile(path.join(consumerDir, "package.json"), JSON.stringify({ name: "clean-tar-consumer", private: true }, null, 2));
  // exports 面必须出现在 tarball 里（types 不是运行时解析必需，但发布契约要求在场）
  for (const required of ["dist/index.mjs", "dist/cli.mjs", "dist/index.d.mts", "dist/cli.d.mts", "README.md"]) {
    if (!existsSync(path.join(pkgInConsumer, required))) {
      console.error(`tarball missing required file: ${required}`);
      process.exit(1);
    }
  }

  const consumerCode = `
const assert = (await import("node:assert/strict")).default;
const config = (await import(${JSON.stringify(pkg.name)})).default;
const cli = (await import(${JSON.stringify(`${pkg.name}/opendweb-plugin`)})).default;
// config 面：插件对象 {name, hooks}
assert.equal(config.name, "cf");
for (const hook of ["setup", "server.postReady", "server.preStop"]) {
  assert.equal(typeof config.hooks[hook], "function", \`config face hook missing: \${hook}\`);
}
// CLI 面：{name, apiVersion, commands, run}
assert.equal(cli.name, "cf");
assert.equal(cli.apiVersion, 1);
assert.equal(typeof cli.run, "function", "cli face must export run()");
const names = cli.commands.map((c) => c.name);
for (const cmd of ["setup", "verify", "plan", "status", "login", "logout"]) {
  assert.ok(names.includes(cmd), \`cli face command missing: \${cmd}\`);
}
console.log("clean-tar consumer: both exports faces resolved and shaped");
`;
  const consumerEntry = path.join(consumerDir, "consumer.mjs");
  await fsp.writeFile(consumerEntry, consumerCode);
  try {
    execFileSync(process.execPath, [consumerEntry], { cwd: consumerDir, stdio: "inherit" });
  } catch {
    console.error("clean-tar consumer import failed: a bare import in dist does not resolve in a clean environment");
    process.exit(1);
  }

  const sha = createHash("sha256").update(readFileSync(tgz)).digest("hex").slice(0, 16);
  console.log(
    `runtime dependencies: none; no bundled imports leaked (recursive scan, static + dynamic); ` +
      `dist size: ${Math.round(kb / 1024)} KB; tarball ${manifest.filename} (sha256 ${sha}…) imports clean`,
  );
} finally {
  await fsp.rm(tmp, { recursive: true, force: true });
}
