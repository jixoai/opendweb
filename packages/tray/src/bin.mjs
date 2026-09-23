#!/usr/bin/env node
// bin 直跑薄壳（opendweb-tray）：argv 解析 → runTray；退出码映射。
// 信号面/停机归控制器；本文件只承担进程入口（与 webui cli.mjs 的
// isDirect 形态同款——plugin envelope 是另一入口，见 plugin.mjs）。

import path from "node:path";
import { pathToFileURL } from "node:url";

import { runTray, parseTrayArgv } from "./controller.mjs";

/**
 * @param {string} s
 * @returns {string}
 */
function ascii(s) {
  let out = "";
  for (const b of Buffer.from(String(s), "utf8")) {
    out += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : `\\x${b.toString(16).padStart(2, "0")}`;
  }
  return out;
}

const isDirect =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirect) {
  let parsed;
  try {
    parsed = parseTrayArgv(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`error: tray: ${ascii(String(e?.message ?? e))}\n`);
    process.exit(2);
  }
  runTray(parsed).then(
    (r) => {
      process.exitCode = r.exit;
    },
    (e) => {
      process.stderr.write(`error: tray: ${ascii(String(e?.message ?? e))}\n`);
      process.exitCode = 1;
    },
  );
}
