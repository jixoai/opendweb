// 测试共享件：注入式 handler 请求伪造器 + 临时 fixture 家族（node --test）。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 伪造 HttpHandlerRequest（直调 handler；形状对齐 client-sdk HttpHandlerRequest）。
 * @param {{
 *   sessionId?: string,
 *   method?: string,
 *   path?: string,
 *   body?: Array<Uint8Array | Buffer | string>,
 *   writeGate?: Promise<void>,
 * }} [opts]
 *   writeGate：respondStreaming 的 write 阻塞在它上面（并发预算 429 测试用）
 */
export function fakeRequest(opts = {}) {
  const sessionId = opts.sessionId ?? "sess-test";
  const method = opts.method ?? "GET";
  const url = opts.path ?? "/";
  const queue = (opts.body ?? []).map((c) => (typeof c === "string" ? Buffer.from(c) : Buffer.from(c)));
  let done = false;
  const abort = new AbortController();
  /** @type {Buffer[]} */
  const streamed = [];
  let streamStatus = null;
  /** @type {Array<{ name: string, value: string }>} */
  let streamHeaders = [];
  let finishCount = 0;
  const request = {
    requestId: 1,
    streamId: 1,
    sessionId,
    signal: abort.signal,
    method,
    path: url,
    headers: [],
    bodyNext: async () => {
      if (queue.length > 0) return queue.shift();
      if (done) return null;
      done = true;
      return null;
    },
    respondStreaming: (status, headers) => {
      streamStatus = status;
      streamHeaders = headers ?? [];
      return {
        write: async (chunk) => {
          streamed.push(Buffer.from(chunk));
          if (opts.writeGate !== undefined) await opts.writeGate;
        },
        finish: () => {
          finishCount++;
        },
        finished: false,
        cancelled: false,
        closed: false,
      };
    },
  };
  return {
    request,
    abort,
    streamed,
    getStreamedBytes: () => Buffer.concat(streamed),
    getStreamStatus: () => streamStatus,
    getStreamHeaders: () => streamHeaders,
    getFinishCount: () => finishCount,
  };
}

/**
 * 临时 fixture home（含一个共享根目录）。
 * @param {{ withIgnore?: string }} [opts]
 * @returns {{ home: string, rootDir: string, cleanup: () => void }}
 */
export function tempFixture(opts = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "files-test-home-"));
  const rootDir = path.join(home, "share-root");
  fs.mkdirSync(path.join(rootDir, "docs", "nested"), { recursive: true });
  fs.writeFileSync(path.join(rootDir, "hello.txt"), "HELLO-FILES");
  fs.writeFileSync(path.join(rootDir, "docs", "note.md"), "# note\n");
  fs.writeFileSync(path.join(rootDir, "docs", "nested", "deep.txt"), "deep");
  if (opts.withIgnore !== undefined) {
    fs.writeFileSync(path.join(rootDir, ".opendweb-ignore"), opts.withIgnore);
  }
  return { home, rootDir, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

/**
 * 递归快照（路径 → {size, mode}；符号链接记 "link"）——诱饵目录监控用。
 * @param {string} dir
 * @returns {Record<string, string>}
 */
export function snapshotTree(dir) {
  /** @type {Record<string, string>} */
  const out = {};
  const walk = (p, rel) => {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) {
      out[rel] = "link";
      return;
    }
    if (st.isDirectory()) {
      out[rel] = "dir";
      for (const name of fs.readdirSync(p)) walk(path.join(p, name), rel === "" ? name : `${rel}/${name}`);
    } else {
      out[rel] = `file:${st.size}`;
    }
  };
  walk(dir, "");
  return out;
}

/** 便携 sleep */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
