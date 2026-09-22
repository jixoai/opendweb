// 纯渲染视图（webui-console UI 层重做 / PRODUCT-DESIGN §3–§5 + §8 拍板，方向 B 台账）。
// 意图（2026-09-22 UI 重做）：
// 1. 两个世界分离（§3.1 裁决 1）：SetupWizard 是 setup 态唯一界面（全屏一次性
//    引导，无导航壳）；ready 世界 = 总览（结论→关键数字→配置投影→引导）+
//    访问管理（所有者名册 / 在线连接两视角 + fabric 互链）。业务视图在 setup
//    态根本不挂载（app.mjs 路由保证）——「未连接」引导由引导本身承担；
// 2. 术语纪律（§5.1 + §8.3 拍板）：registry 条目一律「所有者」、admin token
//    一律「管理凭证」、不以任何身份标签指代控制台使用者；generation→「名册
//    版本」、mode/policy→中文投影（受限模式/静态名册）、cache_entries 不上
//    UI；时间一律本地时间+相对时间（无 ISO 8601 原文）；hex 浏览面一律前
//    8 位缩写 + 复制 + 悬停全文（title），操作面（注册表单）保留完整 64 hex
//    输入；
// 3. 失败态语义化（冻结契约）：errorCopy 六路矩阵中文指引、每视图单一
//    ErrorBanner（无错误风暴）；断连四态（已下发/收敛中/已收敛/超时未确认）
//    同视图闭环 + per-target 回执；回执展示 op/时间/名册版本/审计签名摘要 +
//    复制全文；token 只以 password 框 value 存在、提交后清空不回显；
// 4. 全部视图为纯函数（props → vnode），可直接在 node --test 里渲染断言；
//    副作用（fetch/轮询/路由/剪贴板）全部在 app.mjs，本文件不 import DOM API。
import { html } from "./html.mjs";

// ---- 小工具（纯函数） ----------------------------------------------------------

/** hex64 缩写显示（默认前 8 字符 + …）。 */
export function shortHex(value, head = 8) {
  if (typeof value !== "string" || value === "") return "-";
  return value.length <= head ? value : `${value.slice(0, head)}…`;
}

/** 回执签名（base64url-nopad 64B）→ 前 N 位 hex（默认 16 hex = 8 字节）。 */
export function sigPrefixHex(b64url, chars = 16) {
  if (typeof b64url !== "string" || b64url === "") return "";
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const bytes = [];
  let acc = 0;
  let bits = 0;
  for (const ch of b64url) {
    const v = ALPHABET.indexOf(ch);
    if (v === -1) return "";
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((acc >>> bits) & 0xff);
    }
  }
  return bytes
    .slice(0, Math.ceil(chars / 2))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, chars);
}

/** 客户端 hex64 校验（与服务端 400 规则同构的 fail-fast 镜像）。 */
export function validateHex64(value) {
  if (typeof value !== "string") return null;
  const t = value.trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(t) ? t : null;
}

const pad2 = (n) => String(n).padStart(2, "0");

/** 毫秒时间戳 → 本地时间 YYYY-MM-DD HH:mm:ss（§5.1：无 ISO 8601 原文）。 */
export function fmtLocal(ts) {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return "-";
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** 毫秒时间戳 → 本地时钟 HH:mm:ss（轮询失败时刻等轻量呈现）。 */
export function fmtClock(ts) {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return "-";
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** 相对时间（刚刚 / N 秒前 / N 分钟前 / N 小时前 / N 天前）。now 可注入（测试面）。 */
export function relativeTime(ts, now = Date.now()) {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return "-";
  const diff = Math.max(0, now - ts);
  if (diff < 10_000) return "刚刚";
  if (diff < 60_000) return `${Math.floor(diff / 1_000)} 秒前`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

/** 时间通则：本地时间 + 相对时间（§7.3 验收 3：所有时间人类可读）。 */
export function formatTime(ts, now = Date.now()) {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return "-";
  return `${fmtLocal(ts)}（${relativeTime(ts, now)}）`;
}

// ---- 术语投影（§5.1 逐处裁决） --------------------------------------------------

/** 回执 op → 中文动词（title 保留原始 op 值——契约字段不丢）。 */
export const OP_LABEL = { register: "注册", unregister: "注销", disconnect: "断开" };

/** mode → 徽章投影（受限模式/开放模式）；悬停给出安全姿态解释。 */
export function modeBadge(mode) {
  if (mode === "restricted") {
    return { label: "受限模式", title: "只有名册内的所有者可以接入" };
  }
  if (mode === "open") {
    return { label: "开放模式", title: "未启用身份验证，任何人都能接入" };
  }
  return null;
}

/** policy → 准入策略投影（静态名册 / 动态回调）。 */
export function policyLabel(policy) {
  if (policy === "static") return "静态名册";
  if (policy === "callback") return "动态回调";
  return typeof policy === "string" && policy !== "" ? policy : "-";
}

// ---- 失败态文案（冻结契约：六路矩阵 + 配对面失败码） ----------------------------

/**
 * AdminError code → 语义化中文文案（spec「UI 失败态矩阵呈现」；总览结论区与
 * 各业务区共用——传输级错误升级为顶栏健康灯 + 总览结论，动作级错误留在动作
 * 上下文）。@returns {{title: string, detail: string, retry: boolean}}
 */
export function errorCopy(error) {
  const code = typeof error?.code === "string" ? error.code : "";
  const serverMessage = typeof error?.message === "string" ? error.message : "";
  switch (code) {
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
        detail: "所操作的端点或所有者已不在线或已被移除。在线表已刷新，请核对后再试。",
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
      if (code.startsWith("http-5")) {
        return {
          title: "服务器内部错误",
          detail: `远端返回了服务错误（${code || "http-5xx"}）。数据面可能仍在工作；持续出现请登录服务器检查。`,
          retry: true,
        };
      }
      if (code === "http-404") {
        return {
          title: "远端没有这个管理接口",
          detail:
            "服务器响应了，但管理面缺少这个接口——它多半运行着旧版本。请把服务器升级到当前版本后重试。",
          retry: false,
        };
      }
      if (code.startsWith("http-4")) {
        return {
          title: "请求被拒绝",
          detail: `远端拒绝了这次请求${serverMessage ? `（${serverMessage}）` : ""}。请核对后再试。`,
          retry: true,
        };
      }
      return {
        title: "请求失败",
        detail: `${code || "unknown"}${serverMessage ? `：${serverMessage}` : ""}——请重试。`,
        retry: true,
      };
  }
}

/** 健康灯四态文案（§4.2 流 B 步 1 / §4.3 C-1）：ok | 各传输错误的短标签。 */
export function healthCopy(error) {
  if (error === null || error === undefined) {
    return { tone: "ok", label: "管理面连接正常" };
  }
  const code = typeof error?.code === "string" ? error.code : "";
  if (code === "unauthorized") return { tone: "bad", label: "管理凭证无效" };
  if (code === "admin-not-enabled") return { tone: "bad", label: "远端未开启管理面" };
  if (code.startsWith("http-5")) return { tone: "bad", label: "服务器内部错误" };
  if (code === "network" || code === "timeout") return { tone: "bad", label: "连不上服务器" };
  return { tone: "bad", label: "管理面异常" };
}

/** 配对面错误码 → 语义化文案（/sidecar/connect 失败面，§5.3 成品文案）。 */
export function connectErrorCopy(error) {
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
        detail: "本进程已连接过服务器，生命周期内不能改指。需要更换目标：退出本页，在终端重新运行命令。",
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

// ---- 复用件（横幅 / 对话 / 回执 / 徽章 / 骨架） ----------------------------------

/** 单一错误横幅（每视图至多一个——无错误风暴；unauthorized 不给重试）。 */
export function ErrorBanner({ error, onRetry }) {
  if (error === null || error === undefined) return null;
  const copy = errorCopy(error);
  return html`
    <div class="error-banner" role="alert">
      <div class="banner-title">${copy.title}</div>
      <div class="banner-detail">${copy.detail}</div>
      ${copy.retry && onRetry
        ? html`<button class="ghost small" onClick=${onRetry}>重试</button>`
        : null}
    </div>
  `;
}

/** 明文传输常驻告警（警告色非危险色；ready 且 insecure 目标——顶栏下全宽条）。 */
export function InsecureStrip() {
  return html`
    <div class="insecure-banner" role="alert">
      <span class="banner-title">连接未加密</span>
      <span class="banner-detail">
        当前目标经明文 http 连接（启动时使用了 --allow-insecure）：管理凭证与管理流量在传输中未加密。建议改用 https 目标，或通过加密隧道访问。生产环境请务必消除此告警。
      </span>
    </div>
  `;
}

/** 自绘确认对话（断连/注销共用；「先不了」是无压力选项——知情前置在正文）。 */
export function Dialog({
  title,
  confirmLabel = "确认",
  cancelLabel = "先不了",
  danger = false,
  onCancel,
  onConfirm,
  children,
}) {
  return html`
    <div class="dialog-overlay">
      <div class="dialog" role="dialog" aria-modal="true">
        <h3>${title}</h3>
        <div class="dialog-body">${children}</div>
        <div class="dialog-actions">
          <button class="ghost" onClick=${onCancel}>${cancelLabel}</button>
          <button class=${danger ? "danger" : ""} onClick=${onConfirm}>${confirmLabel}</button>
        </div>
      </div>
    </div>
  `;
}

/**
 * hex 浏览面原子件（§5.1 通则）：前 8 位缩写 + 悬停全文（title）+ 复制按钮。
 * 操作面（注册表单）不经过本件——那里保留完整 64 hex 输入与校验。
 */
export function Hex({ value, kind = "值", onCopyText }) {
  return html`
    <span class="hex">
      <span class="mono hex-short" title=${value}>${shortHex(value)}</span>
      ${onCopyText
        ? html`<button
            class="icon-btn"
            type="button"
            title=${`复制完整${kind}`}
            onClick=${() => onCopyText(value)}
          >复制</button>`
        : null}
    </span>
  `;
}

/** 骨架占位（§5.2：形状与内容区一致，不用纯文本「加载中…」）。 */
export function Skeleton({ lines = 3, wide = false }) {
  return html`
    <div class="skeleton${wide ? " wide" : ""}" aria-hidden="true">
      ${Array.from({ length: lines }, (_, i) => html`<div key=${i} class="skeleton-line"></div>`)}
    </div>
  `;
}

/** 顶栏健康灯（§4.2：常驻四态；由 5s 轮询驱动，切页不消失）。 */
export function HealthLight({ error, loading = false }) {
  const c = loading
    ? { tone: "pending", label: "正在连接服务器…" }
    : healthCopy(error);
  return html`
    <span class="health ${c.tone}" role="status" title=${c.label}>
      <span class="dot" aria-hidden="true"></span>${c.label}
    </span>
  `;
}

/**
 * 变更回执卡片（冻结契约：op/ts/generation/签名摘要 + 复制全文；§5.1 呈现
 * 裁决：签名降级为「审计签名」次级字段 + 「已含服务端签名」说明行）。
 */
export function ReceiptCard({ receipt, onCopy, onCopyText }) {
  const r = receipt ?? {};
  const op = typeof r.op === "string" ? r.op : "unknown";
  const target = op === "disconnect" ? r.endpoint_id : r.fabric_id;
  return html`
    <div class="receipt-card" data-op=${op}>
      <div class="receipt-head">
        <span class="badge" title=${`op: ${op}`}>${OP_LABEL[op] ?? op}</span>
        <span class="receipt-sig-note">已含服务端签名</span>
        ${onCopy
          ? html`<button class="ghost small" type="button" onClick=${() => onCopy(r)}>复制全文</button>`
          : null}
      </div>
      <dl class="receipt-fields">
        <dt>时间</dt>
        <dd>${formatTime(r.ts)}</dd>
        <dt>名册版本</dt>
        <dd class="mono">v${r.generation ?? "-"}</dd>
        <dt>目标</dt>
        <dd><${Hex} value=${target} kind=${op === "disconnect" ? "端点" : "Fabric"} onCopyText=${onCopyText}/></dd>
        <dt>审计签名</dt>
        <dd class="mono muted">${sigPrefixHex(r.receipt_sig) || "-"}…</dd>
        ${typeof r.kicked_connections === "number"
          ? html`<dt>一并断开的连接</dt><dd class="mono">${r.kicked_connections} 条</dd>`
          : null}
      </dl>
    </div>
  `;
}

/** 空态块（§5.2：空态即引导，不是「（空）」）。 */
export function EmptyState({ title, children, action = null }) {
  return html`
    <div class="empty-state">
      <div class="empty-title">${title}</div>
      <div class="empty-body">${children}</div>
      ${action}
    </div>
  `;
}

// ---- setup 世界：首次连接引导（§4.1 流 A） ---------------------------------------

/**
 * @param {{ state: {phase: string, server_host_masked: string | null} | null,
 *   form: {server: string, token: string, code: string},
 *   busy: boolean, result: {ok: boolean, error?: object} | null,
 *   onInput: (name: string, value: string) => void,
 *   onSubmit: () => void, onGoOverview: () => void }} props
 */
export function SetupWizard({ state, form, busy, result, onInput, onSubmit, onGoOverview }) {
  // 成功确认幕（短暂呈现，应用层随后进入 ready 世界）：目标只有掩码值。
  if (result !== null && result.ok === true) {
    return html`
      <div class="setup-world">
        <div class="setup-card success">
          <div class="setup-kicker">配对完成</div>
          <h1>已连接。正在进入总览…</h1>
          <p class="hint">
            目标已锁定：<span class="mono">${state?.server_host_masked ?? "-"}</span>
            ——本进程运行期间不能改指其他服务器。
          </p>
          <button onClick=${onGoOverview}>立即进入总览</button>
        </div>
      </div>
    `;
  }
  const err = result !== null && result.ok === false ? connectErrorCopy(result.error) : null;
  return html`
    <div class="setup-world">
      <div class="setup-card">
        <div class="setup-kicker">opendweb 服务器控制台 · 首次设置</div>
        <h1>把控制台接上你的服务器</h1>
        <p class="setup-lede">
          这个页面运行在你自己的电脑上，与云端的 dweb-server
          之间隔着一条安全通道——管理凭证只交给本地进程，浏览器不保存、不回显。
        </p>
        <div class="setup-steps">
          <h2>从终端抄三样东西</h2>
          <ol>
            <li><strong>服务器地址</strong>——形如 <span class="mono">https://srv.example.com:18787</span></li>
            <li><strong>管理凭证</strong>——服务器启动时设置的 <span class="mono">DWEB_ADMIN_TOKEN</span></li>
            <li><strong>配对码</strong>——终端最新打印的一行 13 位码，10 分钟内有效、只能用一次</li>
          </ol>
        </div>
        ${err !== null
          ? html`
              <div class="error-banner" role="alert">
                <div class="banner-title">${err.title}</div>
                <div class="banner-detail">${err.detail}</div>
              </div>
            `
          : null}
        <form
          class="stack"
          onSubmit=${(e) => {
            e.preventDefault();
            onSubmit();
          }}
        >
          <label>
            ① 服务器地址
            <input
              name="server"
              value=${form.server}
              onInput=${(e) => onInput("server", e.currentTarget.value)}
              autocomplete="off"
              spellcheck="false"
              placeholder="https://srv.example.com:18787"
            />
          </label>
          <label>
            ② 管理凭证
            <input
              name="token"
              type="password"
              value=${form.token}
              onInput=${(e) => onInput("token", e.currentTarget.value)}
              autocomplete="off"
              placeholder="粘贴后立即交给本地进程，本页不留存"
            />
          </label>
          <label>
            ③ 配对码
            <input
              name="code"
              value=${form.code}
              onInput=${(e) => onInput("code", e.currentTarget.value)}
              autocomplete="off"
              spellcheck="false"
              placeholder="13 位大写字母或数字"
            />
          </label>
          <button
            type="submit"
            disabled=${busy || form.server === "" || form.token === "" || form.code === ""}
          >
            ${busy ? "正在连接…" : "连接并锁定"}
          </button>
          <p class="hint">
            连接成功后目标即锁定——本进程运行期间不能改指其他服务器；需要更换时，退出并在终端重新运行命令。
          </p>
        </form>
      </div>
    </div>
  `;
}

// ---- ready 世界 · 顶栏连接详情面板（§3.2：目标真源） ------------------------------

/** 顶栏目标徽片（点击呼出连接详情面板）。 */
export function TargetChip({ masked, open = false, onToggle }) {
  return html`
    <button
      class="target-chip${open ? " open" : ""}"
      type="button"
      onClick=${onToggle}
      aria-expanded=${open}
      title="连接详情"
    >
      <span class="mono">${masked ?? "-"}</span><span class="caret" aria-hidden="true">▾</span>
    </button>
  `;
}

/** 连接详情面板：掩码目标 / 安全模型 / 重指向=重启指引 / 明文告警（insecure 时）。 */
export function ConnectionPanel({ state, onClose }) {
  return html`
    <div class="conn-panel" role="dialog" aria-label="连接详情">
      <h3>连接详情</h3>
      <dl class="receipt-fields">
        <dt>目标</dt>
        <dd class="mono">${state?.server_host_masked ?? "-"}</dd>
        <dt>安全模型</dt>
        <dd>管理凭证只保存在本地 sidecar 进程内，浏览器不保存、不回显。</dd>
        <dt>更换目标</dt>
        <dd>目标在本进程生命周期内已锁定。需要连接其他服务器时，退出本页并在终端重新运行启动命令。</dd>
      </dl>
      ${state?.insecure === true
        ? html`
            <div class="conn-panel-warn">
              连接未加密：当前目标经明文 http 传输，管理凭证与管理流量未加密。
            </div>
          `
        : null}
      <button class="ghost small" type="button" onClick=${onClose}>关闭</button>
    </div>
  `;
}

// ---- ready 世界 · 总览（§3.1 裁决 2：结论 → 关键数字 → 配置投影 → 引导） ----------

/**
 * @param {{ state: object | null, data: object | null, error: object | null,
 *   lastFailAt: number | null, onRetry: () => void, onGoOnline: () => void,
 *   onGoRegister: () => void }} props
 */
export function OverviewView({
  state,
  data,
  error,
  ownersData,
  lastFailAt,
  onRetry,
  onGoOnline,
  onGoRegister,
}) {
  const active = Array.isArray(data?.active_connections) ? data.active_connections : [];
  // 所有者计数真源 = 名册列表（ownersData）——status 的 per_owner_connections
  // 是「有活跃连接的所有者」在线投影（0 连接即空），不是名册计数（vision
  // 复判抓到的 0 vs 1 矛盾根因）
  const owners = Array.isArray(ownersData?.owners) ? ownersData.owners : [];
  const ownersLoaded = Array.isArray(ownersData?.owners);
  const totalConns = active.reduce((n, e) => n + (Number(e?.connections) || 0), 0);
  const mode = modeBadge(data?.mode);
  const hasError = error !== null && error !== undefined;
  const retryable = hasError && errorCopy(error).retry;
  return html`
    <section class="view overview" data-view="overview">
      <div class="view-head">
        <h2>总览</h2>
        <p class="hint">这台服务器正常吗、谁在用、谁能用——打开即答。</p>
      </div>
      ${hasError
        ? html`
            <${ErrorBanner} error=${error} onRetry=${onRetry}/>
            ${retryable
              ? html`
                  <p class="hint auto-retry">
                    自动每 5 秒重试中${lastFailAt != null ? `（上次失败 ${fmtClock(lastFailAt)}）` : ""}。
                  </p>
                `
              : null}
          `
        : data === null
          ? html`<div class="conclusion pending"><span class="dot" aria-hidden="true"></span>正在连接服务器…</div>`
          : html`
              <div class="conclusion ok">
                <span class="dot" aria-hidden="true"></span>
                一切正常。${totalConns} 条在线连接${ownersLoaded ? `，${owners.length} 个所有者` : ""}。
              </div>
            `}
      ${data === null && !hasError
        ? html`<${Skeleton} lines=${4}/>`
        : data !== null
          ? html`
              <div class="stats">
                <button class="stat link" type="button" onClick=${onGoOnline} title="查看在线连接明细">
                  <span class="stat-label">在线连接</span>
                  <span class="stat-value mono">${totalConns} 条</span>
                  <span class="stat-sub">按端点 ${active.length} 个</span>
                </button>
                <button class="stat link" type="button" onClick=${onGoRegister} title="管理所有者名册">
                  <span class="stat-label">所有者</span>
                  <span class="stat-value mono">${ownersLoaded ? `${owners.length} 个` : "…"}</span>
                  <span class="stat-sub">名册内可接入的 Fabric</span>
                </button>
                <div class="stat">
                  <span class="stat-label">接入模式</span>
                  <span class="stat-value">
                    ${mode !== null
                      ? html`<span class="badge mode" title=${mode.title}>${mode.label}</span>`
                      : html`<span class="muted">-</span>`}
                  </span>
                </div>
                <div class="stat" title="每次所有者名册变更后加 1，用于确认变更已生效">
                  <span class="stat-label">名册版本</span>
                  <span class="stat-value mono">v${data.generation ?? "-"}</span>
                </div>
              </div>
              ${data?.mode === "open"
                ? html`
                    <div class="open-note">
                      这台服务器未启用身份验证，任何人都能接入。
                    </div>
                  `
                : null}
              ${data?.mode === "restricted" && ownersLoaded && owners.length === 0
                ? html`
                    <div class="empty-state guide">
                      <div class="empty-title">还没有任何所有者能使用这台服务器。</div>
                      <div class="empty-body">
                        受限模式下，名册为空意味着除了你没有人能接入。如果有 Fabric
                        需要接入，去注册第一个所有者。
                      </div>
                      <button type="button" onClick=${onGoRegister}>去注册所有者</button>
                    </div>
                  `
                : null}
              <div class="config-card">
                <h3>配置</h3>
                <dl class="config">
                  <dt>准入策略</dt>
                  <dd>${policyLabel(data?.policy)}</dd>
                  <dt>每所有者连接上限</dt>
                  <dd class="mono">${data?.max_connections_per_owner ?? "未设置"}</dd>
                  <dt>中继（relay）</dt>
                  <dd>${
                    data?.relay_enabled === true
                      ? "已启用"
                      : data?.relay_enabled === false
                        ? "未启用"
                        : "-"
                  }</dd>
                </dl>
              </div>
            `
          : null}
    </section>
  `;
}

// ---- ready 世界 · 访问管理（§3.1 裁决 3：一页两视角 + fabric 互链） ----------------

/** 断连状态徽章文案（§4.3 C-2：已下发 → 收敛中 → 已收敛 / 超时未确认）。 */
const DISCONNECT_PHASE_LABEL = {
  dispatched: "已下发",
  converging: "收敛中",
  converged: "已收敛",
  unconfirmed: "超时未确认",
};

/**
 * 名册视角（谁可以用）：列表 / 注册 / 注销（知情前置确认 + 就地回执）。
 * @param {{ state: object | null, data: object | null, error: object | null,
 *   form: {fabricId: string, root: string}, formError: string | null, busy: boolean,
 *   receipt: object | null, confirm: {fabricId: string, root: string} | null,
 *   onInput: (name: string, value: string) => void, onRegister: () => void,
 *   onFocusRegister: () => void, onAskUnregister: (owner: object) => void,
 *   onConfirmUnregister: () => void, onCancelConfirm: () => void,
 *   onCopy: (receipt: object) => void, onCopyText: (text: string) => void,
 *   onFilterOnline: (fabricId: string) => void, onRetry: () => void }} props
 */
export function RosterView(props) {
  const { state, data, error, form, formError, busy, receipt, confirm } = props;
  // 「在用」状态源：onlineFabrics（来自在线连接快照 per_owner 的 fabric 集合）
  const onlineFabrics =
    props.onlineFabrics instanceof Set ? props.onlineFabrics : new Set();
  const {
    onInput,
    onRegister,
    onFocusRegister,
    onAskUnregister,
    onConfirmUnregister,
    onCancelConfirm,
    onCopy,
    onCopyText,
    onFilterOnline,
    onRetry,
  } = props;
  const owners = Array.isArray(data?.owners) ? data.owners : [];
  const fabricOk = validateHex64(form.fabricId) !== null || form.fabricId === "";
  const rootOk = validateHex64(form.root) !== null || form.root === "";
  return html`
    <section class="panel roster" data-section="roster">
      ${error !== null && error !== undefined ? html`<${ErrorBanner} error=${error} onRetry=${onRetry}/>` : null}
      <div class="panel-grid">
        <div class="table-card">
          <div class="table-card-head">
            <h3>
              所有者名册
              <span class="sub" title="每次所有者名册变更后加 1，用于确认变更已生效">
                名册版本 v${data?.generation ?? "-"}
              </span>
            </h3>
          </div>
          ${data === null
            ? error !== null && error !== undefined
              ? null
              : html`<${Skeleton} lines=${3}/>`
            : owners.length === 0
              ? html`
                  <${EmptyState}
                    title="名册是空的。"
                    action=${html`<button type="button" onClick=${onFocusRegister}>注册所有者</button>`}
                  >
                    注册后，对应的 Fabric 才能通过这台服务器组网。
                  <//>
                `
              : html`
                  <table>
                    <thead>
                      <tr><th>Fabric</th><th>根端点</th><th>注册时间</th><th></th></tr>
                    </thead>
                    <tbody>
                      ${owners.map(
                        (o) => html`
                          <tr key=${o.fabric_id + o.root}>
                            <td><${Hex} value=${o.fabric_id} kind="Fabric" onCopyText=${onCopyText}/></td>
                            <td><${Hex} value=${o.root} kind="根端点" onCopyText=${onCopyText}/></td>
                            <td class="time">${formatTime(o.registered_at)}</td>
                            <td class="actions">
                              <button
                                class="ghost small online-badge${onlineFabrics.has(o.fabric_id) ? " in-use" : ""}"
                                type="button"
                                title=${onlineFabrics.has(o.fabric_id)
                                  ? "该所有者有活跃连接——点击查看在线连接明细"
                                  : "该所有者当前没有活跃连接——点击查看在线视角"}
                                onClick=${() => onFilterOnline(o.fabric_id)}
                              >${onlineFabrics.has(o.fabric_id) ? "在用" : "未在用"}</button>
                              <button
                                class="danger ghost small"
                                type="button"
                                onClick=${() => onAskUnregister(o)}
                              >注销</button>
                            </td>
                          </tr>
                        `,
                      )}
                    </tbody>
                  </table>
                `}
        </div>
        <div class="side-card">
          <h3>注册所有者</h3>
          <p class="hint">所有者 = 允许接入这台服务器的一个 Fabric 网络。</p>
          <form
            class="stack"
            onSubmit=${(e) => {
              e.preventDefault();
              onRegister();
            }}
          >
            <label>
              Fabric
              <input
                id="owner-fabric-input"
                name="fabricId"
                class=${fabricOk ? "" : "invalid"}
                value=${form.fabricId}
                onInput=${(e) => onInput("fabricId", e.currentTarget.value)}
                autocomplete="off"
                spellcheck="false"
                placeholder="64 位十六进制字符（0-9 / a-f）"
              />
            </label>
            <label>
              根端点
              <input
                name="root"
                class=${rootOk ? "" : "invalid"}
                value=${form.root}
                onInput=${(e) => onInput("root", e.currentTarget.value)}
                autocomplete="off"
                spellcheck="false"
                placeholder="64 位十六进制字符（0-9 / a-f）"
              />
            </label>
            ${formError !== null ? html`<p class="field-error" role="alert">${formError}</p>` : null}
            <button
              type="submit"
              disabled=${busy || form.fabricId === "" || form.root === "" || !fabricOk || !rootOk}
            >${busy ? "提交中…" : "注册"}</button>
          </form>
        </div>
      </div>
      ${receipt !== null
        ? html`
            <div class="receipt-area">
              <h3>变更回执</h3>
              <${ReceiptCard} receipt=${receipt} onCopy=${onCopy} onCopyText=${onCopyText}/>
            </div>
          `
        : null}
      ${confirm !== null
        ? html`
            <${Dialog}
              title="注销这个所有者？"
              confirmLabel="确认注销"
              danger=${true}
              onCancel=${onCancelConfirm}
              onConfirm=${onConfirmUnregister}
            >
              <p>将从名册移除以下所有者：</p>
              <p>
                Fabric <span class="mono" title=${confirm.fabricId}>${shortHex(confirm.fabricId)}</span>
                · 根端点 <span class="mono" title=${confirm.root}>${shortHex(confirm.root)}</span>
              </p>
              <p>
                移除后，该 Fabric 的新连接立即被拒；名下如仍有在线连接，将一并断开（异步收敛）。
                如需恢复，重新注册即可。
              </p>
            <//>
          `
        : null}
    </section>
  `;
}

/**
 * 在线视角（谁正在用）：连接表 / 断连闭环（不跳页）/ 收敛观测 + 回执。
 * @param {{ state: object | null, data: object | null, error: object | null,
 *   confirm: {kind: "endpoint" | "fabric", id: string, count: number} | null,
 *   disconnect: {kind: "endpoint" | "fabric", id: string, phase: string, receipts: object[], error: object | null} | null,
 *   filter: string | null,
 *   onAskDisconnect: (kind: string, id: string, count: number) => void,
 *   onConfirmDisconnect: () => void, onCancelConfirm: () => void,
 *   onCopy: (receipt: object) => void, onCopyText: (text: string) => void,
 *   onRetry: () => void, onClearFilter: () => void,
 *   onDismissDisconnect: () => void }} props
 */
export function OnlineView(props) {
  const { state, data, error, confirm, disconnect, filter } = props;
  const {
    onAskDisconnect,
    onConfirmDisconnect,
    onCancelConfirm,
    onCopy,
    onCopyText,
    onRetry,
    onClearFilter,
    onDismissDisconnect,
  } = props;
  const perEndpointAll = Array.isArray(data?.per_endpoint) ? data.per_endpoint : [];
  const perOwnerAll = Array.isArray(data?.per_owner) ? data.per_owner : [];
  const perEndpoint = filter !== null ? perEndpointAll.filter((e) => e.fabric_id === filter) : perEndpointAll;
  const perOwner = filter !== null ? perOwnerAll.filter((o) => o.fabric_id === filter) : perOwnerAll;
  const quota = data?.quota ?? {};
  const max = quota.configured === true ? (quota.max_connections_per_owner ?? "-") : "未设置";
  const noun = disconnect?.kind === "fabric" ? "所有者" : "端点";
  const confirmNoun = confirm?.kind === "fabric" ? "所有者" : "端点";
  return html`
    <section class="panel online" data-section="online">
      ${error !== null && error !== undefined ? html`<${ErrorBanner} error=${error} onRetry=${onRetry}/>` : null}
      ${filter !== null
        ? html`
            <div class="filter-chip">
              只看所有者 <span class="mono" title=${filter}>${shortHex(filter)}</span>
              <button class="icon-btn" type="button" onClick=${onClearFilter} title="清除过滤">清除</button>
            </div>
          `
        : null}
      ${disconnect !== null
        ? html`
            <div class="disconnect-panel" data-phase=${disconnect.phase}>
              <div class="dp-head">
                <span class="badge phase-${disconnect.phase}">
                  ${DISCONNECT_PHASE_LABEL[disconnect.phase] ?? disconnect.phase}
                </span>
                <span class="mono" title=${disconnect.id}>${shortHex(disconnect.id)}</span>
                <span class="hint">（按${noun}断开）</span>
                ${(disconnect.phase === "converged" || disconnect.phase === "unconfirmed") && onDismissDisconnect
                  ? html`<button class="ghost small" type="button" onClick=${onDismissDisconnect}>关闭</button>`
                  : null}
              </div>
              ${disconnect.error !== null && disconnect.error !== undefined
                ? disconnect.error?.code === "no-match"
                  ? html`
                      <p class="dp-note">
                        这个${noun}已经不在线了——可能刚好自行断开。在线表已刷新，请核对。
                      </p>
                    `
                  : html`<${ErrorBanner} error=${disconnect.error}/>`
                : disconnect.phase === "dispatched"
                  ? html`<p class="dp-note">断开指令正在下发…</p>`
                  : disconnect.phase === "converging"
                    ? html`<p class="dp-note">正在确认连接已断开，通常几秒内完成……</p>`
                    : disconnect.phase === "converged"
                      ? html`<p class="dp-note">该${noun}已从在线表消失。回执如下，可复制存档。</p>`
                      : disconnect.phase === "unconfirmed"
                        ? html`
                            <p class="dp-note">
                              指令已下发，但 15 秒内在线表未观察到收敛。断开是尽力而为的——请刷新在线表核对；若连接仍在，可再次断开。
                            </p>
                          `
                        : null}
              ${Array.isArray(disconnect.receipts) && disconnect.receipts.length > 0
                ? html`
                    <div class="receipt-area">
                      ${disconnect.receipts.map(
                        (r, i) => html`<${ReceiptCard} key=${i} receipt=${r} onCopy=${onCopy} onCopyText=${onCopyText}/>`,
                      )}
                    </div>
                  `
                : null}
            </div>
          `
        : null}
      ${data === null
        ? error !== null && error !== undefined
          ? null
          : html`<${Skeleton} lines=${4}/>`
        : data.mode === "open"
          ? html`
              <${EmptyState} title="开放模式下没有在线统计。">
                这台服务器未启用身份验证，管理面只能看到配置，看不到连接明细。
              <//>
            `
          : data.relay_enabled === false
            ? html`
                <${EmptyState} title="中继（relay）未启用。">
                  这台服务器没有开启中继服务，因此没有在线连接可显示。
                <//>
              `
            : html`
                <div class="table-card">
                  <div class="table-card-head"><h3>按端点</h3></div>
                  ${perEndpointAll.length === 0
                    ? html`
                        <${EmptyState} title="当前没有在线连接。">
                          已注册的所有者建立组网后，连接会实时出现在这里。
                        <//>
                      `
                    : perEndpoint.length === 0
                      ? html`<p class="hint filtered-empty">该所有者当前没有在线连接。</p>`
                      : html`
                          <table>
                            <thead>
                              <tr><th>端点</th><th>Fabric</th><th class="num">连接数</th><th></th></tr>
                            </thead>
                            <tbody>
                              ${perEndpoint.map(
                                (e) => html`
                                  <tr key=${e.endpoint_id + e.fabric_id}>
                                    <td><${Hex} value=${e.endpoint_id} kind="端点" onCopyText=${onCopyText}/></td>
                                    <td><${Hex} value=${e.fabric_id} kind="Fabric" onCopyText=${onCopyText}/></td>
                                    <td class="mono num">${e.connections}</td>
                                    <td class="actions">
                                      <button
                                        class="danger ghost small"
                                        type="button"
                                        onClick=${() => onAskDisconnect("endpoint", e.endpoint_id, e.connections)}
                                      >断开</button>
                                    </td>
                                  </tr>
                                `,
                              )}
                            </tbody>
                          </table>
                        `}
                </div>
                <div class="table-card">
                  <div class="table-card-head"><h3>按所有者</h3></div>
                  ${perOwnerAll.length === 0
                    ? html`<p class="hint filtered-empty">没有所有者正在使用。</p>`
                    : perOwner.length === 0
                      ? html`<p class="hint filtered-empty">该所有者当前没有在线连接。</p>`
                      : html`
                          <table>
                            <thead>
                              <tr><th>Fabric</th><th class="num">在用 / 上限</th><th></th></tr>
                            </thead>
                            <tbody>
                              ${perOwner.map(
                                (o) => html`
                                  <tr key=${o.fabric_id}>
                                    <td><${Hex} value=${o.fabric_id} kind="Fabric" onCopyText=${onCopyText}/></td>
                                    <td class="mono num">${o.connections} / ${max}</td>
                                    <td class="actions">
                                      <button
                                        class="danger ghost small"
                                        type="button"
                                        onClick=${() => onAskDisconnect("fabric", o.fabric_id, o.connections)}
                                      >全部断开</button>
                                    </td>
                                  </tr>
                                `,
                              )}
                            </tbody>
                          </table>
                        `}
                </div>
              `}
      ${confirm !== null
        ? html`
            <${Dialog}
              title="断开这个${confirmNoun}？"
              confirmLabel="确认断开"
              danger=${true}
              onCancel=${onCancelConfirm}
              onConfirm=${onConfirmDisconnect}
            >
              ${confirm.kind === "endpoint"
                ? html`
                    <p>
                      将向服务器下发断开指令，端点
                      <span class="mono" title=${confirm.id}>${shortHex(confirm.id)}</span>
                      的 <strong>${confirm.count} 条连接</strong>会被关闭。
                    </p>
                  `
                : html`
                    <p>
                      将向服务器下发断开指令，所有者
                      <span class="mono" title=${confirm.id}>${shortHex(confirm.id)}</span>
                      名下的 <strong>${confirm.count} 条连接</strong>会被关闭。
                    </p>
                  `}
              <p>断开是异步的：确认后这里会显示进度，直到连接从在线表消失。</p>
            <//>
          `
        : null}
    </section>
  `;
}

/**
 * 访问管理页（一页两视角）：名册 ⇄ 在线（对象互链的宿主页）。
 * section 切换经 hash（#/access/roster | #/access/online）——可前进后退。
 * 名册/在线两组 props 在此显式分拣（取消确认等回执不得串视角）。
 */
export function AccessView(props) {
  const { section, onSection } = props;
  const rosterProps = {
    state: props.state,
    data: props.data,
    error: props.error,
    onlineFabrics: props.onlineFabrics,
    form: props.form,
    formError: props.formError,
    busy: props.busy,
    receipt: props.receipt,
    confirm: props.confirm,
    onInput: props.onInput,
    onRegister: props.onRegister,
    onFocusRegister: props.onFocusRegister,
    onAskUnregister: props.onAskUnregister,
    onConfirmUnregister: props.onConfirmUnregister,
    onCancelConfirm: props.onCancelOwnerConfirm,
    onCopy: props.onCopy,
    onCopyText: props.onCopyText,
    onFilterOnline: props.onFilterOnline,
    onRetry: props.onRetry,
  };
  const onlineProps = {
    state: props.state,
    data: props.connData,
    error: props.connError,
    confirm: props.connConfirm,
    disconnect: props.disconnect,
    filter: props.filter,
    onAskDisconnect: props.onAskDisconnect,
    onConfirmDisconnect: props.onConfirmDisconnect,
    onCancelConfirm: props.onCancelConnConfirm,
    onCopy: props.onCopy,
    onCopyText: props.onCopyText,
    onRetry: props.onRetryConnections,
    onClearFilter: props.onClearFilter,
    onDismissDisconnect: props.onDismissDisconnect,
  };
  return html`
    <section class="view access" data-view="access">
      <div class="view-head">
        <h2>访问管理</h2>
        <p class="hint">谁能用这台服务器（名册）、谁正在用（在线）——同一对象的两个视角。</p>
      </div>
      <div class="segmented" role="tablist" aria-label="访问管理视角">
        <button
          role="tab"
          type="button"
          aria-selected=${section === "roster"}
          class=${section === "roster" ? "active" : ""}
          onClick=${() => onSection("roster")}
        >所有者名册</button>
        <button
          role="tab"
          type="button"
          aria-selected=${section === "online"}
          class=${section === "online" ? "active" : ""}
          onClick=${() => onSection("online")}
        >在线连接</button>
      </div>
      ${section === "roster"
        ? html`<${RosterView} ...${rosterProps}/>`
        : html`<${OnlineView} ...${onlineProps}/>`}
    </section>
  `;
}
