// hash → 路由（纯函数，自 ui/app.mjs routeFor 原样移植）。
// 两个世界 + 旧 hash 收敛（PRODUCT-DESIGN §3.1 裁决 1 / §7.1）：
// setup 态任何 hash 都落引导；ready 态 #/|#/status→总览、#/connect→总览并
// 呼出连接详情、#/owners|#/access→访问管理·名册、#/connections→访问管理·在线。

export type Route =
  | { view: "setup" }
  | { view: "overview"; panel?: boolean }
  | { view: "access"; section: "roster" | "online" };

export function routeFor(hash: string | null | undefined, phase: string): Route {
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
