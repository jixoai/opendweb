// 分层 transport 包络测试（webui-plugin-kernel r8-B4 最小清单第 3 项——files 面）。
// 共享替身：packages/webui/test/plugin-transport-double.mjs——真实建立 1MiB 帧
// （session.rs MAX_FRAME）/2MiB 流/8MiB 会话三层账；单机 loopback（内存
// transport）不再绕过真双机才会暴露的包络失败。覆盖：
// 1. 默认 1MiB chunk：1.5MiB 文件上传经守卫 transport 端到端成功（2 请求×
//    ≤1MiB，流/帧/会话三层账内）；
// 2. 必然失败配置防线：chunkMaxBytes/readMaxBytes >1MiB 在工厂期拒绝（不得到
//    「服务端放行、transport 必败」的错配组合）；
// 3. 越过客户端分片直发超包络 chunk（2MiB 单元素——旧 4MiB 默认形态）在
//    transport 层被帧层拦下：handler 零调用、staging 零残留；
// 4. 流层：多元素合计 >2MiB 的请求被流层拦下（帧各自 ≤1MiB 也无效）。

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import fsp from "node:fs/promises";
import { createFilesRuntime, MAX_TRANSFER_ENVELOPE_BYTES } from "../src/runtime.mjs";
import { createHandlerTransport, createWireFilesController, CLIENT_CHUNK_BYTES } from "../src/client.mjs";
import { tempFixture } from "./util.mjs";
import { wrapFilesTransport, TransportEnvelopeError } from "../../webui/test/plugin-transport-double.mjs";

const MIB = 1024 * 1024;

test("envelope: default 1MiB chunk uploads a 1.5MiB file end-to-end through the guarded transport (two requests within all three layers)", async (t) => {
  const fixture = tempFixture({});
  t.after(() => fixture.cleanup());
  const rt = await createFilesRuntime({ home: fixture.home, log: () => {}, resolvePeer: async () => "ep-a" });
  t.after(() => rt.onDispose());
  await rt.onEnable({ home: fixture.home, dataDir: `${fixture.home}/plugins/files` });
  const share = await rt.shares.add({ name: "docs", root: fixture.rootDir, mode: "rw", peers: ["ep-a"] });
  assert.equal(CLIENT_CHUNK_BYTES, MIB, "client default chunk is the 1MiB transport envelope");
  assert.equal(MAX_TRANSFER_ENVELOPE_BYTES, MIB, "runtime hard cap is the 1MiB transport envelope");

  const guarded = wrapFilesTransport(createHandlerTransport(rt.handler, { sessionId: "s1" }));
  const controller = createWireFilesController(guarded, { shareId: share.id });
  const payload = Buffer.alloc(MIB + MIB / 2, 0x46);
  crypto.createHash("sha256");
  const out = await controller.uploadFile("big.bin", new Uint8Array(payload));
  assert.equal(out.size, payload.length);
  const onDisk = await fsp.readFile(path.join(fixture.rootDir, "big.bin"));
  assert.equal(onDisk.length, payload.length);
  assert.equal(crypto.createHash("sha256").update(onDisk).digest("hex"), out.oid, "uploaded bytes land intact (single atomic rename after commit)");
  const staged = await fsp.readdir(path.join(fixture.home, "plugins/files/staging")).catch(() => []);
  assert.equal(staged.filter((d) => d !== "meta").length, 0, "staging fully reclaimed after commit");
});

test("envelope: chunkMaxBytes/readMaxBytes beyond 1MiB are rejected at factory time (never-fails-on-transport configs only)", async () => {
  const fixture = tempFixture({});
  await assert.rejects(
    () => createFilesRuntime({ home: fixture.home, log: () => {}, resolvePeer: async () => "ep-a", chunkMaxBytes: 4 * MIB }),
    (e) => /chunkMaxBytes.*exceeds the v1 transport envelope/.test(String(e.message)),
  );
  await assert.rejects(
    () => createFilesRuntime({ home: fixture.home, log: () => {}, resolvePeer: async () => "ep-a", readMaxBytes: 4 * MIB }),
    (e) => /readMaxBytes.*exceeds the v1 transport envelope/.test(String(e.message)),
  );
  fixture.cleanup();
});

test("envelope: a raw 2MiB single-chunk PUT (legacy 4MiB shape) is frame-rejected at the transport layer — handler never invoked, zero staging residue", async (t) => {
  const fixture = tempFixture({});
  t.after(() => fixture.cleanup());
  const rt = await createFilesRuntime({ home: fixture.home, log: () => {}, resolvePeer: async () => "ep-a" });
  t.after(() => rt.onDispose());
  await rt.onEnable({ home: fixture.home, dataDir: `${fixture.home}/plugins/files` });
  const share = await rt.shares.add({ name: "docs", root: fixture.rootDir, mode: "rw", peers: ["ep-a"] });

  let handlerCalls = 0;
  const proxiedHandler = async (request) => {
    handlerCalls++;
    return rt.handler(request);
  };
  const guarded = wrapFilesTransport(createHandlerTransport(proxiedHandler, { sessionId: "s1" }));
  await assert.rejects(
    () =>
      guarded.send({
        method: "PUT",
        path: `/wpk1/files/${share.id}/chunk?path=big.bin&uploadId=env1&seq=0&offset=0&chunkHash=${"0".repeat(64)}`,
        body: [new Uint8Array(Buffer.alloc(2 * MIB, 0x47))],
      }),
    (e) => e instanceof TransportEnvelopeError && e.layer === "frame" && e.code === "frame-too-large",
  );
  assert.equal(handlerCalls, 0, "over-envelope chunk never reached the provider handler");
  const stagingRoot = path.join(fixture.home, "plugins/files/staging");
  const residue = await fsp.readdir(stagingRoot).catch(() => []);
  assert.equal(residue.length, 0, "zero staging residue");
  const rootEntries = await fsp.readdir(fixture.rootDir);
  assert.equal(rootEntries.includes("big.bin"), false, "nothing landed in the formal namespace");
});

test("envelope: multi-element body totalling >2MiB is stream-rejected even when each element is <=1MiB", async (t) => {
  const fixture = tempFixture({});
  t.after(() => fixture.cleanup());
  const rt = await createFilesRuntime({ home: fixture.home, log: () => {}, resolvePeer: async () => "ep-a" });
  t.after(() => rt.onDispose());
  await rt.onEnable({ home: fixture.home, dataDir: `${fixture.home}/plugins/files` });
  const share = await rt.shares.add({ name: "docs", root: fixture.rootDir, mode: "rw", peers: ["ep-a"] });

  const guarded = wrapFilesTransport(createHandlerTransport(rt.handler, { sessionId: "s1" }));
  await assert.rejects(
    () =>
      guarded.send({
        method: "PUT",
        path: `/wpk1/files/${share.id}/chunk?path=big.bin&uploadId=env2&seq=0&offset=0&chunkHash=${"0".repeat(64)}`,
        body: [new Uint8Array(Buffer.alloc(MIB, 0x48)), new Uint8Array(Buffer.alloc(MIB, 0x49)), new Uint8Array(Buffer.alloc(1, 0x4a))],
      }),
    (e) => e instanceof TransportEnvelopeError && e.layer === "stream" && e.code === "stream-exceeds-journal",
  );
});
