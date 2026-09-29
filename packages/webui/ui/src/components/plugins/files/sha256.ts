// 增量 SHA-256（webui-plugin-kernel Phase 2——FileBrowserPage 上传/下载用）。
// 为什么不用 crypto.subtle：SubtleCrypto 无增量面——大文件只能整读进内存；
// 上传/下载需要边读边累计整文件摘要（commit 的 contentHash 与下载对账）。
// 实现：标准 FIPS 180-4 SHA-256（Uint32Array；块缓冲 64B；update/digestHex）。
// 正确性以仓内测试对照 node:crypto 随机向量验证（test/ui-compile.test.mjs）。

const K = new Uint32Array([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** 增量 SHA-256（浏览器/Node 通用；无 crypto API 依赖） */
export class Sha256 {
	private h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
	private buf = new Uint8Array(64);
	private bufLen = 0;
	private lenHi = 0;
	private lenLo = 0;
	private w = new Uint32Array(64);
	private done = false;

	/** 喂入任意长度字节 */
	update(data: Uint8Array): this {
		if (this.done) throw new Error("Sha256: digest already taken");
		const lo = (this.lenLo + data.length) >>> 0;
		if (lo < this.lenLo) this.lenHi = (this.lenHi + 1) >>> 0;
		this.lenLo = lo;
		this.lenHi = (this.lenHi + Math.floor(data.length / 0x100000000)) >>> 0;
		let off = 0;
		if (this.bufLen > 0) {
			const take = Math.min(64 - this.bufLen, data.length);
			this.buf.set(data.subarray(0, take), this.bufLen);
			this.bufLen += take;
			off = take;
			if (this.bufLen === 64) {
				this.block(this.buf, 0);
				this.bufLen = 0;
			}
		}
		while (off + 64 <= data.length) {
			this.block(data, off);
			off += 64;
		}
		if (off < data.length) {
			this.buf.set(data.subarray(off), 0);
			this.bufLen = data.length - off;
		}
		return this;
	}

	/** 终态摘要（hex 小写；本实例此后不可再用） */
	digestHex(): string {
		if (this.done) throw new Error("Sha256: digest already taken");
		this.done = true;
		const bitLenLo = this.lenLo * 8;
		const bitLenHi = Math.floor((this.lenLo * 8) / 0x100000000) + this.lenHi * 8;
		this.update1(0x80);
		while (this.bufLen !== 56) this.update1(0x00);
		this.update1((bitLenHi >>> 24) & 0xff);
		this.update1((bitLenHi >>> 16) & 0xff);
		this.update1((bitLenHi >>> 8) & 0xff);
		this.update1(bitLenHi & 0xff);
		this.update1((bitLenLo >>> 24) & 0xff);
		this.update1((bitLenLo >>> 16) & 0xff);
		this.update1((bitLenLo >>> 8) & 0xff);
		this.update1(bitLenLo & 0xff);
		const out = new Uint8Array(32);
		const dv = new DataView(out.buffer);
		for (let i = 0; i < 8; i++) dv.setUint32(i * 4, this.h[i], false);
		let hex = "";
		for (const b of out) hex += b.toString(16).padStart(2, "0");
		return hex;
	}

	private update1(byte: number): void {
		this.buf[this.bufLen++] = byte;
		if (this.bufLen === 64) {
			this.block(this.buf, 0);
			this.bufLen = 0;
		}
	}

	private block(data: Uint8Array, off: number): void {
		const w = this.w;
		const dv = new DataView(data.buffer, data.byteOffset + off, 64);
		for (let i = 0; i < 16; i++) w[i] = dv.getUint32(i * 4, false);
		for (let i = 16; i < 64; i++) {
			const x = w[i - 15];
			const y = w[i - 2];
			const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
			const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
			w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
		}
		let [a, b, c, d, e, f, g, h] = this.h;
		for (let i = 0; i < 64; i++) {
			const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
			const ch = (e & f) ^ (~e & g);
			const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
			const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
			const maj = (a & b) ^ (a & c) ^ (b & c);
			const t2 = (S0 + maj) >>> 0;
			h = g;
			g = f;
			f = e;
			e = (d + t1) >>> 0;
			d = c;
			c = b;
			b = a;
			a = (t1 + t2) >>> 0;
		}
		this.h[0] = (this.h[0] + a) >>> 0;
		this.h[1] = (this.h[1] + b) >>> 0;
		this.h[2] = (this.h[2] + c) >>> 0;
		this.h[3] = (this.h[3] + d) >>> 0;
		this.h[4] = (this.h[4] + e) >>> 0;
		this.h[5] = (this.h[5] + f) >>> 0;
		this.h[6] = (this.h[6] + g) >>> 0;
		this.h[7] = (this.h[7] + h) >>> 0;
	}
}

/** 一次性便捷（小数据） */
export function sha256Hex(data: Uint8Array): string {
	return new Sha256().update(data).digestHex();
}
