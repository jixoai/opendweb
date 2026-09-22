<script lang="ts">
	// setup 世界：首次连接引导（§4.1 流 A）——全屏一次性仪式，无导航壳。
	// 成功确认幕短暂呈现（掩码目标 + 目标已锁定），随后应用层进入 ready 世界。
	import * as Card from "$lib/components/ui/card";
	import { Button } from "$lib/components/ui/button";
	import * as Alert from "$lib/components/ui/alert";
	import * as Field from "$lib/components/ui/field";
	import { Input } from "$lib/components/ui/input";
	import { Separator } from "$lib/components/ui/separator";
	import { CircleAlert, LoaderCircle, LockKeyhole } from "@lucide/svelte";
	import { connectErrorCopy } from "$lib/copy";
	import { consoleStore as cs } from "$lib/console.svelte";

	const err = $derived(
		cs.connectResult !== null && cs.connectResult.ok === false
			? connectErrorCopy(cs.connectResult.error)
			: null,
	);
	const canSubmit = $derived(
		cs.connectForm.server !== "" && cs.connectForm.token !== "" && cs.connectForm.code !== "",
	);
</script>

{#if cs.connectResult !== null && cs.connectResult.ok === true}
	<div class="flex min-h-svh items-center justify-center px-6">
		<Card.Root class="w-full max-w-lg text-center">
			<Card.Header class="items-center gap-3">
				<div
					class="mx-auto flex size-12 items-center justify-center rounded-full bg-success/10 text-success"
				>
					<LockKeyhole class="size-6" />
				</div>
				<Card.Title class="text-xl">已连接。正在进入总览…</Card.Title>
				<Card.Description>
					目标已锁定：<span class="font-mono">{cs.sidecar?.server_host_masked ?? "-"}</span>
					——运行期间经顶栏「节点簿」切换到其他已保存的节点。
				</Card.Description>
			</Card.Header>
			<Card.Footer class="justify-center">
				<Button onclick={() => cs.leaveSetupOnSuccess()}>立即进入总览</Button>
			</Card.Footer>
		</Card.Root>
	</div>
{:else}
	<div class="flex min-h-svh items-center justify-center px-6 py-10">
		<Card.Root class="w-full max-w-xl">
			<Card.Header>
				<Card.Description class="text-xs font-medium tracking-wide text-muted-foreground">
					opendweb 服务器控制台 · 首次设置
				</Card.Description>
				<Card.Title class="text-2xl font-semibold">把控制台接上你的服务器</Card.Title>
				<Card.Description class="text-sm leading-relaxed">
					这个页面运行在你自己的电脑上，与云端的 dweb-server
					之间隔着一条安全通道——管理凭证只交给本地进程，浏览器不保存、不回显。
				</Card.Description>
			</Card.Header>

			<Card.Content class="flex flex-col gap-6">
				<section class="rounded-lg border bg-muted/40 p-4">
					<h2 class="mb-2 text-sm font-medium">从终端抄三样东西</h2>
					<ol class="flex list-decimal flex-col gap-1.5 pl-5 text-sm text-muted-foreground">
						<li>
							<strong class="font-medium text-foreground">服务器地址</strong>——形如
							<span class="font-mono text-[13px]">https://srv.example.com:18787</span>
						</li>
						<li>
							<strong class="font-medium text-foreground">管理凭证</strong>——服务器启动时设置的
							<span class="font-mono text-[13px]">DWEB_ADMIN_TOKEN</span>
						</li>
						<li>
							<strong class="font-medium text-foreground">配对码</strong>——终端最新打印的一行
							13 位码，10 分钟内有效、只能用一次
						</li>
					</ol>
				</section>

				{#if err !== null}
					<Alert.Root variant="destructive">
						<CircleAlert />
						<Alert.Title>{err.title}</Alert.Title>
						<Alert.Description>{err.detail}</Alert.Description>
					</Alert.Root>
				{/if}

				<form
					class="flex flex-col gap-4"
					onsubmit={(e) => {
						e.preventDefault();
						void cs.submitConnect();
					}}
				>
					<Field.Group>
						<Field.Field>
							<Field.Label for="setup-server">① 服务器地址</Field.Label>
							<Input
								id="setup-server"
								name="server"
								value={cs.connectForm.server}
								oninput={(e) => cs.onConnectInput("server", e.currentTarget.value)}
								autocomplete="off"
								spellcheck="false"
								placeholder="https://srv.example.com:18787"
							/>
						</Field.Field>
						<Field.Field>
							<Field.Label for="setup-token">② 管理凭证</Field.Label>
							<Input
								id="setup-token"
								name="token"
								type="password"
								value={cs.connectForm.token}
								oninput={(e) => cs.onConnectInput("token", e.currentTarget.value)}
								autocomplete="off"
								placeholder="粘贴后立即交给本地进程，本页不留存"
							/>
						</Field.Field>
						<Field.Field>
							<Field.Label for="setup-code">③ 配对码</Field.Label>
							<Input
								id="setup-code"
								name="code"
								value={cs.connectForm.code}
								oninput={(e) => cs.onConnectInput("code", e.currentTarget.value)}
								autocomplete="off"
								spellcheck="false"
								placeholder="13 位大写字母或数字"
								class="font-mono uppercase"
							/>
						</Field.Field>
					</Field.Group>

					<Separator />

					<div class="flex flex-col gap-2">
						<Button
							type="submit"
							size="lg"
							disabled={cs.connectBusy || !canSubmit}
						>
							{#if cs.connectBusy}
								<LoaderCircle data-icon="inline-start" class="animate-spin" />
								正在连接…
							{:else}
								连接并锁定
							{/if}
						</Button>
						<p class="text-xs leading-relaxed text-muted-foreground">
							连接成功后目标即锁定——本进程运行期间不能经此表单改指；需要换节点时，用顶栏「节点簿」切换已保存的节点。
						</p>
					</div>
				</form>
			</Card.Content>
		</Card.Root>
	</div>
{/if}
