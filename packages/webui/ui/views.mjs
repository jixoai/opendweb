// 纯渲染视图（webui-console A.7 / design §4：SPA 信息架构）。
// 意图（2026-09-22）：
// 1. 全部视图为纯函数（props → vnode），零副作用、可直接在 node --test 里
//    渲染断言（失败态矩阵/回执/确认对话的测试面）；
// 2. 失败态语义化：errorCopy(code) 给出六路矩阵的中文指引文案，每视图
//    单一 ErrorBanner（无错误风暴）；setup 态业务视图一律 SetupGate
//    「未连接」引导；
// 3. 回执展示 op/ts/generation/签名前 16 hex + 复制全文（onCopy 由应用层
//    接管剪贴板）；断连结果「已下发/收敛中/已收敛/超时未确认」状态徽章。
// 副作用（fetch/轮询/路由）全部在 app.mjs；本文件不 import DOM API。
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

/**
 * AdminError code → 语义化中文文案（spec「UI 失败态矩阵呈现」）。
 * @param {{code?: string, message?: string}} error
 * @returns {{title: string, detail: string, retry: boolean}}
 */
export function errorCopy(error) {
  const code = typeof error?.code === "string" ? error.code : "";
  const serverMessage = typeof error?.message === "string" ? error.message : "";
  switch (code) {
    case "admin-not-enabled":
      return {
        title: "远端未启用管理面",
        detail: "目标服务器未配置 DWEB_ADMIN_TOKEN（/admin/* 未挂载，404）。请在服务端配置该环境变量并重启服务器后重试。",
        retry: true,
      };
    case "unauthorized":
      return {
        title: "token 无效",
        detail: "目标已冻结——当前 sidecar 生命周期内无法更换 token。请重启 sidecar 并使用有效的 DWEB_ADMIN_TOKEN 重新连接。",
        retry: false,
      };
    case "no-match":
      return {
        title: "目标不存在",
        detail: "所操作的 endpoint / fabric 不在线或已被移除（no-match）。请刷新在线表后重试。",
        retry: true,
      };
    case "timeout":
      return {
        title: "请求超时",
        detail: "上游响应超时——请检查 sidecar 与目标服务器的连通性后重试。",
        retry: true,
      };
    case "network":
      return {
        title: "网络错误",
        detail: "无法到达目标（网络错误）——请检查 sidecar 与目标服务器的连通性后重试。",
        retry: true,
      };
    default:
      if (code.startsWith("http-5")) {
        return {
          title: "上游服务错误",
          detail: `目标返回 ${code || "http-5xx"}——请稍后重试；持续失败请检查远端服务器状态。`,
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

/** 配对面错误码 → 语义化文案（/sidecar/connect 的失败面）。 */
export function connectErrorCopy(error) {
  const code = typeof error?.code === "string" ? error.code : "";
  switch (code) {
    case "bad-pairing":
      return {
        title: "配对码错误或已失效",
        detail: "请对照 sidecar 终端输出重新抄录一次性配对码。连续失败 5 次配对码将被销毁——销毁后需重启 sidecar 重新生成。",
      };
    case "bad-target":
      return {
        title: "目标 URL 被拒绝",
        detail: `${error?.message ?? ""}（仅接受绝对 http(s) URL；明文 http 公网目标需 sidecar 以 --allow-insecure 启动）`,
      };
    case "bad-origin-host":
      return {
        title: "来源校验失败",
        detail: "请确认浏览器从 sidecar 终端打印的 URL 原样打开本页面（Host/Origin 校验未通过）。",
      };
    case "invalid-request":
      return { title: "提交不完整", detail: "服务器 URL 与 admin token 均为必填。" };
    case "target-frozen":
      return {
        title: "目标已冻结",
        detail: "本 sidecar 已连接目标且生命周期内不可更改。如需重新指向，请重启 sidecar。",
      };
    default:
      return { title: "连接失败", detail: `${code}：${error?.message ?? ""}` };
  }
}

// ---- 横幅 / 引导 / 对话 / 回执（复用件） ---------------------------------------

/** 单一错误横幅（每视图至多一个——无错误风暴）。 */
export function ErrorBanner({ error, onRetry }) {
  if (error === null || error === undefined) return null;
  const copy = errorCopy(error);
  return html`
    <div class="error-banner" role="alert">
      <div class="banner-title">${copy.title}</div>
      <div class="banner-detail">${copy.detail}</div>
      ${copy.retry && onRetry
        ? html`<button class="ghost" onClick=${onRetry}>重试</button>`
        : null}
    </div>
  `;
}

/** 明文传输常驻告警（ready 且 http 非 loopback 目标——来自 state.insecure）。 */
export function InsecureBanner() {
  return html`
    <div class="insecure-banner" role="alert">
      <div class="banner-title">明文传输告警</div>
      <div class="banner-detail">
        目标经未加密的 http 连接（sidecar 以 --allow-insecure 启动）：admin token
        与管理流量在传输中未加密。建议改用 https 或 loopback 目标。
      </div>
    </div>
  `;
}

/** setup 态业务视图的「未连接」引导（不呈现业务错误——无错误风暴）。 */
export function SetupGate() {
  return html`
    <div class="setup-gate">
      <h2>未连接</h2>
      <p>尚未连接任何 dweb-server 目标（sidecar 处于 setup 模式）。</p>
      <p>
        前往
        <a href="#/connect">配对面</a>
        ，使用 sidecar 终端打印的一次性配对码连接服务器后再查看本页。
      </p>
    </div>
  `;
}

/** 自绘确认对话（断连/注销二次确认共用）。 */
export function Dialog({ title, confirmLabel = "确认", danger = false, onCancel, onConfirm, children }) {
  return html`
    <div class="dialog-overlay">
      <div class="dialog" role="dialog" aria-modal="true">
        <h3>${title}</h3>
        <div class="dialog-body">${children}</div>
        <div class="dialog-actions">
          <button class="ghost" onClick=${onCancel}>取消</button>
          <button class=${danger ? "danger" : ""} onClick=${onConfirm}>${confirmLabel}</button>
        </div>
      </div>
    </div>
  `;
}

/** 变更回执卡片：op/ts/generation/签名前 16 hex + 复制全文。 */
export function ReceiptCard({ receipt, onCopy }) {
  const r = receipt ?? {};
  const target = r.op === "disconnect" ? r.endpoint_id : r.root;
  const ts = typeof r.ts === "number" ? new Date(r.ts).toISOString() : "-";
  return html`
    <div class="receipt-card" data-op=${r.op ?? "unknown"}>
      <span class="badge">${r.op ?? "-"}</span>
      <dl class="receipt-fields">
        <dt>时间</dt>
        <dd>${ts}</dd>
        <dt>generation</dt>
        <dd>${r.generation ?? "-"}</dd>
        <dt>目标</dt>
        <dd class="mono">${shortHex(target)}</dd>
        <dt>签名前缀</dt>
        <dd class="mono">${sigPrefixHex(r.receipt_sig) || "-"}</dd>
        ${typeof r.kicked_connections === "number"
          ? html`<dt>踢除连接</dt><dd>${r.kicked_connections}</dd>`
          : null}
      </dl>
      ${onCopy
        ? html`<button class="ghost small" onClick=${() => onCopy(r)}>复制全文</button>`
        : null}
    </div>
  `;
}

// ---- #/connect 配对面 ----------------------------------------------------------

/**
 * @param {{ state: {phase: string, server_host_masked: string | null, insecure: boolean} | null,
 *   form: {server: string, token: string, code: string},
 *   busy: boolean, result: {ok: boolean, error?: object} | null,
 *   onInput: (name: string, value: string) => void,
 *   onSubmit: () => void, onGoStatus: () => void }} props
 */
export function ConnectView({ state, form, busy, result, onInput, onSubmit, onGoStatus }) {
  // ready 态（本页配对成功或以 ready 启动直达）：表单冻结为成功面板
  if (state !== null && state.phase === "ready") {
    return html`
      <section class="view" data-view="connect">
        <h2>服务器连接</h2>
        <div class="success-banner">
          <div class="banner-title">已连接</div>
          <div class="banner-detail">
            目标 <span class="mono">${state.server_host_masked ?? "-"}</span>
            ——目标已冻结（本 sidecar 生命周期内不可更改；重新指向需重启 sidecar）。
          </div>
          <button onClick=${onGoStatus}>前往状态页</button>
        </div>
      </section>
    `;
  }
  const err = result !== null && result.ok === false ? connectErrorCopy(result.error) : null;
  return html`
    <section class="view" data-view="connect">
      <h2>连接 dweb-server</h2>
      <p class="hint">
        从 sidecar 终端输出抄录<strong>一次性配对码</strong>填入下方表单。admin token
        仅随本请求提交一次，由 sidecar 进程持有——浏览器不保存、不回显。
      </p>
      ${err !== null
        ? html`
            <div class="error-banner" role="alert">
              <div class="banner-title">${err.title}</div>
              <div class="banner-detail">${err.detail}</div>
            </div>
          `
        : null}
      <form class="stack" onSubmit=${(e) => { e.preventDefault(); onSubmit(); }}>
        <label>
          配对码（终端打印，单次有效 10 分钟）
          <input
            name="code"
            value=${form.code}
            onInput=${(e) => onInput("code", e.currentTarget.value)}
            autocomplete="off"
            spellcheck="false"
            placeholder="13 位大写字母/数字"
          />
        </label>
        <label>
          服务器 URL（绝对 http(s)，如 https://srv.example:18787）
          <input
            name="server"
            value=${form.server}
            onInput=${(e) => onInput("server", e.currentTarget.value)}
            autocomplete="off"
            spellcheck="false"
            placeholder="https://srv.example:18787"
          />
        </label>
        <label>
          admin token（DWEB_ADMIN_TOKEN）
          <input
            name="token"
            type="password"
            value=${form.token}
            onInput=${(e) => onInput("token", e.currentTarget.value)}
            autocomplete="off"
            placeholder="提交后即清空，不回显"
          />
        </label>
        <button type="submit" disabled=${busy || form.code === "" || form.server === "" || form.token === ""}>
          ${busy ? "连接中…" : "连接"}
        </button>
      </form>
    </section>
  `;
}

// ---- #/status 总览 -------------------------------------------------------------

/**
 * @param {{ state: object | null, data: object | null, error: object | null,
 *   onRetry: () => void }} props
 */
export function StatusView({ state, data, error, onRetry }) {
  if (state !== null && state.phase !== "ready") return html`<${SetupGate}/>`;
  const active = Array.isArray(data?.active_connections) ? data.active_connections : [];
  const owners = Array.isArray(data?.per_owner_connections) ? data.per_owner_connections : [];
  const totalConns = active.reduce((n, e) => n + (Number(e?.connections) || 0), 0);
  return html`
    <section class="view" data-view="status">
      <h2>服务器总览</h2>
      ${state?.insecure === true ? html`<${InsecureBanner}/>` : null}
      ${error !== null && error !== undefined
        ? html`<${ErrorBanner} error=${error} onRetry=${onRetry}/>`
        : null}
      ${data === null
        ? html`<p class="loading">加载中…</p>`
        : html`
            <div class="cards">
              <div class="card">
                <div class="card-label">目标</div>
                <div class="card-value mono">${state?.server_host_masked ?? "-"}</div>
              </div>
              <div class="card">
                <div class="card-label">模式（mode）</div>
                <div class="card-value"><span class="badge">${data.mode ?? "-"}</span></div>
              </div>
              <div class="card">
                <div class="card-label">策略（policy）</div>
                <div class="card-value">${data.policy ?? "-"}</div>
              </div>
              <div class="card">
                <div class="card-label">generation</div>
                <div class="card-value mono">${data.generation ?? "-"}</div>
              </div>
              <div class="card">
                <div class="card-label">owner 数</div>
                <div class="card-value mono">${owners.length}</div>
              </div>
              <div class="card">
                <div class="card-label">在线 endpoint</div>
                <div class="card-value mono">${active.length}（连接 ${totalConns}）</div>
              </div>
              <div class="card">
                <div class="card-label">每 owner 连接上限</div>
                <div class="card-value mono">${data.max_connections_per_owner ?? "-"}</div>
              </div>
              <div class="card">
                <div class="card-label">缓存条目</div>
                <div class="card-value mono">${data.cache_entries ?? "-"}</div>
              </div>
            </div>
          `}
    </section>
  `;
}

// ---- #/owners 注册表 -----------------------------------------------------------

/**
 * @param {{ state: object | null, data: object | null, error: object | null,
 *   form: {fabricId: string, root: string}, formError: string | null, busy: boolean,
 *   receipt: object | null, confirm: {fabricId: string, root: string} | null,
 *   onInput: (name: string, value: string) => void, onRegister: () => void,
 *   onAskUnregister: (owner: object) => void, onConfirmUnregister: () => void,
 *   onCancelConfirm: () => void, onCopy: (receipt: object) => void, onRetry: () => void }} props
 */
export function OwnersView(props) {
  const { state, data, error, form, formError, busy, receipt, confirm } = props;
  const { onInput, onRegister, onAskUnregister, onConfirmUnregister, onCancelConfirm, onCopy, onRetry } = props;
  if (state !== null && state.phase !== "ready") return html`<${SetupGate}/>`;
  const owners = Array.isArray(data?.owners) ? data.owners : [];
  const fabricOk = validateHex64(form.fabricId) !== null || form.fabricId === "";
  const rootOk = validateHex64(form.root) !== null || form.root === "";
  return html`
    <section class="view" data-view="owners">
      <h2>Owners 注册表 <span class="sub">generation ${data?.generation ?? "-"}</span></h2>
      ${state?.insecure === true ? html`<${InsecureBanner}/>` : null}
      ${error !== null && error !== undefined ? html`<${ErrorBanner} error=${error} onRetry=${onRetry}/>` : null}
      <table>
        <thead>
          <tr><th>fabric_id</th><th>root</th><th>注册时间</th><th></th></tr>
        </thead>
        <tbody>
          ${owners.length === 0
            ? html`<tr><td colspan="4" class="empty">（空）</td></tr>`
            : owners.map(
                (o) => html`
                  <tr key=${o.fabric_id + o.root}>
                    <td class="mono" title=${o.fabric_id}>${shortHex(o.fabric_id)}</td>
                    <td class="mono" title=${o.root}>${shortHex(o.root)}</td>
                    <td>${typeof o.registered_at === "number" ? new Date(o.registered_at).toISOString() : "-"}</td>
                    <td class="actions">
                      <button
                        class="danger ghost small"
                        onClick=${() => onAskUnregister(o)}
                      >注销</button>
                    </td>
                  </tr>
                `,
              )}
        </tbody>
      </table>
      <form class="stack" onSubmit=${(e) => { e.preventDefault(); onRegister(); }}>
        <h3>注册 Owner</h3>
        <label>
          fabric_id（64 hex）
          <input
            name="fabricId"
            class=${fabricOk ? "" : "invalid"}
            value=${form.fabricId}
            onInput=${(e) => onInput("fabricId", e.currentTarget.value)}
            autocomplete="off" spellcheck="false" placeholder="64 位十六进制字符"
          />
        </label>
        <label>
          root（64 hex）
          <input
            name="root"
            class=${rootOk ? "" : "invalid"}
            value=${form.root}
            onInput=${(e) => onInput("root", e.currentTarget.value)}
            autocomplete="off" spellcheck="false" placeholder="64 位十六进制字符"
          />
        </label>
        ${formError !== null ? html`<p class="field-error" role="alert">${formError}</p>` : null}
        <button
          type="submit"
          disabled=${busy || form.fabricId === "" || form.root === "" || !fabricOk || !rootOk}
        >${busy ? "提交中…" : "注册"}</button>
      </form>
      ${receipt !== null
        ? html`
            <div class="receipt-area">
              <h3>变更回执</h3>
              <${ReceiptCard} receipt=${receipt} onCopy=${onCopy}/>
            </div>
          `
        : null}
      ${confirm !== null
        ? html`
            <${Dialog}
              title="确认注销 Owner？"
              confirmLabel="确认注销"
              danger=${true}
              onCancel=${onCancelConfirm}
              onConfirm=${onConfirmUnregister}
            >
              <p>将注销以下 (fabric_id, root) 二元组，其存量连接将被断开：</p>
              <p class="mono">fabric ${shortHex(confirm.fabricId)} / root ${shortHex(confirm.root)}</p>
            <//>
          `
        : null}
    </section>
  `;
}

// ---- #/connections 在线连接 -----------------------------------------------------

/** 断连结果状态徽章文案（「已下发/收敛中」两态 + 观测终态）。 */
const DISCONNECT_PHASE_LABEL = {
  dispatched: "已下发",
  converging: "收敛中",
  converged: "已收敛",
  unconfirmed: "超时未确认",
};

/**
 * @param {{ state: object | null, data: object | null, error: object | null,
 *   confirm: {kind: "endpoint" | "fabric", id: string, count: number} | null,
 *   disconnect: {kind: "endpoint" | "fabric", id: string, phase: string, receipts: object[], error: object | null} | null,
 *   onAskDisconnect: (kind: string, id: string, count: number) => void,
 *   onConfirmDisconnect: () => void, onCancelConfirm: () => void,
 *   onCopy: (receipt: object) => void, onRetry: () => void }} props
 */
export function ConnectionsView(props) {
  const { state, data, error, confirm, disconnect } = props;
  const { onAskDisconnect, onConfirmDisconnect, onCancelConfirm, onCopy, onRetry } = props;
  if (state !== null && state.phase !== "ready") return html`<${SetupGate}/>`;
  const perEndpoint = Array.isArray(data?.per_endpoint) ? data.per_endpoint : [];
  const perOwner = Array.isArray(data?.per_owner) ? data.per_owner : [];
  const quota = data?.quota ?? {};
  const max = quota.configured === true ? (quota.max_connections_per_owner ?? "-") : "未配置";
  return html`
    <section class="view" data-view="connections">
      <h2>在线连接</h2>
      ${state?.insecure === true ? html`<${InsecureBanner}/>` : null}
      ${error !== null && error !== undefined ? html`<${ErrorBanner} error=${error} onRetry=${onRetry}/>` : null}
      ${disconnect !== null
        ? html`
            <div class="disconnect-panel">
              <span class="badge phase-${disconnect.phase}">
                ${DISCONNECT_PHASE_LABEL[disconnect.phase] ?? disconnect.phase}
              </span>
              <span class="mono">${shortHex(disconnect.id)}</span>
              （按 ${disconnect.kind === "endpoint" ? "endpoint" : "fabric"} 断开）
              ${disconnect.error !== null && disconnect.error !== undefined
                ? html`<${ErrorBanner} error=${disconnect.error}/>`
                : null}
              ${disconnect.phase === "converging"
                ? html`<span class="hint">断开为 best-effort——正在以有界轮询观测在线表收敛…</span>`
                : null}
              ${Array.isArray(disconnect.receipts) && disconnect.receipts.length > 0
                ? html`
                    <div class="receipt-area">
                      <h3>per-target 回执</h3>
                      ${disconnect.receipts.map((r, i) => html`<${ReceiptCard} key=${i} receipt=${r} onCopy=${onCopy}/>`)}
                    </div>
                  `
                : null}
            </div>
          `
        : null}
      ${data === null
        ? html`<p class="loading">加载中…</p>`
        : html`
            <p class="hint">
              mode <span class="badge">${data.mode ?? "-"}</span>
              · relay ${data.relay_enabled === true ? "已启用" : "未启用"}
              · 配额（每 owner 在用 / 上限）：<span class="mono">${max}</span>
            </p>
            <h3>按 endpoint</h3>
            <table>
              <thead><tr><th>endpoint_id</th><th>fabric_id</th><th>连接数</th><th></th></tr></thead>
              <tbody>
                ${perEndpoint.length === 0
                  ? html`<tr><td colspan="4" class="empty">（无在线连接）</td></tr>`
                  : perEndpoint.map(
                      (e) => html`
                        <tr key=${e.endpoint_id + e.fabric_id}>
                          <td class="mono" title=${e.endpoint_id}>${shortHex(e.endpoint_id)}</td>
                          <td class="mono" title=${e.fabric_id}>${shortHex(e.fabric_id)}</td>
                          <td class="mono">${e.connections}</td>
                          <td class="actions">
                            <button
                              class="danger ghost small"
                              onClick=${() => onAskDisconnect("endpoint", e.endpoint_id, e.connections)}
                            >断连</button>
                          </td>
                        </tr>
                      `,
                    )}
              </tbody>
            </table>
            <h3>按 owner</h3>
            <table>
              <thead><tr><th>fabric_id</th><th>在用 / 上限</th><th></th></tr></thead>
              <tbody>
                ${perOwner.length === 0
                  ? html`<tr><td colspan="3" class="empty">（无在线 owner）</td></tr>`
                  : perOwner.map(
                      (o) => html`
                        <tr key=${o.fabric_id}>
                          <td class="mono" title=${o.fabric_id}>${shortHex(o.fabric_id)}</td>
                          <td class="mono">${o.connections} / ${max}</td>
                          <td class="actions">
                            <button
                              class="danger ghost small"
                              onClick=${() => onAskDisconnect("fabric", o.fabric_id, o.connections)}
                            >断连全部</button>
                          </td>
                        </tr>
                      `,
                    )}
              </tbody>
            </table>
          `}
      ${confirm !== null
        ? html`
            <${Dialog}
              title="确认断开连接？"
              confirmLabel="确认断连"
              danger=${true}
              onCancel=${onCancelConfirm}
              onConfirm=${onConfirmDisconnect}
            >
              <p>将向目标服务器下发断开指令（best-effort，异步收敛）：</p>
              <p>
                ${confirm.kind === "endpoint" ? "endpoint" : "owner fabric"}
                <span class="mono">${shortHex(confirm.id)}</span>
                · 当前连接数 <span class="mono">${confirm.count}</span>
              </p>
            <//>
          `
        : null}
    </section>
  `;
}
