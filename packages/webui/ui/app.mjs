// 应用层（webui-console UI 层重做 / PRODUCT-DESIGN §3-§4）：副作用编排。
// 意图（2026-09-22 UI 重做）：
// 1. 两个世界（§3.1 裁决 1）：phase=setup 一律全屏引导（任何 hash 都落引导，
//    业务视图不挂载、不发业务请求）；phase=ready 才进入管理驾驶舱（左导航
//    总览/访问管理）。旧 hash（#/connect #/status #/owners #/connections）在
//    ready 态自动收敛到正确去处（#/connect → 总览 + 连接详情面板）；
// 2. 常驻健康轮询（§4.2/§4.3 C-1）：ready 态无论当前在哪页，/api/status 与
//    /api/connections 均按 5s 轮询（页面隐藏暂停、回前台即刷）——顶栏健康灯
//    5 秒内反映失败，切页不消失；动作级错误留在动作上下文；
// 3. 断连闭环（§4.3 C-2）：确认（知情前置）→ 已下发/收敛中（1s×15 有界观测）
//    → 已收敛/超时未确认，全程同视图；per-target 回执就地展示；
// 4. 安全契约（冻结）：token 提交后即清空、绝不回显（失败也只保留地址与
//    配对码）；目标掩码呈现；剪贴板复制静默降级。
// 纯渲染在 views.mjs（可注入失败态矩阵的测试面不 import 本文件——本文件
// 持有 DOM/定时器副作用；routeFor 为纯函数单独导出供测试）。
import { useCallback, useEffect, useState } from "preact/hooks";
import { html } from "./html.mjs";
import {
  AccessView,
  ConnectionPanel,
  ErrorBanner,
  HealthLight,
  InsecureStrip,
  OverviewView,
  SetupWizard,
  Skeleton,
  TargetChip,
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
const PAIRED_TRANSITION_MS = 900; // 成功确认幕短暂呈现后进入 ready 世界

/**
 * hash → 路由（纯函数）：两个世界 + 旧 hash 收敛。
 * setup 态任何 hash 都落引导；ready 态 #/|#/status→总览、#/connect→总览并
 * 呼出连接详情、#/owners|#/access→访问管理·名册、#/connections→访问管理·在线。
 * @returns {{view: "setup"} | {view: "overview", panel?: boolean} |
 *   {view: "access", section: "roster" | "online"}}
 */
export function routeFor(hash, phase) {
  if (phase !== "ready") return { view: "setup" };
  const h = String(hash ?? "").replace(/^#\/?/, "");
  const [head, second] = h.split("/");
  switch (head) {
    case "":
    case "status":
      return { view: "overview" };
    case "connect":
      return { view: "overview", panel: true };
    case "owners":
    case "access":
      return { view: "access", section: second === "online" ? "online" : "roster" };
    case "connections":
      return { view: "access", section: "online" };
    default:
      return { view: "overview" };
  }
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
  const [statusLastFailAt, setStatusLastFailAt] = useState(null);

  const [connData, setConnData] = useState(null);
  // 名册行「在用」状态源：per_owner（有活跃连接的所有者集合；快照快）
  const onlineFabricSet = new Set(
    Array.isArray(connData?.per_owner)
      ? connData.per_owner.map((o) => o.fabric_id)
      : [],
  );
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

  const [detailsOpen, setDetailsOpen] = useState(false); // 顶栏连接详情面板
  const [onlineFilter, setOnlineFilter] = useState(null); // 名册 ⇄ 在线互链过滤

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

  // 旧路由 #/connect 在 ready 态收敛为「总览 + 连接详情面板」（§3.1 裁决 1）。
  useEffect(() => {
    if (route.panel === true && phase === "ready") setDetailsOpen(true);
  }, [route.panel, phase]);

  // ---- ready 态常驻轮询（健康灯真源；5s；页面隐藏暂停，回前台立即刷一次） ----

  const refreshStatus = useCallback(async () => {
    try {
      setStatusData(await loadStatus());
      setStatusError(null);
    } catch (e) {
      setStatusError(e);
      setStatusLastFailAt(Date.now());
    }
  }, []);

  useEffect(() => {
    if (phase !== "ready") return;
    let stopped = false;
    const tick = () => {
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
  }, [phase, refreshStatus]);

  // 在线连接：同样常驻轮询（总览的 relay 投影 + 在线视角明细共用一份数据）。
  const refreshConnections = useCallback(async () => {
    try {
      setConnData(await loadConnections());
      setConnError(null);
    } catch (e) {
      setConnError(e);
    }
  }, []);

  useEffect(() => {
    if (phase !== "ready") return;
    let stopped = false;
    const tick = () => {
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
  }, [phase, refreshConnections]);

  // 名册：进入名册视角或动作后拉取（名册只被本控制台的注册/注销改变）。
  const refreshOwners = useCallback(async () => {
    try {
      setOwnersData(await loadOwners());
      setOwnersError(null);
    } catch (e) {
      setOwnersError(e);
    }
  }, []);
  useEffect(() => {
    // 总览也需要名册计数（「所有者」统计卡真源；vision 终判：懒加载只挂
    // 名册页会让总览永远停在「…」占位）——ready 态两处都拉，共享同一 state
    if (phase === "ready" && (route.view === "overview" || (route.view === "access" && route.section === "roster"))) {
      refreshOwners();
    }
  }, [phase, route.view, route.section, refreshOwners]);

  // ---- setup 世界：配对引导 ----

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
      // token 与配对码即刻清空、不回显（spec：提交后输入框清空且不回显）
      setForm((f) => ({ ...f, token: "", code: "" }));
      setConnectResult({ ok: true });
      // 立即取回掩码目标（确认幕呈现用）；世界翻转由确认幕接管，不闪跳
      await refreshState();
      setTimeout(() => {
        location.hash = "#/";
        setConnectResult(null); // 确认幕退场 → ready 世界
      }, PAIRED_TRANSITION_MS);
    } catch (e) {
      // 失败：就地呈现，表单保留已填内容——但凭证框除外（不回显）
      setForm((f) => ({ ...f, token: "" }));
      setConnectResult({ ok: false, error: e });
    } finally {
      setConnectBusy(false);
    }
  }, [form, refreshState]);

  /** 成功确认幕退场：进入 ready 世界（hash 落总览）。 */
  const leaveSetupOnSuccess = useCallback(() => {
    location.hash = "#/";
    setConnectResult(null);
  }, []);

  // ---- 名册：注册 / 注销 ----

  const onOwnerInput = useCallback((name, value) => {
    setOwnerForm((f) => ({ ...f, [name]: value }));
  }, []);

  const submitRegister = useCallback(async () => {
    const fabricId = validateHex64(ownerForm.fabricId);
    const root = validateHex64(ownerForm.root);
    if (fabricId === null || root === null) {
      setOwnerFormError(
        "Fabric 与根端点均需为 64 位十六进制字符（0-9 / a-f）。通常从成员的密钥管理处复制，不要手抄。",
      );
      return;
    }
    setOwnerFormError(null);
    setOwnerBusy(true);
    try {
      setReceipt(await registerOwner(fabricId, root));
      setOwnerForm({ fabricId: "", root: "" });
      await Promise.all([refreshOwners(), refreshStatus()]); // 名册版本/所有者数即时反映
    } catch (e) {
      setOwnersError(e);
    } finally {
      setOwnerBusy(false);
    }
  }, [ownerForm, refreshOwners, refreshStatus]);

  const confirmUnregister = useCallback(async () => {
    const { fabricId, root } = ownerConfirm ?? {};
    setOwnerConfirm(null);
    if (fabricId === undefined) return;
    setOwnerBusy(true);
    try {
      setReceipt(await unregisterOwner(fabricId, root));
      // 名册版本/所有者数 + 在线表（名下连接被一并断开）都要反映
      await Promise.all([refreshOwners(), refreshStatus(), refreshConnections()]);
    } catch (e) {
      setOwnersError(e);
    } finally {
      setOwnerBusy(false);
    }
  }, [ownerConfirm, refreshOwners, refreshStatus, refreshConnections]);

  // ---- 断连（知情前置确认 → 已下发/收敛中 → 有界轮询观测收敛，同视图闭环） ----

  const confirmDisconnect = useCallback(async () => {
    const { kind, id } = connConfirm ?? {};
    setConnConfirm(null);
    if (id === undefined) return;
    setDisconnect({ kind, id, phase: "dispatched", receipts: [], error: null });
    try {
      const res = kind === "endpoint" ? await disconnectByEndpoint(id) : await disconnectByFabric(id);
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
      // no-match：目标已自行离线——刷新在线表供核对（§4.3 C-2 步 5）
      if (e?.code === "no-match") refreshConnections();
      setDisconnect((d) => (d === null ? d : { ...d, error: e }));
    }
  }, [connConfirm, refreshConnections]);

  // ---- 剪贴板（回执全文 / hex 全文共用；无权限或非安全上下文静默降级） ----

  const copyText = useCallback(async (text) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // 无剪贴板权限/非安全上下文：静默降级（摘要与缩写值已可见）
    }
  }, []);
  const copyReceipt = useCallback((r) => copyText(JSON.stringify(r, null, 2)), [copyText]);

  // ---- 导航辅助（互链/下钻/视角切换） ----

  const goOnline = useCallback((fabricId = null) => {
    setOnlineFilter(fabricId);
    location.hash = "#/access/online";
  }, []);
  const changeSection = useCallback((s) => {
    if (s !== "online") setOnlineFilter(null); // 分段切换不带旧过滤；互链才带
    location.hash = s === "online" ? "#/access/online" : "#/access/roster";
  }, []);
  const goRegister = useCallback(() => {
    location.hash = "#/access/roster";
    setTimeout(() => document.getElementById("owner-fabric-input")?.focus(), 60);
  }, []);

  // ---- 壳：启动失败面 / setup 世界 / ready 世界 ----

  if (state === null && stateError !== null) {
    return html`
      <div class="boot-screen">
        <div class="boot-card">
          <h1>控制台后台没有响应</h1>
          <p>
            本地 sidecar 进程可能已退出。请回到终端查看输出，或重新运行启动命令打开新页面。
          </p>
          <button onClick=${refreshState}>重试</button>
        </div>
      </div>
    `;
  }
  if (state === null) {
    return html`
      <div class="boot-screen">
        <div class="boot-card">
          <h1>正在连接服务器…</h1>
          <${Skeleton} lines=${3}/>
        </div>
      </div>
    `;
  }

  // setup 世界（或配对成功的短暂确认幕——期间 phase 已翻 ready，由 connectResult
  // 接管呈现，不闪跳进驾驶舱）。
  if (phase === "setup" || connectResult?.ok === true) {
    return html`
      <${SetupWizard}
        state=${state}
        form=${form}
        busy=${connectBusy}
        result=${connectResult}
        onInput=${onConnectInput}
        onSubmit=${submitConnect}
        onGoOverview=${leaveSetupOnSuccess}
      />
    `;
  }

  // ready 世界（管理驾驶舱）：顶栏（品牌 · 健康灯 · 目标）+ 左导航 + 内容区。
  // 未来 owner-console 的导航槽位在此预留（§8.1 拍板：为扩展留槽，当前不渲染）。
  const overviewData =
    statusData === null
      ? null
      : { ...statusData, relay_enabled: connData?.relay_enabled };
  const overviewError = statusError ?? connError;

  return html`
    <div class="shell" data-phase="ready">
      <header class="topbar">
        <span class="brand">opendweb<span class="brand-sub">服务器控制台</span></span>
        <${HealthLight}
          error=${statusError}
          loading=${statusData === null && statusError === null}
        />
        <span class="topbar-spacer"></span>
        <${TargetChip}
          masked=${state.server_host_masked}
          open=${detailsOpen}
          onToggle=${() => setDetailsOpen((v) => !v)}
        />
        ${detailsOpen
          ? html`<${ConnectionPanel} state=${state} onClose=${() => setDetailsOpen(false)}/>`
          : null}
      </header>
      ${state.insecure === true ? html`<${InsecureStrip}/>` : null}
      <div class="layout">
        <aside class="sidenav">
          <a class=${route.view === "overview" ? "active" : ""} href="#/">总览</a>
          <a class=${route.view === "access" ? "active" : ""} href="#/access">访问管理</a>
        </aside>
        <main class="content">
          ${route.view === "overview"
            ? html`
                <${OverviewView}
                  state=${state}
                  data=${overviewData}
                  error=${overviewError}
                  ownersData=${ownersData}
                  ownersError=${ownersError}
                  lastFailAt=${statusLastFailAt}
                  onRetry=${refreshStatus}
                  onGoOnline=${() => goOnline(null)}
                  onGoRegister=${goRegister}
                />
              `
            : html`
                <${AccessView}
                  state=${state}
                  section=${route.section}
                  onlineFabrics=${onlineFabricSet}
                  data=${ownersData}
                  error=${ownersError}
                  form=${ownerForm}
                  formError=${ownerFormError}
                  busy=${ownerBusy}
                  receipt=${receipt}
                  confirm=${ownerConfirm}
                  onInput=${onOwnerInput}
                  onRegister=${submitRegister}
                  onFocusRegister=${goRegister}
                  onAskUnregister=${setOwnerConfirm}
                  onConfirmUnregister=${confirmUnregister}
                  onCancelOwnerConfirm=${() => setOwnerConfirm(null)}
                  onCopy=${copyReceipt}
                  onCopyText=${copyText}
                  onFilterOnline=${goOnline}
                  onRetry=${refreshOwners}
                  onSection=${changeSection}
                  connData=${connData}
                  connError=${connError}
                  connConfirm=${connConfirm}
                  disconnect=${disconnect}
                  filter=${onlineFilter}
                  onAskDisconnect=${(kind, id, count) => setConnConfirm({ kind, id, count })}
                  onConfirmDisconnect=${confirmDisconnect}
                  onCancelConnConfirm=${() => setConnConfirm(null)}
                  onRetryConnections=${refreshConnections}
                  onClearFilter=${() => setOnlineFilter(null)}
                  onDismissDisconnect=${() => setDisconnect(null)}
                />
              `}
        </main>
      </div>
    </div>
  `;
}
