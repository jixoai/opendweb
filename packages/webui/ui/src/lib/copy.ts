// 失败态文案（自 ui/views.mjs 原样移植；冻结契约：六路矩阵 + 配对面失败码）。
// 术语纪律（§8.3）：admin token 一律「管理凭证」；不以身份标签指代使用者。

import type { AdminError } from "./api";

/** AdminError code → 语义化中文文案。 */
export function errorCopy(error: AdminError | null | undefined): { title: string; detail: string; retry: boolean } {
	const code = typeof error?.code === "string" ? error.code : "";
	const serverMessage = typeof error?.message === "string" ? error.message : "";
	// sidecar 传输族兜底码归入语义等价类（envelope 透传不违约；呈现按语义）：
	// upstream-unreachable ≈ network；upstream-timeout ≈ timeout；
	// upstream-too-large ≈ http-5xx。
	const effective =
		code === "upstream-unreachable"
			? "network"
			: code === "upstream-timeout"
				? "timeout"
				: code === "upstream-too-large"
					? "http-502"
					: code;
	switch (effective) {
    case "admin-not-enabled":
      return {
        title: "远端未开启管理面",
        detail:
          "目标服务器没有配置 DWEB_ADMIN_TOKEN，管理接口处于关闭状态。请在服务器上设置该环境变量并重启，然后回到本页重试。",
        retry: true,
      };
    case "unauthorized":
      return {
        title: "管理凭证无效",
        detail:
          "服务器拒绝了当前管理凭证。凭证在连接时已锁定，不能在本页更换——请退出本页，在终端用有效凭证重新运行启动命令：opendweb webui --token <新的管理凭证>（或按原启动命令重启）。",
        retry: false,
      };
    case "no-match":
      return {
        title: "目标不在线",
        detail: "所操作的端点或租户已不在线或已被移除。在线表已刷新，请核对后再试。",
        retry: true,
      };
    case "timeout":
      return {
        title: "连不上服务器",
        detail: "到不了目标服务器（连接或响应超时）——可能是本地网络问题，或远端已宕机。请检查后重试。",
        retry: true,
      };
    case "network":
      return {
        title: "连不上服务器",
        detail: "到不了目标服务器（网络错误）——可能是本地网络问题，或远端已宕机。请检查后重试。",
        retry: true,
      };
    default:
      if (effective.startsWith("http-5")) {
        return {
          title: "服务器内部错误",
          detail: `远端返回了服务错误（${effective || "http-5xx"}）。数据面可能仍在工作；持续出现请登录服务器检查。`,
          retry: true,
        };
      }
      if (effective === "http-404") {
        return {
          title: "远端没有这个管理接口",
          detail: "服务器响应了，但管理面缺少这个接口——它多半运行着旧版本。请把服务器升级到当前版本后重试。",
          retry: false,
        };
      }
      if (effective.startsWith("http-4")) {
        return {
          title: "请求被拒绝",
          detail: `远端拒绝了这次请求${serverMessage ? `（${serverMessage}）` : ""}。请核对后再试。`,
          retry: true,
        };
      }
      return {
        title: "请求失败",
        detail: `${effective || "unknown"}${serverMessage ? `：${serverMessage}` : ""}——请重试。`,
        retry: true,
      };
  }
}

export interface HealthCopy {
  tone: "ok" | "bad";
  label: string;
}

/** 健康灯四态文案（§4.2 流 B 步 1 / §4.3 C-1）。 */
export function healthCopy(error: AdminError | null | undefined): HealthCopy {
  if (error === null || error === undefined) {
    return { tone: "ok", label: "管理面连接正常" };
  }
  const raw = typeof error?.code === "string" ? error.code : "";
  // sidecar 传输族兜底码归入语义等价类（与 errorCopy 同一映射）
  const code =
    raw === "upstream-unreachable"
      ? "network"
      : raw === "upstream-timeout"
        ? "timeout"
        : raw === "upstream-too-large"
          ? "http-502"
          : raw;
  if (code === "unauthorized") return { tone: "bad", label: "管理凭证无效" };
  if (code === "admin-not-enabled") return { tone: "bad", label: "远端未开启管理面" };
  if (code.startsWith("http-5")) return { tone: "bad", label: "服务器内部错误" };
  if (code === "network" || code === "timeout") return { tone: "bad", label: "连不上服务器" };
  return { tone: "bad", label: "管理面异常" };
}

/** 配对面错误码 → 语义化文案（/sidecar/connect 失败面，§5.3 成品文案）。 */
export function connectErrorCopy(error: AdminError | null | undefined): { title: string; detail: string } {
  const code = typeof error?.code === "string" ? error.code : "";
  switch (code) {
    case "bad-pairing":
      return {
        title: "配对码不对，或已过期",
        detail:
          "请对照终端打印的配对码重新抄录——注意它是 13 位、10 分钟内有效、只能用一次。连续错 5 次配对码会作废，届时需要退出并重新运行命令获取新码。",
      };
    case "bad-target":
      return {
        title: "服务器地址被拒绝",
        detail: `${typeof error?.message === "string" ? error.message : ""} 地址必须是完整的 https:// 或 http:// 开头；明文 http 的公网地址需要启动命令加 --allow-insecure。`,
      };
    case "bad-origin-host":
      return {
        title: "来源校验失败",
        detail: "请确认浏览器地址栏与终端打印的地址完全一致（不要用别的域名或端口打开本页）。",
      };
    case "invalid-request":
      return {
        title: "信息不完整",
        detail: "服务器地址、管理凭证、配对码三项都要填写。",
      };
    case "target-frozen":
      return {
        title: "目标已锁定",
        detail:
          "本进程已连接过服务器，不能经此表单改指。需要换节点：用顶栏「节点簿」切换到已保存的节点；还没保存的节点，先在节点簿里添加。",
      };
    case "pairing-in-progress":
      return {
        title: "正在处理另一个连接请求",
        detail: "稍等片刻再试。",
      };
    default:
      return { title: "连接失败", detail: `${code}：${error?.message ?? ""}` };
  }
}
