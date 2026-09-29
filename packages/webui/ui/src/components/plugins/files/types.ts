// FileBrowserPage 的 props 契约（webui-plugin-kernel Phase 2 / design v2.3 §6
// 「B 侧 UI（类型化专属页）」）。
// 意图（2026-09-29）：
// 1. 组件不直接 fetch、不 import api/console store——share 信息与全部远端
//   动作经 props 注入（宿主壳接线时由 plugin-pages 绑定层组装；参考实现=
//   @jixo/opendweb-ext-files 的 createWireFilesController——transport 接
//   client-sdk fetchHttp 的薄适配）。
// 2. writable = share.mode === "rw" && 该 peer 被授权写——由注入方判定，
//   组件只按该旗标显隐写按钮（写门的服务端真源仍是 wire 授权）。

/** 注入的共享信息（B 侧视角） */
export interface FilesShareInfo {
	/** share id（wire 路径段） */
	id: string;
	/** 展示名 */
	name: string;
	/** 共享模式（提供侧账本） */
	mode: "ro" | "rw";
	/** 是否可写（mode rw 且 peer 被授权）——写按钮显隐的总开关 */
	writable: boolean;
}

/** 目录条目（GET list 行形状） */
export interface FilesBrowserEntry {
	name: string;
	type: "dir" | "file";
	size: number;
	mtime: number;
}

/** 控制器（组件的全部远端动作；错误以 throw 交回组件呈现） */
export interface FilesBrowserController {
	/** 列目录（path 为相对 share root 的目录路径，""=root） */
	list(dirPath: string): Promise<{ entries: FilesBrowserEntry[]; truncated: boolean }>;
	/** 读一段（Range 语义；size=全文件大小——进度/续读用） */
	readSlice(filePath: string, offset: number, len: number): Promise<{ bytes: Uint8Array; size: number | null; oid: string | null }>;
	/** 上传单分片（组件做分片循环+进度回调；chunkHash 由实现方计算） */
	putChunk(filePath: string, uploadId: string, seq: number, offset: number, bytes: Uint8Array): Promise<{ idempotent: boolean; received: number }>;
	/** 提交（服务端核对总长+整文件 hash 后原子落盘） */
	commit(filePath: string, uploadId: string, totalLength: number, contentHash: string): Promise<{ oid: string; size: number }>;
	mkdir(dirPath: string): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	remove(path: string): Promise<void>;
}

/** FileBrowserPage props（完整契约面） */
export interface FileBrowserPageProps {
	share: FilesShareInfo;
	controller: FilesBrowserController;
}
