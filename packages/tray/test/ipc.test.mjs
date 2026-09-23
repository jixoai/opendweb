// --ipc 控制面测试（home-hub Phase 3a / specs tray-plugin「控制面」golden 帧冻结）：
// 1. 编解码单元：okResultFrame/errorFrame 逐字节 golden；scanFrameId 受限前缀
//    扫描矩阵；handleFrame 分支（notification/batch/坏 JSON/超长 id 恢复/
//    64KB+1 边界）；
// 2. 子进程 e2e（bin --ipc，隔离 DWEB_HOME）：spec golden 样例逐帧比对——
//    open-console（带/不带 deepLink）+ opened 通知、set-autostart 业务 error
//    （hub 子进程真实形态：真实 opendweb bin、未 init home）、notification 与
//    batch 各 -32600、超长 -32601（id 透传/null 两形态）、坏 JSON -32700、
//    拒绝后连接继续、每帧过严格 JSON-RPC 2.0 validator、stdin EOF 优雅退出。
import test from "node:test";
import assert from "node:assert/strict";

import {
  scanFrameId,
  okResultFrame,
  errorFrame,
  handleFrame,
  createIpcSession,
  IPC_FRAME_LIMIT_BYTES,
  RpcError,
} from "../src/ipc.mjs";
import { makeHubHome, spawnTray, lineReader, collect } from "./helpers.mjs";

const okDispatch = async () => ({ ok: true });

/** 严格 JSON-RPC 2.0 validator：所有帧（响应与 server 通知）逐帧校验 */
function validateFrame(line) {
  let msg;
  assert.doesNotThrow(() => {
    msg = JSON.parse(line);
  }, `frame is valid JSON: ${line}`);
  assert.equal(typeof msg, "object", `frame is an object: ${line}`);
  assert.equal(msg.jsonrpc, "2.0", `every frame carries "jsonrpc":"2.0": ${line}`);
  if (msg.method !== undefined) {
    // server 通知：无 id
    assert.equal("id" in msg, false, `notification has no id: ${line}`);
    return msg;
  }
  assert.ok("id" in msg, `response carries id: ${line}`);
  if ("error" in msg) {
    assert.equal(typeof msg.error.code, "number");
    assert.equal(typeof msg.error.message, "string");
    assert.equal("result" in msg, false, `error and result are exclusive: ${line}`);
  } else {
    assert.ok("result" in msg);
  }
  return msg;
}

/** 构造恰好 totalBytes 字节的有效请求帧（ASCII padding 进 params 冗余键） */
function frameOfExactBytes(totalBytes, { id = 8, deepLink = "#/lease" } = {}) {
  const head = `{"jsonrpc":"2.0","id":${JSON.stringify(id)},"method":"open-console","params":{"deepLink":${JSON.stringify(deepLink)},"pad":"`;
  const tail = `"}}`;
  const padLen = totalBytes - Buffer.byteLength(head) - Buffer.byteLength(tail);
  assert.ok(padLen >= 0, "exact-byte frame is constructible");
  return head + "a".repeat(padLen) + tail;
}

// ---- 编解码单元 ----------------------------------------------------------------

test("codec: golden frame bytes are frozen", () => {
  assert.equal(okResultFrame(1), '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}');
  assert.equal(
    errorFrame(null, -32700, "parse error"),
    '{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"parse error"}}',
  );
  assert.equal(
    errorFrame(2, -32000, "hub not initialized"),
    '{"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"hub not initialized"}}',
  );
  assert.equal(
    errorFrame(null, -32600, "notifications not supported"),
    '{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"notifications not supported"}}',
  );
  assert.equal(
    errorFrame(null, -32600, "batch not supported"),
    '{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"batch not supported"}}',
  );
  assert.equal(
    errorFrame(5, -32601, "frame too large"),
    '{"jsonrpc":"2.0","id":5,"error":{"code":-32601,"message":"frame too large"}}',
  );
});

test("codec: scanFrameId restricted prefix scan (numbers/strings/bools/null/absent)", () => {
  assert.equal(scanFrameId('{"jsonrpc":"2.0","id":42,"method":"stop"}'), 42);
  assert.equal(scanFrameId('{"jsonrpc":"2.0","id":"abc","method":"stop"}'), "abc");
  assert.equal(scanFrameId('{"jsonrpc":"2.0","id":true,"method":"stop"}'), true);
  assert.equal(scanFrameId('{"jsonrpc":"2.0","id":null,"method":"stop"}'), null);
  assert.equal(scanFrameId('{"jsonrpc":"2.0","method":"stop"}'), undefined);
  assert.equal(scanFrameId('{"jsonrpc":"2.0","id": 7,'), 7, "parses truncated prefixes too");
  assert.equal(scanFrameId('not json at all'), undefined);
  // 相邻键不误命中（"my_id" 里没有独立的 "id" 键形）
  assert.equal(scanFrameId('{"my_id":9,"x":1}'), undefined);
  // 字符串值内的转义引号不截断扫描
  assert.equal(scanFrameId(`{"id":"a\\"b","x":1}`), 'a"b');
});

test("codec: handleFrame branches (notification/batch/bad json/oversized id recovery)", async () => {
  // notification（无 id）→ -32600 id null
  assert.equal(
    (await handleFrame('{"jsonrpc":"2.0","method":"open-console"}', {}, okDispatch))[0],
    '{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"notifications not supported"}}',
  );
  // batch → 整帧拒绝 id null
  assert.equal(
    (await handleFrame('[{"jsonrpc":"2.0","id":9,"method":"stop"}]', {}, okDispatch))[0],
    '{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"batch not supported"}}',
  );
  // 坏 JSON → -32700，id 前缀可解析则恢复
  assert.equal(
    (await handleFrame('{"jsonrpc":"2.0","id":7,', {}, okDispatch))[0],
    '{"jsonrpc":"2.0","id":7,"error":{"code":-32700,"message":"parse error"}}',
  );
  assert.equal(
    (await handleFrame("{oops", {}, okDispatch))[0],
    '{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"parse error"}}',
  );
  // 超长（64KB+1）→ -32601，id 前缀透传
  const oversized = frameOfExactBytes(IPC_FRAME_LIMIT_BYTES + 1, { id: 5 });
  assert.ok(Buffer.byteLength(oversized) === IPC_FRAME_LIMIT_BYTES + 1);
  assert.equal(
    (await handleFrame(oversized, {}, okDispatch))[0],
    '{"jsonrpc":"2.0","id":5,"error":{"code":-32601,"message":"frame too large"}}',
  );
  // 边界：恰好 64KB 的有效帧不被拒（成功响应）
  const boundary = frameOfExactBytes(IPC_FRAME_LIMIT_BYTES, { id: 8 });
  assert.ok(Buffer.byteLength(boundary) === IPC_FRAME_LIMIT_BYTES);
  assert.equal(
    (await handleFrame(boundary, {}, okDispatch))[0],
    '{"jsonrpc":"2.0","id":8,"result":{"ok":true}}',
  );
  // RpcError → 业务 error 帧；未知错误 → internal error
  assert.equal(
    (await handleFrame('{"jsonrpc":"2.0","id":3,"method":"x"}', {}, async () => {
      throw new RpcError(-32000, "hub not initialized");
    }))[0],
    '{"jsonrpc":"2.0","id":3,"error":{"code":-32000,"message":"hub not initialized"}}',
  );
  assert.equal(
    (await handleFrame('{"jsonrpc":"2.0","id":3,"method":"x"}', {}, async () => {
      throw new Error("boom");
    }))[0],
    '{"jsonrpc":"2.0","id":3,"error":{"code":-32603,"message":"internal error"}}',
  );
});

test("codec: createIpcSession EOF resolves and oversized no-newline flood stays bounded", async () => {
  const { PassThrough } = await import("node:stream");
  const input = new PassThrough();
  const output = new PassThrough();
  const session = createIpcSession({ input, output, dispatch: okDispatch });
  // 无换行超限流：只保留前缀窗口，换行后以 -32601 拒绝且 id 可从前缀恢复
  input.write('{"jsonrpc":"2.0","id":11,"method":"open-console","params":{"pad":"' + "z".repeat(IPC_FRAME_LIMIT_BYTES + 4096));
  input.write("\n");
  await new Promise((r) => setTimeout(r, 50));
  // 后续正常帧继续被服务（连接不断）
  input.write('{"jsonrpc":"2.0","id":12,"method":"open-console"}\n');
  await new Promise((r) => setTimeout(r, 50));
  input.end();
  await session.finished;
  const lines = output.read()?.toString("utf8").split("\n").filter(Boolean) ?? [];
  assert.equal(lines.length, 2, `two responses: ${lines.join(" | ")}`);
  assert.equal(lines[0], '{"jsonrpc":"2.0","id":11,"error":{"code":-32601,"message":"frame too large"}}');
  assert.equal(lines[1], '{"jsonrpc":"2.0","id":12,"result":{"ok":true}}');
});

// ---- 子进程 e2e：golden 帧序列 ---------------------------------------------------

test("ipc e2e: spec golden frame sequence against the real bin (uninitialized hub)", async () => {
  const { home } = await makeHubHome({ configured: false });
  const child = spawnTray(["--ipc"], { home });
  const errCollect = collect(child);
  const reader = lineReader(child.stdout);
  const send = (line) => child.stdin.write(`${line}\n`);
  try {
    // ① open-console 带 deepLink（spec 样例逐字节）→ golden 结果帧
    send('{"jsonrpc":"2.0","id":1,"method":"open-console","params":{"deepLink":"#/lease"}}');
    assert.equal(
      await reader.next(),
      '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}',
      "golden: open-console result frame (byte-exact)",
    );
    const opened = validateFrame(await reader.next());
    assert.equal(opened.method, "opened");
    assert.match(String(opened.params.url), /dweb_console=/, "opened carries the session capability URL");
    assert.match(String(opened.params.url), /#\/lease$/, "opened carries the deep link");

    // ② set-autostart（hub 子进程真实形态：真实 opendweb bin + 未 init home）
    send('{"jsonrpc":"2.0","id":2,"method":"set-autostart","params":{"on":true}}');
    assert.equal(
      await reader.next(),
      '{"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"hub not initialized"}}',
      "golden: business error mapped from the real hub CLI failure",
    );

    // ③ notification（无 id）→ -32600
    send('{"jsonrpc":"2.0","method":"open-console"}');
    assert.equal(
      await reader.next(),
      '{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"notifications not supported"}}',
    );

    // ④ batch 数组 → 整帧拒绝
    send('[{"jsonrpc":"2.0","id":9,"method":"stop"}]');
    assert.equal(
      await reader.next(),
      '{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"batch not supported"}}',
    );

    // ⑤ 超长帧（64KB+1）id 前缀透传 → -32601 不断流
    send(frameOfExactBytes(IPC_FRAME_LIMIT_BYTES + 1, { id: 5 }));
    assert.equal(
      await reader.next(),
      '{"jsonrpc":"2.0","id":5,"error":{"code":-32601,"message":"frame too large"}}',
    );
    // 超长帧无 id → id null
    send("[" + " ".repeat(IPC_FRAME_LIMIT_BYTES + 1) + "]");
    assert.equal(
      await reader.next(),
      '{"jsonrpc":"2.0","id":null,"error":{"code":-32601,"message":"frame too large"}}',
    );

    // ⑥ 坏 JSON（id 前缀可恢复）→ -32700；连接继续
    send('{"jsonrpc":"2.0","id":7,');
    assert.equal(
      await reader.next(),
      '{"jsonrpc":"2.0","id":7,"error":{"code":-32700,"message":"parse error"}}',
    );

    // ⑦ 拒绝后的正常请求仍成功（spec：随后正常请求 + EOF 退出）
    send('{"jsonrpc":"2.0","id":3,"method":"open-console"}');
    assert.equal(await reader.next(), '{"jsonrpc":"2.0","id":3,"result":{"ok":true}}');
    const opened2 = validateFrame(await reader.next());
    assert.equal(opened2.method, "opened");

    // ⑧ stdin EOF → 优雅退出（exit 0）
    child.stdin.end();
    const r = await errCollect;
    assert.equal(r.code, 0, `graceful EOF exit (stderr: ${r.err.slice(0, 400)})`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
});

test("ipc e2e: every line the bin emits passes the strict JSON-RPC 2.0 validator", async () => {
  const { home } = await makeHubHome({ configured: false });
  const child = spawnTray(["--ipc"], { home });
  const reader = lineReader(child.stdout);
  const send = (line) => child.stdin.write(`${line}\n`);
  const seen = [];
  try {
    for (const frame of [
      '{"jsonrpc":"2.0","id":1,"method":"open-console"}',
      '{"jsonrpc":"2.0","id":2,"method":"set-autostart","params":{"on":false}}',
      '{"jsonrpc":"2.0","method":"start"}',
      "[]",
      '{"bad":',
      '{"jsonrpc":"2.0","id":3,"method":"no-such-method"}',
      '{"jsonrpc":"2.0","id":4,"method":"set-autostart","params":{}}',
      '{"jsonrpc":"2.0","id":5,"method":"open-console","params":{"deepLink":"not-a-link"}}',
    ]) {
      send(frame);
      seen.push(validateFrame(await reader.next()));
      // open-console 成功后的 opened 通知也消费并校验
      if (seen.at(-1).result !== undefined && frame.includes("open-console") && !frame.includes("not-a-link")) {
        seen.push(validateFrame(await reader.next()));
      }
    }
    child.stdin.end();
    const done = await collect(child);
    assert.equal(done.code, 0, `graceful EOF exit (stderr: ${done.err.slice(0, 400)})`);
    assert.ok(!done.err.includes("tok_"), "stderr never carries credentials");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  // 语义抽查：unknown method / 缺 on / 坏 deepLink 的错误码
  const codes = seen.filter((f) => f.error !== undefined).map((f) => f.error.code);
  assert.ok(codes.includes(-32000), "set-autostart on uninitialized hub is a business error");
  assert.ok(codes.includes(-32600), "notification rejected");
  assert.ok(codes.includes(-32700), "bad json rejected");
  assert.ok(codes.includes(-32601), "unknown method rejected");
  assert.ok(codes.includes(-32602), "missing `on` is invalid params");
  const badDeepLink = seen.find((f) => f.error?.code === -32602 && f.id === 5);
  assert.ok(badDeepLink, "bad deepLink is invalid params");
});
