// FileBrowserPage 的 bridge 控制器（webui-plugin-kernel 收官接线）。
// 意图（2026-09-29）：
// 1. 组件不直接 fetch（types.ts 契约纪律）——本模块在浏览器侧实现
//    FilesBrowserController：wire 调用形状镜像 @jixo/opendweb-ext-files
//    client.mjs 参考实现（list/stat/read/chunk/commit/mkdir/rename/delete 的
//    路径与参数），transport=console store 的 filesBridgeCall（sidecar
//    /sidecar/plugins/files/bridge 信封 → fabric fetchHttp——B 侧数据面）。
// 2. 分片 hash：putChunk 的 chunkHash 由实现方计算（契约无 hash 入参）——
//    ./sha256.ts（浏览器/Node 通用，零 crypto API 依赖）。
// 3. 错误面：bridge 5xx/网络=transport 抛 AdminError；wire 非 2xx=解析
//    {error, message}（files runtime 的 JSON 错误形状）抛 Error（code 属性
//    供组件呈现）。

import { sha256Hex } from "../components/plugins/files/sha256";
import type { FilesBrowserController } from "../components/plugins/files/types";
import type { FilesBridgeRequest, FilesBridgeResponse } from "./api";
import { base64ToBytes } from "./api";

/** bridge transport（console store 注入——错误以 throw 交回）。 */
export type FilesBridgeTransport = (req: FilesBridgeRequest) => Promise<FilesBridgeResponse>;

/**
 * 建 bridge 控制器。
 * @param transport sidecar bridge 调用面
 * @param opts {peer: 对端提供侧 endpointId, shareId}
 */
export function createBridgeFilesController(
	transport: FilesBridgeTransport,
	opts: { peer: string; shareId: string },
): FilesBrowserController {
	const base = `/wpk1/files/${opts.shareId}`;

	async function send(req: { method: "GET" | "PUT" | "POST"; path: string; body?: Uint8Array | null }): Promise<FilesBridgeResponse> {
		const res = await transport({
			peer: opts.peer,
			shareId: opts.shareId,
			method: req.method,
			path: req.path,
			...(req.body != null ? { body: req.body } : {}),
		});
		if (res.status < 200 || res.status > 299) {
			let code = `http-${res.status}`;
			let message = "";
			try {
				const parsed = JSON.parse(new TextDecoder().decode(base64ToBytes(res.bodyBase64)));
				if (parsed !== null && typeof parsed === "object") {
					const r = parsed as Record<string, unknown>;
					if (typeof r.error === "string") code = r.error;
					if (typeof r.code === "string" && code === `http-${res.status}`) code = r.code;
					if (typeof r.message === "string") message = r.message;
				}
			} catch {
				/* 非 JSON 错误体——默认 code */
			}
			const err = new Error(message || `files wire error ${res.status}`);
			(err as Error & { code?: string }).code = code;
			throw err;
		}
		return res;
	}

	async function sendJson(req: { method: "GET" | "PUT" | "POST"; path: string; body?: Uint8Array | null }): Promise<Record<string, unknown>> {
		const res = await send(req);
		return JSON.parse(new TextDecoder().decode(base64ToBytes(res.bodyBase64))) as Record<string, unknown>;
	}

	function jsonBody(v: unknown): Uint8Array {
		return new TextEncoder().encode(JSON.stringify(v));
	}

	const enc = encodeURIComponent;

	return {
		async list(dirPath) {
			const out = await sendJson({ method: "GET", path: `${base}/list?path=${enc(dirPath)}` });
			return { entries: (out.entries ?? []) as never, truncated: out.truncated === true };
		},
		async readSlice(filePath, offset, len) {
			const res = await send({ method: "GET", path: `${base}/read?path=${enc(filePath)}&offset=${offset}&len=${len}` });
			return {
				bytes: base64ToBytes(res.bodyBase64),
				oid: res.headers["x-opendweb-oid"] ?? null,
				size: res.headers["x-opendweb-size"] !== undefined ? Number(res.headers["x-opendweb-size"]) : null,
			};
		},
		async putChunk(filePath, uploadId, seq, offset, bytes) {
			const out = await sendJson({
				method: "PUT",
				path: `${base}/chunk?path=${enc(filePath)}&uploadId=${enc(uploadId)}&seq=${seq}&offset=${offset}&hash=${sha256Hex(bytes)}`,
				body: bytes,
			});
			return { idempotent: out.idempotent === true, received: (out.received ?? 0) as number };
		},
		async commit(filePath, uploadId, totalLength, contentHash) {
			const out = await sendJson({
				method: "POST",
				path: `${base}/commit`,
				body: jsonBody({ uploadId, path: filePath, totalLength, contentHash }),
			});
			return { oid: (out.oid ?? "") as string, size: (out.size ?? 0) as number };
		},
		async mkdir(dirPath) {
			await sendJson({ method: "POST", path: `${base}/mkdir`, body: jsonBody({ path: dirPath }) });
		},
		async rename(from, to) {
			await sendJson({ method: "POST", path: `${base}/rename`, body: jsonBody({ from, to }) });
		},
		async remove(filePath) {
			await sendJson({ method: "POST", path: `${base}/delete`, body: jsonBody({ path: filePath }) });
		},
	};
}
