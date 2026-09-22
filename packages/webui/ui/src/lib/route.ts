// hash → 路由（server-access-roles specs/webui「三角色管理台信息架构」冻结契约）。
// 四页：#/overview（总览）/ #/tenants（租户管理，邀请码为子区块）/
// #/visitors（访客与门禁）/ #/online（在线连接）。
// 旧路由 MUST 301 式收敛（应用内重定向，不 404）：#/owners→#/tenants、
// #/access→#/visitors、#/online→#/online、#/overview→#/overview、其余未知
// hash→#/overview。setup 态任何 hash 都落引导（v1 基座不变）。

export type Route =
  | { view: "setup" }
  | { view: "overview" }
  | { view: "tenants" }
  | { view: "visitors" }
  | { view: "online" };

/** 冻结的收敛映射：hash 首段 → 规范 hash（含全部 v1 旧路由）。 */
const CONVERGE: Record<string, string> = {
  "": "#/overview",
  overview: "#/overview",
  status: "#/overview", // v1 状态页 → 总览
  connect: "#/overview", // v1 配对页 → 总览（节点簿面板仍可从顶栏呼出）
  owners: "#/tenants",
  tenants: "#/tenants",
  access: "#/visitors",
  visitors: "#/visitors",
  online: "#/online",
  connections: "#/online", // v1 连接页 → 在线
};

function canonicalFor(hash: string | null | undefined): string {
  const h = String(hash ?? "").replace(/^#\/?/, "");
  const [head, second] = h.split("/");
  // v1 深链细分：#/access/online 的「在线」意图保留（父段 access 仍收敛门禁页）
  if (head === "access" && second === "online") return "#/online";
  if (head in CONVERGE) return CONVERGE[head];
  return "#/overview"; // 未知 hash → 总览（不 404）
}

/**
 * hash 是否为规范形态（四页原样）。
 * @returns 规范 hash（非规范/未知输入时给出收敛目标）；已是规范则返回 null。
 */
export function canonicalHashFor(hash: string | null | undefined): string | null {
  const canonical = canonicalFor(hash);
  return String(hash ?? "") === canonical ? null : canonical;
}

/** 规范 hash（#/overview|#/tenants|#/visitors|#/online）→ 视图。 */
export function routeFor(hash: string | null | undefined, phase: string): Route {
  if (phase !== "ready") return { view: "setup" };
  const view = canonicalFor(hash).slice(2);
  return { view: view as "overview" | "tenants" | "visitors" | "online" };
}
