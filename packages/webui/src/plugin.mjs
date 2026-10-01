// ./opendweb-plugin 清单导出（webui-console design §3——契约不扩展）。
// run envelope 为契约既定的 {command, args, log, cwd, stdout, stderr}；
// URL/port 等语义校验由 cli.mjs 自担。description 尾注承载节点簿例外披露
// （ASCII）——help 渲染器原样呈现，golden fixture 钉住。
// W11（Owner 裁决 2026-10-01）：--token/DWEB_ADMIN_TOKEN argv/env 凭证通道
// 移除——manifest 不再声明 token 参数；server-access-roles 节点簿例外披露
// 保留：节点 token 持久化于 0600 的 <DWEB_HOME>/nodes.json。
// home-hub 2a 分层：envelope 零变化（薄壳经 cli.mjs → src/core/ 运行时）。

const NODES_NOTE =
  "[note: node book entries persist their admin tokens in ~/.opendweb/nodes.json (0600, readable by your OS user only)]";

const manifest = {
  name: "webui",
  apiVersion: 1,
  commands: [
    {
      name: "webui",
      description: `local management console (sidecar + UI) ${NODES_NOTE}`,
      args: {
        type: "object",
        properties: {
          server: { type: "string" },
          port: { type: "number" },
          "allow-insecure": { type: "boolean" },
          "no-open": { type: "boolean" },
          setup: { type: "boolean" },
        },
        required: [],
      },
    },
  ],
  run: async ({ command, args, log, cwd, stdout, stderr }) => {
    const { main } = await import("./cli.mjs");
    return main(args, { log, cwd, stdout, stderr });
  },
};

export default manifest;
