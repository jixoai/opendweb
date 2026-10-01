// 自适应解析与插件 CLI 面契约单测：候选解析语义（未安装→下一候选；已安装但
// 清单坏→硬错误）、参数解析（JSON Schema 子集）、help 零执行、执行包装器。
import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolveAdaptive, resolvePluginEntry, BUILTIN_COMMANDS, PluginNotResolved } from "../src/plugin-resolve.mjs";
import { parseCommandArgs, dispatchPluginCommand, renderPluginHelp, foldSingleCommand, PluginManifestSchema } from "../src/plugin-contract.mjs";
import { candidatesFor, DEFAULT_GLOBS } from "../src/marketplace.mjs";
import { CliExit } from "../src/util.mjs";

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

/** 造一个「已安装」状态的项目目录：node_modules/<pkg> = fixtures 复制 */
async function projectWith(...pkgNames) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "opendweb-proj-"));
  await fsp.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "t", private: true }), "utf8");
  await fsp.mkdir(path.join(dir, "node_modules"), { recursive: true });
  for (const pkg of pkgNames) {
    await fsp.cp(path.join(FIXTURES, pkg), path.join(dir, "node_modules", pkg), { recursive: true });
  }
  return dir;
}

test("builtin commands reserved (adaptive never shadows them)", () => {
  for (const b of ["server", "help", "marketplace", "plugin", "use", "config", "setup"]) {
    assert.ok(BUILTIN_COMMANDS.has(b), b);
  }
});

test("resolvePluginEntry: resolves ./opendweb-plugin from project context (pnpm/npm layouts)", async () => {
  const dir = await projectWith("opendweb-echo");
  const entry = resolvePluginEntry("opendweb-echo", dir);
  assert.ok(entry?.endsWith("plugin.js"), entry ?? "null");
  assert.equal(resolvePluginEntry("opendweb-ext-not-installed", dir), null);
});

test("resolvePluginEntry: same-process miss followed by install falls back to package metadata", async () => {
  const dir = await projectWith();
  const pkg = "@jixo/opendweb-ext-echo";
  // 首次 req.resolve 缺失后，包管理器在同一进程创建 node_modules；这里
  // 覆盖 Node 目录负缓存仍存在时的 package.json 直读回退。
  assert.equal(resolvePluginEntry(pkg, dir), null);
  const installed = path.join(dir, "node_modules", "@jixo", "opendweb-ext-echo");
  await fsp.mkdir(path.dirname(installed), { recursive: true });
  await fsp.cp(path.join(FIXTURES, "@jixo", "opendweb-ext-echo"), installed, { recursive: true });

  const entry = resolvePluginEntry(pkg, dir);
  assert.ok(entry?.endsWith("plugin.js"), entry ?? "null");
  const resolved = await resolveAdaptive({ name: "echo", globs: DEFAULT_GLOBS, cwd: dir });
  assert.equal(resolved.pkg, pkg);
});

test("resolvePluginEntry: CLI face never falls back to the package root export (R5-B1)", async () => {
  const dir = await projectWith();
  // 仅导出 "."（根导出恰好是合规清单）：CLI 面只认 ./opendweb-plugin，
  // 不得让未声明 CLI 面的包进入自适应派发（冻结 spec）
  const pkgDir = path.join(dir, "node_modules", "opendweb-rootface");
  await fsp.mkdir(pkgDir, { recursive: true });
  await fsp.writeFile(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: "opendweb-rootface", version: "1.0.0", type: "module", exports: { ".": "./plugin.js" } }),
  );
  await fsp.writeFile(
    path.join(pkgDir, "plugin.js"),
    'export default { name: "rootface", apiVersion: 1, commands: [{ name: "hello", description: "d", args: { type: "object", properties: {}, required: [] } }], run: async () => ({ exit: 0 }) };',
  );
  assert.equal(resolvePluginEntry("opendweb-rootface", dir), null);
  await assert.rejects(
    () => resolveAdaptive({ name: "rootface", globs: DEFAULT_GLOBS, cwd: dir }),
    (e) => e instanceof PluginNotResolved,
  );
});

test("resolvePluginEntry: opendweb-plugin symlink escaping the package is rejected (R5-B2)", async () => {
  const dir = await projectWith();
  const pkgDir = path.join(dir, "node_modules", "opendweb-escape");
  await fsp.mkdir(pkgDir, { recursive: true });
  await fsp.writeFile(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: "opendweb-escape", version: "1.0.0", type: "module", exports: { "./opendweb-plugin": "./link.mjs" } }),
  );
  // 包外目标（项目根下）：若被错误接受并导入，清单 name="evil" 会触发
  // manifest 名不匹配硬错误——用它区分「拒绝解析」与「错误接受」
  await fsp.writeFile(
    path.join(dir, "outside.mjs"),
    'export default { name: "evil", apiVersion: 1, commands: [], run: async () => ({ exit: 0 }) };',
  );
  await fsp.symlink(path.join(dir, "outside.mjs"), path.join(pkgDir, "link.mjs"));
  assert.equal(resolvePluginEntry("opendweb-escape", dir), null);
  // 不得 import 包外文件：PluginNotResolved（而非 manifest 硬错误）证明
  // 越界入口从未被加载
  await assert.rejects(
    () => resolveAdaptive({ name: "escape", globs: DEFAULT_GLOBS, cwd: dir }),
    (e) => e instanceof PluginNotResolved,
  );
});

test("resolvePluginEntry: symlink to an outside dir claiming the same package name is rejected (R6-B2)", async () => {
  const dir = await projectWith();
  const pkgDir = path.join(dir, "node_modules", "opendweb-samename");
  await fsp.mkdir(pkgDir, { recursive: true });
  await fsp.writeFile(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: "opendweb-samename", version: "1.0.0", type: "module", exports: { "./opendweb-plugin": "./link.mjs" } }),
  );
  // 包外伪装目录声明了与请求包相同的 name——「入口祖先同名 metadata 推断」
  // 会被它骗过；期望包根（node_modules/<pkg> 的真实身份）不含包外路径
  const fakeDir = path.join(dir, "outside-same-name");
  await fsp.mkdir(fakeDir, { recursive: true });
  await fsp.writeFile(path.join(fakeDir, "package.json"), JSON.stringify({ name: "opendweb-samename", version: "9.9.9" }));
  await fsp.writeFile(
    path.join(fakeDir, "plugin.mjs"),
    'export default { name: "samename", apiVersion: 1, commands: [], run: async () => ({ exit: 0 }) };',
  );
  await fsp.symlink(path.join(fakeDir, "plugin.mjs"), path.join(pkgDir, "link.mjs"));
  assert.equal(resolvePluginEntry("opendweb-samename", dir), null);
  await assert.rejects(
    () => resolveAdaptive({ name: "samename", globs: DEFAULT_GLOBS, cwd: dir }),
    (e) => e instanceof PluginNotResolved,
  );
});

test("resolvePluginEntry: directory-name match with a mismatched package identity is rejected (R6-B2)", async () => {
  const dir = await projectWith();
  // 目录名正确但 package.json 声明的是别的包——期望包根的身份校验必须拒绝
  // （否则错名包的入口会被当作请求包解析/导入）
  const pkgDir = path.join(dir, "node_modules", "opendweb-wrongname");
  await fsp.mkdir(pkgDir, { recursive: true });
  await fsp.writeFile(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: "evil-other-package", version: "1.0.0", type: "module", exports: { "./opendweb-plugin": "./plugin.mjs" } }),
  );
  await fsp.writeFile(
    path.join(pkgDir, "plugin.mjs"),
    'export default { name: "wrongname", apiVersion: 1, commands: [], run: async () => ({ exit: 0 }) };',
  );
  assert.equal(resolvePluginEntry("opendweb-wrongname", dir), null);
  await assert.rejects(
    () => resolveAdaptive({ name: "wrongname", globs: DEFAULT_GLOBS, cwd: dir }),
    (e) => e instanceof PluginNotResolved,
  );
});

// 复审 6.1：嵌套依赖树里，近层错身份目录（目录名 = 请求包、package.json 声明
// 别的身份）会遮蔽外层已验证的合法副本——Node 解析不校验身份，会解析到遮蔽
// 目录；resolver 必须受控转向已验证的外层 expectedRoot 走 fs 解析（注释承诺
// 「继续向上找外层副本」），而不是把候选判为未安装。语义边界：这与包内入口
// symlink 逃逸（R5-B2，硬拒）不同——Node 选中 nearer!==verified 的目录时，
// 越界落点是遮蔽所致而非包不可信。
test("resolvePluginEntry: near wrong-identity dir shadowing an outer verified copy redirects to the outer root (复审 6.1)", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "opendweb-nested-"));
  // 外层：已验证合法副本（fixture，manifest name === "echo"）
  await fsp.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "outer", private: true }), "utf8");
  await fsp.cp(path.join(FIXTURES, "opendweb-echo"), path.join(root, "node_modules", "opendweb-echo"), { recursive: true });
  // 嵌套内层：同名目录、错身份（name: "evil-shadow"）、入口可被 Node 解析
  const nested = path.join(root, "work", "deep");
  const shadowDir = path.join(nested, "node_modules", "opendweb-echo");
  await fsp.mkdir(shadowDir, { recursive: true });
  await fsp.writeFile(path.join(nested, "package.json"), JSON.stringify({ name: "deep", private: true }), "utf8");
  await fsp.writeFile(
    path.join(shadowDir, "package.json"),
    JSON.stringify({ name: "evil-shadow", version: "9.9.9", type: "module", exports: { "./opendweb-plugin": "./plugin.js" } }),
  );
  await fsp.writeFile(
    path.join(shadowDir, "plugin.js"),
    'export default { name: "shadow", apiVersion: 1, commands: [], run: async () => ({ exit: 1 }) };',
  );

  // 解析必须落在外层已验证副本（而非 null、而非遮蔽目录的入口）
  const entry = resolvePluginEntry("opendweb-echo", nested);
  const outerEntry = await fsp.realpath(path.join(root, "node_modules", "opendweb-echo", "plugin.js"));
  assert.equal(entry, outerEntry);
  // 端到端：自适应解析加载的是外层副本（manifest name "echo"）；遮蔽目录的
  // 清单 name "shadow" 若被加载会触发 name 硬错误
  const resolved = await resolveAdaptive({ name: "echo", globs: DEFAULT_GLOBS, cwd: nested });
  assert.equal(resolved.pkg, "opendweb-echo");
  assert.equal(resolved.manifest.name, "echo");

  // 边界：外层副本不存在时（只剩近层错身份遮蔽），身份语义不变 = 未安装
  await fsp.rm(path.join(root, "node_modules", "opendweb-echo"), { recursive: true, force: true });
  assert.equal(resolvePluginEntry("opendweb-echo", nested), null);
  await assert.rejects(
    () => resolveAdaptive({ name: "echo", globs: DEFAULT_GLOBS, cwd: nested }),
    (e) => e instanceof PluginNotResolved,
  );
});

test("resolveAdaptive: declaration order wins; unresolvable candidates are skipped", async () => {
  const dir = await projectWith("opendweb-echo");
  // 默认序：@jixo/opendweb-echo（未安装）→ opendweb-echo（已安装）
  const r = await resolveAdaptive({ name: "echo", globs: DEFAULT_GLOBS, cwd: dir });
  assert.equal(r.pkg, "opendweb-echo");
  assert.equal(r.manifest.name, "echo");
  assert.equal(r.manifest.apiVersion, 1);
});

test("resolveAdaptive: installed-but-invalid manifest is a HARD error (no silent skip)", async () => {
  const dir = await projectWith("opendweb-bad");
  await assert.rejects(
    () => resolveAdaptive({ name: "bad", globs: DEFAULT_GLOBS, cwd: dir }),
    (e) => {
      assert.match(e.message, /invalid opendweb-plugin manifest/);
      assert.match(e.message, /apiVersion/);
      return true;
    },
  );
});

test("resolveAdaptive: nothing resolvable -> error prints plugin add guidance", async () => {
  const dir = await projectWith();
  await assert.rejects(
    () => resolveAdaptive({ name: "frp", globs: DEFAULT_GLOBS, cwd: dir }),
    /opendweb plugin add frp/,
  );
});

test("parseCommandArgs: flags, inline values, booleans, numbers, positionals, required", () => {
  const spec = {
    name: "hello",
    description: "",
    args: {
      type: "object",
      properties: { name: { type: "string" }, loud: { type: "boolean" }, times: { type: "number" } },
      required: ["name"],
    },
  };
  assert.deepEqual(
    parseCommandArgs(spec, ["--name", "ada", "--loud", "--times=3"]),
    { name: "ada", loud: true, times: 3 },
  );
  assert.deepEqual(parseCommandArgs(spec, ["ada"]), { name: "ada" });
  assert.throws(() => parseCommandArgs(spec, []), /missing required option --name/);
  assert.throws(() => parseCommandArgs(spec, ["--name", "a", "--nope"]), /unknown option --nope/);
  assert.throws(() => parseCommandArgs(spec, ["--name", "a", "--times", "x"]), /expects a number/);
  assert.throws(() => parseCommandArgs(spec, ["--name", "a", "extra"]), /unexpected positional/);
});

test("dispatchPluginCommand: wrapper normalizes output (ASCII), errors, exit codes", async () => {
  const dir = await projectWith("opendweb-echo");
  const { manifest } = await resolveAdaptive({ name: "echo", globs: DEFAULT_GLOBS, cwd: dir });

  let out = "";
  const stdout = { write: (s) => (out += s) };
  let err = "";
  const stderr = { write: (s) => (err += s) };

  const code = await dispatchPluginCommand({
    manifest, command: "hello", argv: ["--name", "ada", "--loud", "--times", "2"],
    cwd: dir, stdout, stderr,
  });
  assert.equal(code, 0);
  assert.equal(out, "hello ada!\nhello ada!\n");

  const failCode = await dispatchPluginCommand({
    manifest, command: "fail", argv: [], cwd: dir, stdout, stderr,
  });
  assert.equal(failCode, 1);
  assert.match(err, /error\[plugin\/echo\]: boom from echo plugin/);

  const unknown = await dispatchPluginCommand({
    manifest, command: "nope", argv: [], cwd: dir, stdout, stderr,
  });
  assert.equal(unknown, 2);
});

test("renderPluginHelp: zero-execution help from manifest declarations", async () => {
  const dir = await projectWith("opendweb-echo");
  const { manifest } = await resolveAdaptive({ name: "echo", globs: DEFAULT_GLOBS, cwd: dir });
  let executed = false;
  const wrapped = { ...manifest, run: () => { executed = true; } };
  const text = renderPluginHelp({ name: "echo", manifest: wrapped });
  assert.ok(text.includes("opendweb echo hello --name <string> [--loud --times <number>]"));
  assert.ok(text.includes("greet by name"));
  assert.ok([...text].every((c) => c.charCodeAt(0) < 128), "help must be ASCII");
  assert.equal(executed, false, "help must not execute run");
});

test("PluginManifestSchema.safeParse catches missing commands / bad name shape", () => {
  assert.equal(PluginManifestSchema.safeParse({ name: "x", apiVersion: 1, commands: [], run: () => {} }).success, false);
  assert.equal(PluginManifestSchema.safeParse({ name: "Bad_Name", apiVersion: 1, commands: [{ name: "c" }], run: () => {} }).success, false);
});

// 单命令折叠派发（webui-console）：单命令 manifest 的非命令首 token（flag
// 或空 argv）折叠派发唯一命令；多命令 manifest 与显式命令 token 零变化。
// --help 零执行由调用方在派发前判定（wantsPluginHelp），不受折叠影响。
test("foldSingleCommand: single-command manifest folds non-command token; multi and explicit forms unchanged", () => {
  const solo = {
    name: "solo",
    apiVersion: 1,
    commands: [{ name: "solo", description: "", args: { type: "object", properties: {}, required: [] } }],
    run: async () => ({ exit: 0 }),
  };
  // 单命令 + flag 首 token：折叠为唯一命令，argv 原样作为命令参数
  assert.deepEqual(
    foldSingleCommand({ manifest: solo, rest: ["--server", "X"] }),
    { command: "solo", argv: ["--server", "X"] },
  );
  // 单命令 + 空 argv：同样折叠（直达唯一命令）
  assert.deepEqual(foldSingleCommand({ manifest: solo, rest: [] }), { command: "solo", argv: [] });
  // 单命令 + 显式命令 token：既有拆分语义（token 之后为 argv）
  assert.deepEqual(
    foldSingleCommand({ manifest: solo, rest: ["solo", "--server", "X"] }),
    { command: "solo", argv: ["--server", "X"] },
  );

  const multi = {
    name: "echo",
    apiVersion: 1,
    commands: [
      { name: "hello", description: "", args: { type: "object", properties: {}, required: [] } },
      { name: "fail", description: "", args: { type: "object", properties: {}, required: [] } },
    ],
    run: async () => ({ exit: 0 }),
  };
  // 多命令 + 非 command 首 token：不折叠——原样返回，交由 dispatchPluginCommand
  // 走「no command」错误路径报可用命令
  assert.deepEqual(
    foldSingleCommand({ manifest: multi, rest: ["--loud"] }),
    { command: "--loud", argv: [] },
  );
  // 多命令 + 空 argv：command undefined → help 渲染（既有行为）
  assert.deepEqual(foldSingleCommand({ manifest: multi, rest: [] }), { command: undefined, argv: [] });
  // 多命令 + 显式命令 token：既有拆分语义
  assert.deepEqual(
    foldSingleCommand({ manifest: multi, rest: ["hello", "--name", "ada"] }),
    { command: "hello", argv: ["--name", "ada"] },
  );
});

// 2026-08-30 alias 体系：plugins.json 的 alias -> package 记录是信任锚——
// 自定义 alias（manifest.name != alias）必须经 lockResolved 解析成功，
// 且该信任路径不得放宽 glob 寻址路径的 name 一致性校验。
test("resolveAdaptive: a locked alias resolves its package without the manifest-name match; glob path keeps it strict", async () => {
  const fakeEntry = "/nowhere/pkg/entry.mjs";
  const manifest = {
    default: {
      name: "cf",
      apiVersion: 1,
      commands: [{ name: "setup", description: "d", args: { type: "object", properties: {}, required: [] } }],
      run: async () => ({ exit: 0 }),
    },
  };
  const imported = async () => manifest;
  // lock 信任路径：manifest.name("cf") != 调用名("mycf") 仍解析成功
  const viaLock = await resolveAdaptive({
    name: "mycf",
    globs: ["npm:@jixo/opendweb-ext-*"],
    cwd: "/proj",
    lockResolved: "@jixo/opendweb-ext-cf",
    importModule: imported,
    resolveEntry: (pkg) => (pkg === "@jixo/opendweb-ext-cf" ? fakeEntry : null),
  });
  assert.equal(viaLock.pkg, "@jixo/opendweb-ext-cf");
  // glob 寻址路径：manifest.name 与调用名不一致仍是硬错误（防名字劫持）
  await assert.rejects(
    resolveAdaptive({
      name: "mycf",
      globs: ["npm:@jixo/opendweb-ext-*"],
      cwd: "/proj",
      importModule: imported,
      resolveEntry: () => fakeEntry,
    }),
    /declares name "cf" but was invoked as "mycf"/,
  );
});

// ---- 工作区本地解析回退（dev 模式——pnpm dev webui 仓内直跑） -----------------------

/** 造一个 pnpm workspace：<root>/pnpm-workspace.yaml + packages/<dir> 成员 */
async function workspaceWith(members) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "opendweb-ws-"));
  await fsp.writeFile(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n", "utf8");
  await fsp.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "ws-root", private: true }), "utf8");
  for (const [dir, fixture] of members) {
    await fsp.cp(path.join(FIXTURES, fixture), path.join(root, "packages", dir), { recursive: true });
  }
  return root;
}

test("workspace fallback: repo 内（node_modules 链无副本）按成员包名解析本地包", async () => {
  const ws = realpathSync(await workspaceWith([["webui-pkg", "opendweb-echo"]]));
  try {
    // 嵌套子目录（模拟 pnpm dev 从根脚本进入任意 cwd）也要命中
    const nested = path.join(ws, "apps", "site");
    await fsp.mkdir(nested, { recursive: true });
    const entry = resolvePluginEntry("opendweb-echo", nested);
    assert.ok(entry !== null, "workspace 成员应被解析");
    assert.ok(entry.startsWith(path.join(ws, "packages", "webui-pkg")), `入口应落在 workspace 成员内: ${entry}`);
    assert.ok(entry.endsWith("plugin.js"));
  } finally {
    await fsp.rm(ws, { recursive: true, force: true });
  }
});

test("workspace fallback: 已安装副本优先于 workspace 源（用户项目语义不变）", async () => {
  const ws = realpathSync(await workspaceWith([["webui-pkg", "opendweb-echo"]]));
  try {
    const proj = await projectWith("opendweb-echo");
    // workspace 内的独立项目目录（apps/proj）带身份相符 node_modules 副本——
    // 副本胜出（链上命中先于 workspace 回退；副本不在同名成员内部——那种
    // 嵌套会触发 Node self-reference，属另一语义面）
    const nested = path.join(ws, "apps", "proj");
    await fsp.mkdir(nested, { recursive: true });
    await fsp.cp(path.join(proj, "node_modules"), path.join(nested, "node_modules"), { recursive: true });
    const entry = resolvePluginEntry("opendweb-echo", nested);
    assert.ok(entry !== null && entry.startsWith(path.join(nested, "node_modules", "opendweb-echo")), "node_modules 副本优先");
    await fsp.rm(proj, { recursive: true, force: true });
  } finally {
    await fsp.rm(ws, { recursive: true, force: true });
  }
});

test("workspace fallback: 成员无同名包时保持未安装语义（返回 null）", async () => {
  const ws = realpathSync(await workspaceWith([["other-pkg", "opendweb-echo"]]));
  try {
    // 身份匹配按 package.json name——改掉成员名后无匹配（目录名无关）
    const meta = JSON.parse(await fsp.readFile(path.join(ws, "packages", "other-pkg", "package.json"), "utf8"));
    meta.name = "opendweb-other";
    await fsp.writeFile(path.join(ws, "packages", "other-pkg", "package.json"), JSON.stringify(meta, null, 2));
    assert.equal(resolvePluginEntry("opendweb-echo", ws), null, "无匹配成员=未安装（自愈链不变）");
  } finally {
    await fsp.rm(ws, { recursive: true, force: true });
  }
});
