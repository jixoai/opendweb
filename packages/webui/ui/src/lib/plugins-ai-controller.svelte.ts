// ai 插件控制器（ai-subscription-sharing Phase C / tasks C2「UI 七接入点」）。
// 意图（2026-10-01）：
// 1. ProviderPage/ConsumerPage 的装配层状态源（页面零 fetch 纪律——全部请求
//    走 /sidecar/plugins/ai/*；本控制器持响应式状态 + 动作锁 + 错误面）。
// 2. 凭证纪律：密钥原文/链接原文只进 issuedKey/issuedLink 一次性视图状态
//    （关闭即清空；不落 localStorage/URL——浏览器新路径零凭证）；列表/用量
//    投影服务端已掩码。
// 3. 两套独立错误面（provider/consumer）与独立 busy 锁（页面视角分离——
//    双姿态共存互不排斥在 UI 态上的投影）。

import {
	addAiConsumerKey,
	commitAiImport,
	createAiGroup,
	createAiLink,
	createAiService,
	deleteAiGroup,
	deleteAiSecret,
	deleteAiService,
	fetchAiConsumer,
	fetchAiOverview,
	fetchAiPresets,
	fetchAiUsage,
	importAiLink,
	issueAiKey,
	patchAiGroup,
	patchAiService,
	refreshAiConsumer,
	revokeAiKey,
	setAiSecret,
	stageAiImport,
	startAiConsumerEndpoint,
	stopAiConsumerEndpoint,
	toAdminError,
	type AiConsumerData,
	type AiOverviewData,
	type AiPreset,
	type AiUsageData,
} from "./api";

/** 签发密钥的一次性全文视图（离开即清空——列表只有 keyId/状态）。 */
export interface AiIssuedKey {
	keyId: string;
	key: string;
	group: string;
	createdAt: number;
}

/** 分享链接的一次性全文视图（内嵌密钥原文——同样仅本地面一次性展示）。 */
export interface AiIssuedLink {
	link: string;
	keyId: string;
	group: string;
	services: number;
	recipient: string;
}

class AiController {
	// ---- 提供方（admin） -----------------------------------------------------------

	overview = $state<AiOverviewData | null>(null);
	presets = $state<AiPreset[] | null>(null);
	usage = $state<AiUsageData | null>(null);
	providerError = $state<string | null>(null);
	providerBusy = $state(false);

	issuedKey = $state<AiIssuedKey | null>(null);
	issuedLink = $state<AiIssuedLink | null>(null);

	// ---- 消费方（member） ----------------------------------------------------------

	consumer = $state<AiConsumerData | null>(null);
	consumerError = $state<string | null>(null);
	consumerBusy = $state(false);

	/** 提供方数据面刷新（页面进入/动作后）。 */
	async refreshProvider(): Promise<void> {
		try {
			const [o, p, u] = await Promise.all([fetchAiOverview(), fetchAiPresets(), fetchAiUsage()]);
			this.overview = o;
			this.presets = p.presets;
			this.usage = u;
			this.providerError = null;
		} catch (e) {
			this.providerError = toAdminError(e).message;
		}
	}

	/** 用量单独刷新（面板轮询位）。 */
	async refreshUsage(): Promise<void> {
		try {
			this.usage = await fetchAiUsage();
		} catch {
			/* 用量面失败不阻塞主列表 */
		}
	}

	/** 消费方数据面刷新。 */
	async refreshConsumer(): Promise<void> {
		try {
			this.consumer = await fetchAiConsumer();
			this.consumerError = null;
		} catch (e) {
			this.consumerError = toAdminError(e).message;
		}
	}

	/** 提供方动作包装（busy 锁 + 失败文案进 providerError；成功后刷新）。 */
	async #providerAction(fn: () => Promise<unknown>, refresh = true): Promise<boolean> {
		if (this.providerBusy) return false;
		this.providerBusy = true;
		try {
			await fn();
			this.providerError = null;
			if (refresh) await this.refreshProvider();
			return true;
		} catch (e) {
			this.providerError = toAdminError(e).message;
			return false;
		} finally {
			this.providerBusy = false;
		}
	}

	/** 消费方动作包装。 */
	async #consumerAction(fn: () => Promise<unknown>, refresh = true): Promise<boolean> {
		if (this.consumerBusy) return false;
		this.consumerBusy = true;
		try {
			await fn();
			this.consumerError = null;
			if (refresh) await this.refreshConsumer();
			return true;
		} catch (e) {
			this.consumerError = toAdminError(e).message;
			return false;
		} finally {
			this.consumerBusy = false;
		}
	}

	// ---- 提供方动作 ----------------------------------------------------------------

	createService(input: Parameters<typeof createAiService>[0]): Promise<boolean> {
		return this.#providerAction(() => createAiService(input));
	}

	toggleService(serviceId: string, enabled: boolean): Promise<boolean> {
		return this.#providerAction(() => patchAiService(serviceId, { enabled }));
	}

	bindServiceSecret(serviceId: string, secretName: string): Promise<boolean> {
		return this.#providerAction(() => patchAiService(serviceId, { auth: { secret: secretName } }));
	}

	removeService(serviceId: string): Promise<boolean> {
		return this.#providerAction(() => deleteAiService(serviceId));
	}

	createGroup(name: string, serviceNames: string[]): Promise<boolean> {
		return this.#providerAction(() => createAiGroup({ name, serviceNames }));
	}

	setGroupLimits(name: string, limits: { maxConcurrency?: number; dailyRequests?: number } | null): Promise<boolean> {
		return this.#providerAction(() => patchAiGroup(name, { limits }));
	}

	setGroupServices(name: string, serviceNames: string[]): Promise<boolean> {
		return this.#providerAction(() => patchAiGroup(name, { serviceNames }));
	}

	removeGroup(name: string): Promise<boolean> {
		return this.#providerAction(() => deleteAiGroup(name));
	}

	/** 签发密钥——原文进一次性视图（不落任何持久层）。 */
	async issueKey(group: string, name: string): Promise<boolean> {
		const ok = await this.#providerAction(async () => {
			const r = await issueAiKey({ group, ...(name !== "" ? { name } : {}) });
			this.issuedKey = { keyId: r.keyId, key: r.key, group, createdAt: r.createdAt };
		});
		return ok;
	}

	revokeKey(keyId: string): Promise<boolean> {
		return this.#providerAction(() => revokeAiKey(keyId));
	}

	setSecret(name: string, value: string): Promise<boolean> {
		return this.#providerAction(() => setAiSecret(name, value));
	}

	removeSecret(name: string): Promise<boolean> {
		return this.#providerAction(() => deleteAiSecret(name));
	}

	/** 生成分享链接（复用已存 key 或新签发；recipient=受邀方设备 ID）。 */
	async makeLink(group: string, recipient: string, keyId?: string): Promise<boolean> {
		const ok = await this.#providerAction(async () => {
			const r = await createAiLink({ group, recipient, ...(keyId !== undefined && keyId !== "" ? { keyId } : {}) });
			this.issuedLink = { link: r.link, keyId: r.keyId, group: r.group, services: r.services, recipient: r.recipient };
		});
		return ok;
	}

	closeIssuedKey(): void {
		this.issuedKey = null;
	}

	closeIssuedLink(): void {
		this.issuedLink = null;
	}

	// ---- 导入器（两阶段） ----------------------------------------------------------

	stageImport(rawText: string): Promise<{ blocked: Array<{ service: string; field: string; ref: string; varName?: string; reason?: string }>; ready: Array<{ name: string }> } | null> {
		return stageAiImport(rawText).catch((e) => {
			this.providerError = toAdminError(e).message;
			return null;
		});
	}

	commitImport(input: Parameters<typeof commitAiImport>[0]): Promise<boolean> {
		return this.#providerAction(() => commitAiImport(input));
	}

	// ---- 消费方动作 ----------------------------------------------------------------

	importLink(link: string): Promise<boolean> {
		return this.#consumerAction(() => importAiLink(link));
	}

	addKey(key: string, providerRef: string): Promise<boolean> {
		return this.#consumerAction(() => addAiConsumerKey(key, providerRef), false);
	}

	refreshCatalog(providerRef?: string): Promise<boolean> {
		return this.#consumerAction(() => refreshAiConsumer(providerRef));
	}

	startEndpoint(providerEndpointId: string, serviceId: string, port: number): Promise<boolean> {
		return this.#consumerAction(() => startAiConsumerEndpoint({ providerEndpointId, serviceId, port }));
	}

	stopEndpoint(id: string): Promise<boolean> {
		return this.#consumerAction(() => stopAiConsumerEndpoint(id));
	}

	/** 剪贴板复制（无权限/非安全上下文静默降级——与 console store 同拍）。 */
	async copyText(text: string): Promise<boolean> {
		try {
			await navigator.clipboard.writeText(text);
			return true;
		} catch {
			return false;
		}
	}
}

/** 应用单例（绑定层与页面共用——ui/src/lib/plugins-ai-controller.svelte.ts）。 */
export const aiController = new AiController();
