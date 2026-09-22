// 应用层（webui-console A.7 / design §4）：副作用编排——hash 路由、/sidecar/state
// 启动判定、ready 态 5s 轮询（document.visibilityState 隐藏暂停）、配对/注册/
// 注销/断连动作与断连收敛的有界轮询。纯渲染在 views.mjs（可注入失败态矩阵的
// 测试面不 import 本文件——本文件持有 DOM/定时器副作用）。
import { useCallback, useEffect, useState } from "preact/hooks";
import { html } from "./html.mjs";
import {
  ConnectionsView,
  ConnectView,
  ErrorBanner,
  InsecureBanner,
  OwnersView,
  StatusView,
  validateHex64,
} from "./views.mjs";
import {
  disconnectByEndpoint,
  disconnectByFabric,
  fetchSidecarState,
  loadConnections,
  loadOwners,
  loadStatus,
  postConnect,
  registerOwner,
  unregisterOwner,
} from "./api.mjs";

const POLL_MS = 5_000;
const CONVERGE_POLL_MS = 1_000;
const CONVERGE_MAX_POLLS = 15; // 断连收敛观测上界 ~15s（design §4 有界轮询）

const ROUTES = ["connect", "status", "owners", "connections"];

/**
 * hash → 视图名（纯函数）：未知 hash 按 phase 收敛到默认页
 * （setup → #/connect 配对面；ready → #/status）。
 */
export function routeFor(hash, phase) {
  const h = String(hash ?? "").replace(/^#\/?/, "");
  return ROUTES.includes(h) ? h : phase === "ready" ? "status" : "connect";
}

const visible = () => document.visibilityState === "visible";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 在线表快照里目标是否仍在（断连收敛观测）。 */
function snapshotHasTarget(data, kind, id) {
  const rows = Array.isArray(data?.per_endpoint) ? data.per_endpoint : [];
  return rows.some((e) => (kind === "endpoint" ? e.endpoint_id === id : e.fabric_id === id));
}

export function App() {
  const [hash, setHash] = useState(() => location.hash);
  const [state, setState] = useState(null); // /sidecar/state（null = 启动加载中）
  const [stateError, setStateError] = useState(null);

  const [form, setForm] = useState({ server: "", token: "", code: "" });
  const [connectBusy, setConnectBusy] = useState(false);
  const [connectResult, setConnectResult] = useState(null);

  const [statusData, setStatusData] = useState(null);
  const [statusError, setStatusError] = useState(null);
  const [connData, setConnData] = useState(null);
  const [connError, setConnError] = useState(null);

  const [ownersData, setOwnersData] = useState(null);
  const [ownersError, setOwnersError] = useState(null);
  const [ownerForm, setOwnerForm] = useState({ fabricId: "", root: "" });
  const [ownerFormError, setOwnerFormError] = useState(null);
  const [ownerBusy, setOwnerBusy] = useState(false);
  const [receipt, setReceipt] = useState(null);
  const [ownerConfirm, setOwnerConfirm] = useState(null);

  const [connConfirm, setConnConfirm] = useState(null);
  const [disconnect, setDisconnect] = useState(null);

  const phase = state !== null && state.phase === "ready" ? "ready" : "setup";
  const route = routeFor(hash, phase);

  // ---- 路由与启动状态 ----

  useEffect(() => {
    const onHash = () => setHash(location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const refreshState = useCallback(async () => {
    try {
      setState(await fetchSidecarState());
      setStateError(null);
    } catch (e) {
      setStateError(e);
    }
  }, []);
  useEffect(() => {
    refreshState();
  }, [refreshState]);

  // ---- ready 态轮询（5s；页面隐藏暂停，回到前台立即刷一次） ----

  const refreshStatus = useCallback(async () => {
    try {
      setStatusData(await loadStatus());
      setStatusError(null);
    } catch (e) {
      setStatusError(e);
    }
  }, []);

  useEffect(() => {
    if (route !== "status" || phase !== "ready") return;
    let stopped = false;
    const tick = async () => {
      if (stopped || !visible()) return;
      refreshStatus();
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    const onVis = () => {
      if (visible()) tick();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stopped = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [route, phase, refreshStatus]);

  const refreshConnections = useCallback(async () => {
    try {
      setConnData(await loadConnections());
      setConnError(null);
    } catch (e) {
      setConnError(e);
    }
  }, []);

  useEffect(() => {
    if (route !== "connections" || phase !== "ready") return;
    let stopped = false;
    const tick = async () => {
      if (stopped || !visible()) return;
      refreshConnections();
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    const onVis = () => {
      if (visible()) tick();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stopped = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [route, phase, refreshConnections]);

  const refreshOwners = useCallback(async () => {
    try {
      setOwnersData(await loadOwners());
      setOwnersError(null);
    } catch (e) {
      setOwnersError(e);
    }
  }, []);
  useEffect(() => {
    if (route === "owners" && phase === "ready") refreshOwners();
  }, [route, phase, refreshOwners]);

  // ---- 配对面 ----

  const onConnectInput = useCallback((name, value) => {
    setForm((f) => ({ ...f, [name]: value }));
  }, []);

  const submitConnect = useCallback(async () => {
    setConnectBusy(true);
    setConnectResult(null);
    try {
      await postConnect({
        pairing_code: form.code.trim(),
        server: form.server.trim(),
        token: form.token,
      });
      // token 即刻清空、不回显（spec：配对成功后输入框清空且不回显）
      setForm((f) => ({ ...f, token: "", code: "" }));
      setConnectResult({ ok: true });
      await refreshState();
      location.hash = "#/status";
    } catch (e) {
      setConnectResult({ ok: false, error: e });
    } finally {
      setConnectBusy(false);
    }
  }, [form, refreshState]);

  // ---- owners 注册/注销 ----

  const onOwnerInput = useCallback((name, value) => {
    setOwnerForm((f) => ({ ...f, [name]: value }));
  }, []);

  const submitRegister = useCallback(async () => {
    const fabricId = validateHex64(ownerForm.fabricId);
    const root = validateHex64(ownerForm.root);
    if (fabricId === null || root === null) {
      setOwnerFormError("fabric_id 与 root 均须为 64 位十六进制字符（0-9 / a-f）");
      return;
    }
    setOwnerFormError(null);
    setOwnerBusy(true);
    try {
      setReceipt(await registerOwner(fabricId, root));
      setOwnerForm({ fabricId: "", root: "" });
      await refreshOwners();
    } catch (e) {
      setOwnersError(e);
    } finally {
      setOwnerBusy(false);
    }
  }, [ownerForm, refreshOwners]);

  const confirmUnregister = useCallback(async () => {
    const { fabricId, root } = ownerConfirm ?? {};
    setOwnerConfirm(null);
    if (fabricId === undefined) return;
    setOwnerBusy(true);
    try {
      setReceipt(await unregisterOwner(fabricId, root));
      await refreshOwners();
    } catch (e) {
      setOwnersError(e);
    } finally {
      setOwnerBusy(false);
    }
  }, [ownerConfirm, refreshOwners]);

  // ---- 断连（二次确认 → 已下发/收敛中 → 有界轮询观测收敛） ----

  const confirmDisconnect = useCallback(async () => {
    const { kind, id } = connConfirm ?? {};
    setConnConfirm(null);
    if (id === undefined) return;
    setDisconnect({ kind, id, phase: "dispatched", receipts: [], error: null });
    try {
      const res =
        kind === "endpoint" ? await disconnectByEndpoint(id) : await disconnectByFabric(id);
      setDisconnect({ kind, id, phase: "converging", receipts: res?.receipts ?? [], error: null });
      let converged = false;
      for (let i = 0; i < CONVERGE_MAX_POLLS; i++) {
        await delay(CONVERGE_POLL_MS);
        let snap;
        try {
          snap = await loadConnections();
          setConnData(snap);
          setConnError(null);
        } catch {
          continue; // 观测期瞬时失败不终止轮询
        }
        if (!snapshotHasTarget(snap, kind, id)) {
          converged = true;
          break;
        }
      }
      const finalPhase = converged ? "converged" : "unconfirmed";
      setDisconnect((d) => (d === null ? d : { ...d, phase: finalPhase }));
    } catch (e) {
      setDisconnect((d) => (d === null ? d : { ...d, error: e }));
    }
  }, [connConfirm]);

  // ---- 回执复制（剪贴板降级静默） ----

  const copyReceipt = useCallback(async (r) => {
    const text = JSON.stringify(r, null, 2);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // 无剪贴板权限/非安全上下文：静默降级（回执摘要已可见）
    }
  }, []);

  // ---- 壳 ----

  if (state === null && stateError !== null) {
    return html`
      <div class="boot-error">
        <${ErrorBanner} error=${stateError} onRetry=${refreshState}/>
        <p class="hint">无法取得 sidecar 状态——请确认 sidecar 进程仍在运行，或从终端重新打开其 URL。</p>
      </div>
    `;
  }
  if (state === null) {
    return html`<div class="boot-loading">加载中…</div>`;
  }

  return html`
    <div class="shell">
      <header class="topbar">
        <span class="brand">opendweb 管理控制台</span>
        <span class="phase ${phase === "ready" ? "ok" : ""}">
          ${phase === "ready" ? html`已连接 <span class="mono">${state.server_host_masked}</span>` : "未连接"}
        </span>
        <nav>
          <a class=${route === "connect" ? "active" : ""} href="#/connect">配对</a>
          <a class=${route === "status" ? "active" : ""} href="#/status">状态</a>
          <a class=${route === "owners" ? "active" : ""} href="#/owners">Owners</a>
          <a class=${route === "connections" ? "active" : ""} href="#/connections">在线连接</a>
        </nav>
      </header>
      ${state.insecure === true ? html`<${InsecureBanner}/>` : null}
      <main>
        ${route === "connect"
          ? html`
              <${ConnectView}
                state=${state}
                form=${form}
                busy=${connectBusy}
                result=${connectResult}
                onInput=${onConnectInput}
                onSubmit=${submitConnect}
                onGoStatus=${() => {
                  location.hash = "#/status";
                }}
              />
            `
          : route === "status"
            ? html`
                <${StatusView}
                  state=${state}
                  data=${statusData}
                  error=${statusError}
                  onRetry=${refreshStatus}
                />
              `
            : route === "owners"
              ? html`
                  <${OwnersView}
                    state=${state}
                    data=${ownersData}
                    error=${ownersError}
                    form=${ownerForm}
                    formError=${ownerFormError}
                    busy=${ownerBusy}
                    receipt=${receipt}
                    confirm=${ownerConfirm}
                    onInput=${onOwnerInput}
                    onRegister=${submitRegister}
                    onAskUnregister=${setOwnerConfirm}
                    onConfirmUnregister=${confirmUnregister}
                    onCancelConfirm=${() => setOwnerConfirm(null)}
                    onCopy=${copyReceipt}
                    onRetry=${refreshOwners}
                  />
                `
              : html`
                  <${ConnectionsView}
                    state=${state}
                    data=${connData}
                    error=${connError}
                    confirm=${connConfirm}
                    disconnect=${disconnect}
                    onAskDisconnect=${(kind, id, count) => setConnConfirm({ kind, id, count })}
                    onConfirmDisconnect=${confirmDisconnect}
                    onCancelConfirm=${() => setConnConfirm(null)}
                    onCopy=${copyReceipt}
                    onRetry=${refreshConnections}
                  />
                `}
      </main>
    </div>
  `;
}
