// B6 回归钉（app-protocol-layer 4.4 迁移实证缺陷）：server.close 后晚到
// handler 结算（resolveRequest/rejectRequest unknown id）必须幂等静默
// （§3.4 late completion 只丢弃），不得抛错/unhandledRejection。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import pkg from "../index.js";
const { Fabric } = pkg;

test("serveHttp: late settlements after close are silent (B6)", async () => {
  const dir = fs.mkdtempSync(os.tmpdir() + "/dweb-js-late-");
  const fabric = await Fabric.createRoot({
    dataDir: dir,
    relay: { mode: "disabled" },
  });
  const server = await fabric.serveHttp("peer-does-not-exist", () => ({
    status: 200,
  }));
  await server.close();
  // 晚到结算（unknown request id）——不得抛
  server.resolveRequest(99999, 200, [], []);
  server.rejectRequest(99998, "late");
  // 幂等重复结算同样静默
  server.resolveRequest(99999, 200, [], []);
  assert.ok(true, "late settlements silent");
  fs.rmSync(dir, { recursive: true, force: true });
});
